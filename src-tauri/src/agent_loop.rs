use crate::state::AppState;
use crate::strudel;
use robostrudel_agent::ClaudeClient;
use robostrudel_agent::types::*;
use robostrudel_core::traits::CorpusIndex;
use robostrudel_core::types::{ChatMessage, ChatRole, CorpusQuery, MusicalRole, PlaybackState};
use std::sync::LazyLock;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// System prompt loaded from prompts/system.md at runtime or embedded.
static SYSTEM_PROMPT: LazyLock<String> = LazyLock::new(|| {
    let paths = [
        "prompts/system.md",
        "../prompts/system.md",
        "src-tauri/../prompts/system.md",
    ];
    for path in &paths {
        if let Ok(content) = std::fs::read_to_string(path) {
            tracing::info!("loaded system prompt from {path}");
            return content;
        }
    }
    tracing::warn!("using embedded system prompt (file not found)");
    include_str!("../../prompts/system.md").to_string()
});

/// Run the full agent loop: conversation with Claude, tool execution, return final text.
pub async fn run_agent_loop(
    client: &ClaudeClient,
    session_messages: &[ChatMessage],
    state: &AppState,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let mut api_messages = session_to_api_messages(session_messages);
    let tool_defs = robostrudel_agent::tools::music_tool_definitions();

    // Build the system prompt with current editor code injected
    let current_code = {
        let session = state.session.lock().unwrap();
        session.current_pattern.clone()
    };
    let system_prompt = if let Some(code) = &current_code {
        format!(
            "{}\n\n## Current editor code (what the user hears right now)\n\n```\n{}\n```\n\n\
             When the user asks to modify, add to, or expand the song, work from this code. \
             Do not ask them to paste it — you already have it.",
            &*SYSTEM_PROMPT, code
        )
    } else {
        SYSTEM_PROMPT.clone()
    };

    let mut full_text = String::new();
    // Run id groups all tool calls made for this one user message, so the
    // telemetry analyzer can see retries within a single request.
    let run = crate::telemetry::now_millis();
    let telemetry_dir = state.app_data_dir();
    // 20 leaves the agent room to call tools several times (each tool round
    // is one iteration) before the loop forces an answer. 10 was tight
    // enough that complex prompts would get cut mid-thought.
    let max_iterations = 20;

    for iteration in 0..max_iterations {
        debug!("agent loop iteration {iteration}");

        let response = client
            .stream_message(&system_prompt, &api_messages, &tool_defs, &event_tx)
            .await
            .map_err(|e| format!("Claude API error: {e}"))?;

        let mut response_text = String::new();
        let mut tool_calls: Vec<(String, String, serde_json::Value)> = Vec::new();

        for block in &response.content {
            match block {
                ContentBlock::Text { text } => response_text.push_str(text),
                ContentBlock::ToolUse { id, name, input } => {
                    tool_calls.push((id.clone(), name.clone(), input.clone()));
                }
                _ => {}
            }
        }

        full_text.push_str(&response_text);

        if tool_calls.is_empty() {
            break;
        }

        api_messages.push(ApiMessage {
            role: "assistant".to_string(),
            content: response.content.clone(),
        });

        // Did this response get cut off at the token limit mid-tool-call? If
        // so the tool's argument JSON never finished and `input` is an empty
        // `{}`. Executing it just yields "missing 'code' parameter", which the
        // model can't act on — it retries, truncates again, and loops. Detect
        // it here and feed back an honest, actionable error instead.
        let truncated = response.stop_reason.as_deref() == Some("max_tokens")
            || response.incomplete_tool_input;

        let mut tool_results = Vec::new();
        for (id, name, input) in &tool_calls {
            let input_empty = input.as_object().is_none_or(|o| o.is_empty());
            let (content, is_error) = if truncated && input_empty {
                warn!("tool '{name}' arguments truncated at token limit; not executing");
                let msg = format!(
                    "Your previous message hit the {} token output limit before the \
                     arguments to `{name}` finished streaming, so the tool received no \
                     input. Emit a more compact pattern — use `*n` for repeats, `@n` for \
                     holds, and `slowcat`/`<...>` instead of fully expanding every event — \
                     and keep the whole reply shorter so the tool call completes.",
                    client.max_tokens()
                );
                let _ = event_tx.send(AgentEvent::ToolResult {
                    name: name.clone(),
                    result: format!("error: {msg}"),
                });
                (msg, Some(true))
            } else {
                info!("executing tool: {name}");
                match execute_tool(name, input, state, &event_tx).await {
                    Ok(r) => {
                        let _ = event_tx.send(AgentEvent::ToolResult {
                            name: name.clone(),
                            result: r.clone(),
                        });
                        (r, None)
                    }
                    Err(e) => {
                        let _ = event_tx.send(AgentEvent::ToolResult {
                            name: name.clone(),
                            result: format!("error: {e}"),
                        });
                        (e, Some(true))
                    }
                }
            };

            crate::telemetry::record(
                telemetry_dir.as_deref(),
                &crate::telemetry::ToolEvent {
                    ts: crate::telemetry::now_millis(),
                    run,
                    turn: iteration,
                    tool: name.clone(),
                    ok: is_error.is_none(),
                    input: crate::telemetry::truncate(
                        &serde_json::to_string(input).unwrap_or_default(),
                        240,
                    ),
                    result: crate::telemetry::truncate(&content, 200),
                },
            );

            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content,
                is_error,
            });
        }

        api_messages.push(ApiMessage {
            role: "user".to_string(),
            content: tool_results,
        });
    }

    let _ = event_tx.send(AgentEvent::Done {
        full_text: full_text.clone(),
    });

    Ok(full_text)
}

/// Execute a tool by name.
async fn execute_tool(
    name: &str,
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    match name {
        "search_corpus" => tool_search_corpus(input, state),
        "get_example" => tool_get_example(input, state),
        "list_sounds" => tool_list_sounds(state),
        "generate_pattern" => tool_generate_pattern(input),
        "validate_pattern" => tool_validate_pattern(input),
        "inspect_pattern" => tool_inspect_pattern(input),
        "analyze_arrangement" => tool_analyze_arrangement(input),
        "critique_pattern" => tool_critique_pattern(input),
        "genre_recipe" => tool_genre_recipe(input, state),
        "play_pattern" => tool_play_pattern(input, state, event_tx),
        "stop" => tool_stop(state, event_tx),
        "set_tempo" => tool_set_tempo(input, state, event_tx),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn tool_search_corpus(input: &serde_json::Value, state: &AppState) -> Result<String, String> {
    let query = CorpusQuery {
        tags: input["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        role: input["role"].as_str().and_then(|r| {
            serde_json::from_value::<MusicalRole>(serde_json::Value::String(r.to_string())).ok()
        }),
        tempo_min: input["tempo_min"].as_f64(),
        tempo_max: input["tempo_max"].as_f64(),
        complexity: input["complexity"].as_str().map(String::from),
        sounds: input["sounds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        keyword: input["keyword"].as_str().map(String::from),
        limit: input["limit"].as_u64().map(|n| n as usize),
    };

    let corpus = state.corpus.lock().unwrap();
    match &*corpus {
        Some(index) => {
            let results = index.search(&query);
            serde_json::to_string_pretty(&results).map_err(|e| e.to_string())
        }
        None => Ok("[]".to_string()),
    }
}

fn tool_get_example(input: &serde_json::Value, state: &AppState) -> Result<String, String> {
    let id = input["id"].as_str().ok_or("missing 'id' parameter")?;
    let corpus = state.corpus.lock().unwrap();
    match &*corpus {
        Some(index) => index.get_source(id).map_err(|e| e.to_string()),
        None => Err("corpus not loaded".to_string()),
    }
}

/// Report the sounds currently playable (synths, drums, GM instruments, and
/// any user-loaded sample banks) so the agent picks names that actually exist.
fn tool_list_sounds(state: &AppState) -> Result<String, String> {
    serde_json::to_string_pretty(&crate::sounds::sound_catalog(state)).map_err(|e| e.to_string())
}

/// Generate ready-to-play strudel code from an algorithmic-composition
/// primitive (`robostrudel_gen`). Returns complete `.strudel` source the agent
/// can then validate / play / edit. Missing params fall back to the same
/// defaults as the `gen-pattern` CLI.
fn tool_generate_pattern(input: &serde_json::Value) -> Result<String, String> {
    let generator = input["generator"]
        .as_str()
        .ok_or("missing 'generator' parameter")?;

    match generator {
        "infinity" => {
            let count = input["count"].as_u64().unwrap_or(16) as usize;
            let root = input["root"].as_i64().unwrap_or(60) as i32;
            Ok(robostrudel_gen::infinity(count, root))
        }
        "hexbeat" => {
            let hex = input["hex"].as_str().unwrap_or("a4f2");
            robostrudel_gen::hexbeat(hex)
        }
        "numerals" => {
            let key = input["key"].as_str().unwrap_or("C");
            let numerals = input["numerals"].as_str().unwrap_or("ii V I vi");
            robostrudel_gen::numerals(key, numerals)
        }
        "palindrome" => {
            let motif = input["motif"].as_str().unwrap_or("c4 e4 g4 b4");
            Ok(robostrudel_gen::palindrome(motif))
        }
        "automaton" => {
            let rule = input["rule"].as_u64().unwrap_or(90).min(255) as u8;
            let width = input["width"].as_u64().unwrap_or(8) as usize;
            let gens = input["gens"].as_u64().unwrap_or(4) as usize;
            robostrudel_gen::automaton(rule, width, gens)
        }
        other => Err(format!(
            "unknown generator '{other}'; supported: infinity, hexbeat, numerals, palindrome, automaton"
        )),
    }
}

fn tool_validate_pattern(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;

    match strudel::validate_code(code) {
        Ok(_) => Ok("valid — safe to play".to_string()),
        Err(e) => Ok(format!(
            "INVALID: {e}\n\nFix the error and validate again before playing."
        )),
    }
}

fn tool_inspect_pattern(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let cycles = input["cycles"].as_u64().unwrap_or(8) as usize;

    match strudel::inspect_code(code, cycles) {
        Ok(digest) => Ok(strudel::digest_to_text(&digest)),
        Err(e) => Ok(format!(
            "Could not inspect — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and inspect again."
        )),
    }
}

fn tool_analyze_arrangement(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let max_cycles = input["max_cycles"].as_u64().unwrap_or(32) as usize;

    match strudel::analyze_code(code, max_cycles) {
        Ok(analysis) => Ok(strudel::analyze_to_text(&analysis)),
        Err(e) => Ok(format!(
            "Could not analyze — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and analyze again."
        )),
    }
}

fn tool_critique_pattern(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let cycles = input["cycles"].as_u64().unwrap_or(16) as usize;

    match strudel::critique_code(code, cycles) {
        Ok(critique) => Ok(strudel::critique_to_text(&critique)),
        Err(e) => Ok(format!(
            "Could not critique — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and critique again."
        )),
    }
}

fn tool_genre_recipe(input: &serde_json::Value, state: &AppState) -> Result<String, String> {
    let recipes = state.recipes.lock().unwrap();
    if recipes.is_empty() {
        return Ok("No genre recipes are loaded yet (corpus/genres/ is empty).".to_string());
    }

    let query = input["genre"].as_str().unwrap_or("").trim();
    if query.is_empty() {
        // List mode.
        let mut s = String::from("Genre recipes available (call genre_recipe with one):\n");
        for r in recipes.iter() {
            let bpm = r
                .bpm
                .map(|(lo, hi)| format!(" [{lo:.0}–{hi:.0} BPM]"))
                .unwrap_or_default();
            let sig = r.signature.as_deref().unwrap_or("");
            s.push_str(&format!("- {}{bpm} — {sig}\n", r.genre));
        }
        return Ok(s);
    }

    let matches: Vec<_> = recipes.iter().filter(|r| r.matches(query)).collect();
    if matches.is_empty() {
        let names: Vec<&str> = recipes.iter().map(|r| r.genre.as_str()).collect();
        return Ok(format!(
            "No recipe matches '{query}'. Available: {}.",
            names.join(", ")
        ));
    }
    Ok(matches
        .iter()
        .map(|r| format_recipe(r))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n"))
}

/// Render a recipe as agent-readable markdown-ish text: constraints header,
/// then each section's prose + playable fragments, then sources.
fn format_recipe(r: &robostrudel_corpus::Recipe) -> String {
    use std::fmt::Write;
    let mut s = String::new();

    let aliases = if r.aliases.is_empty() {
        String::new()
    } else {
        format!(" ({})", r.aliases.join(", "))
    };
    let _ = writeln!(s, "# {}{aliases}", r.genre);
    if let Some(sig) = &r.signature {
        let _ = writeln!(s, "{sig}");
    }
    let mut facts: Vec<String> = Vec::new();
    if let Some((lo, hi)) = r.bpm {
        facts.push(format!("BPM {lo:.0}–{hi:.0}"));
    }
    if let Some(sw) = r.swing {
        facts.push(format!("swing {sw}"));
    }
    if !r.scales.is_empty() {
        facts.push(format!("scales: {}", r.scales.join(", ")));
    }
    if !r.key_sounds.is_empty() {
        facts.push(format!("sounds: {}", r.key_sounds.join(", ")));
    }
    if !facts.is_empty() {
        let _ = writeln!(s, "{}", facts.join(" · "));
    }
    if !r.artists.is_empty() {
        let _ = writeln!(s, "Artists: {}", r.artists.join(", "));
    }

    for sec in &r.sections {
        let _ = writeln!(s, "\n## {}", sec.title);
        if !sec.prose.is_empty() {
            let _ = writeln!(s, "{}", sec.prose);
        }
        for frag in &sec.fragments {
            let _ = writeln!(s, "```strudel\n{}\n```", frag.code);
        }
    }

    if !r.sources.is_empty() {
        let _ = writeln!(s, "\nSources: {}", r.sources.join(", "));
    }
    s
}

/// Instead of playing directly, emit a "set_code" event to the frontend.
/// The WASM REPL handles actual audio playback.
fn tool_play_pattern(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;

    {
        let mut session = state.session.lock().unwrap();
        session.set_pattern(code.to_string());
        session.playback = PlaybackState::Playing;
    }

    // Emit a custom event that the frontend will use to inject code into the WASM REPL
    let _ = event_tx.send(AgentEvent::ToolResult {
        name: "__set_code_and_play".to_string(),
        result: code.to_string(),
    });

    Ok(format!("Pattern sent to editor for playback."))
}

fn tool_stop(
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    {
        let mut session = state.session.lock().unwrap();
        session.playback = PlaybackState::Stopped;
    }

    let _ = event_tx.send(AgentEvent::ToolResult {
        name: "__stop_playback".to_string(),
        result: String::new(),
    });
    Ok("stop command sent".to_string())
}

fn tool_set_tempo(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let bpm = input["bpm"].as_f64().ok_or("missing 'bpm' parameter")?;

    {
        let mut session = state.session.lock().unwrap();
        session.tempo = bpm;
    }

    let _ = event_tx.send(AgentEvent::ToolResult {
        name: "__set_tempo".to_string(),
        result: format!("{bpm}"),
    });
    Ok(format!("tempo set to {bpm} BPM"))
}

/// Convert session ChatMessages to Claude API messages.
fn session_to_api_messages(messages: &[ChatMessage]) -> Vec<ApiMessage> {
    messages
        .iter()
        .filter(|m| m.role != ChatRole::System)
        .map(|m| ApiMessage {
            role: match m.role {
                ChatRole::User => "user".to_string(),
                ChatRole::Assistant => "assistant".to_string(),
                ChatRole::System => unreachable!(),
            },
            content: vec![ContentBlock::Text {
                text: m.content.clone(),
            }],
        })
        .collect()
}
