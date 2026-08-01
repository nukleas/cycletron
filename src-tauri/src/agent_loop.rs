use crate::state::AppState;
use crate::strudel;
use cycletron_agent::LlmProvider;
use cycletron_agent::types::*;
use cycletron_core::traits::CorpusIndex;
use cycletron_core::types::{ChatMessage, ChatRole, CorpusQuery, MusicalRole, PlaybackState};
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
    client: &dyn LlmProvider,
    session_messages: &[ChatMessage],
    state: &AppState,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let mut api_messages = session_to_api_messages(session_messages);
    let tool_defs = cycletron_agent::tools::music_tool_definitions();

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
            .map_err(|e| format!("AI provider error: {e}"))?;

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
        "list_methods" => tool_list_methods(input),
        "generate_pattern" => tool_generate_pattern(input),
        "validate_pattern" => tool_validate_pattern(input, state),
        "review_pattern" => tool_review_pattern(input, state),
        "inspect_pattern" => tool_inspect_pattern(input),
        "analyze_arrangement" => tool_analyze_arrangement(input),
        "critique_pattern" => tool_critique_pattern(input),
        "critique_form" => tool_critique_form(input),
        "genre_recipe" => tool_genre_recipe(input, state),
        "play_pattern" => tool_play_pattern(input, state, event_tx),
        "list_parts" => tool_list_parts(state),
        "upsert_track" => tool_upsert_track(input, state, event_tx),
        "mute_track" => tool_mute_track(input, state, event_tx),
        "unmute_track" => tool_unmute_track(input, state, event_tx),
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

/// Report the DSL method/function/keyword surface the validator accepts, so the
/// agent uses real names instead of guessing. Backed by the generated
/// `dsl-surface.json` (ground truth = `docs/STRUDEL_RS_SUPPORTED.md`).
fn tool_list_methods(input: &serde_json::Value) -> Result<String, String> {
    let kind = input["kind"].as_str();
    let category = input["category"].as_str();
    Ok(strudel::methods_listing(kind, category))
}

/// Generate ready-to-play strudel code from an algorithmic-composition
/// primitive (`cycletron_gen`). Returns complete `.strudel` source the agent
/// can then validate / play / edit. Missing params fall back to the same
/// defaults as the `gen-pattern` CLI.
fn tool_generate_pattern(input: &serde_json::Value) -> Result<String, String> {
    let generator = input["generator"]
        .as_str()
        .ok_or("missing 'generator' parameter")?;

    match generator {
        "genre" => {
            let genre = input["genre"].as_str().unwrap_or("house");
            let seed = input["seed"].as_u64().unwrap_or(7);
            cycletron_gen::compose::by_name(genre, seed).map(|piece| {
                let code = piece.to_strudel();
                // Family names and aliases route to one flagship — say so, and
                // name the siblings, so "trance" → uplifting-trance is a
                // visible choice rather than a silent collapse.
                let requested = genre.trim().to_ascii_lowercase().replace([' ', '_'], "-");
                match cycletron_gen::spec::find(genre) {
                    Some(spec) if spec.name != requested => {
                        let siblings: Vec<String> = cycletron_gen::map::families()
                            .iter()
                            .find(|f| f.genres.iter().any(|g| g.name == spec.name))
                            .map(|f| {
                                f.genres
                                    .iter()
                                    .filter(|g| g.name != spec.name)
                                    .map(|g| g.name.clone())
                                    .collect()
                            })
                            .unwrap_or_default();
                        let others = if siblings.is_empty() {
                            String::new()
                        } else {
                            format!("; the map also has: {}", siblings.join(", "))
                        };
                        format!("// routed '{requested}' → {}{others}\n{code}", spec.name)
                    }
                    _ => code,
                }
            })
        }
        "infinity" => {
            let count = input["count"].as_u64().unwrap_or(16) as usize;
            let root = input["root"].as_i64().unwrap_or(60) as i32;
            Ok(cycletron_gen::infinity(count, root))
        }
        "hexbeat" => {
            let hex = input["hex"].as_str().unwrap_or("a4f2");
            cycletron_gen::hexbeat(hex)
        }
        "numerals" => {
            let key = input["key"].as_str().unwrap_or("C");
            let numerals = input["numerals"].as_str().unwrap_or("ii V I vi");
            cycletron_gen::numerals(key, numerals)
        }
        "palindrome" => {
            let motif = input["motif"].as_str().unwrap_or("c4 e4 g4 b4");
            Ok(cycletron_gen::palindrome(motif))
        }
        "automaton" => {
            let rule = input["rule"].as_u64().unwrap_or(90).min(255) as u8;
            let width = input["width"].as_u64().unwrap_or(8) as usize;
            let gens = input["gens"].as_u64().unwrap_or(4) as usize;
            cycletron_gen::automaton(rule, width, gens)
        }
        other => Err(format!(
            "unknown generator '{other}'; supported: genre, infinity, hexbeat, numerals, palindrome, automaton"
        )),
    }
}

fn tool_validate_pattern(input: &serde_json::Value, state: &AppState) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;

    match strudel::validate_code(code) {
        Ok(_) => {
            // Syntax is fine — now hunt the silent-failure class: events that
            // evaluate but will never sound (unknown sounds, unvoiced chords,
            // NaN pan). Lint over a short window; failures here never block.
            let mut lint = strudel::lint_source(code);
            lint.extend(
                strudel::inspect_code(code, 4)
                    .map(|d| strudel::lint_digest(&d, &crate::sounds::known_sound_set(state)))
                    .unwrap_or_default(),
            );
            if lint.is_empty() {
                Ok("valid — safe to play".to_string())
            } else {
                let mut out = String::from("valid syntax, BUT with audibility issues:\n");
                for f in &lint {
                    out.push_str(&format!("  [{}] {}: {}\n", f.severity, f.code, f.message));
                }
                out.push_str("\nFix the warns (they mean silent layers) before playing.");
                Ok(out)
            }
        }
        Err(e) => Ok(format!(
            "INVALID: {e}{}\n\nFix the error and validate again before playing.",
            error_context(code, &e.to_string())
        )),
    }
}

/// If an engine error carries a byte span ("… at 16..20"), render the
/// offending line with a caret under it so nobody counts characters by hand.
fn error_context(code: &str, err: &str) -> String {
    let Some(pos) = err
        .rsplit_once(" at ")
        .and_then(|(_, span)| span.split("..").next())
        .and_then(|s| s.trim().trim_end_matches(|c: char| !c.is_ascii_digit()).parse::<usize>().ok())
    else {
        return String::new();
    };
    let pos = pos.min(code.len());
    let line_start = code[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = code[pos..].find('\n').map(|i| pos + i).unwrap_or(code.len());
    let line_no = code[..line_start].matches('\n').count() + 1;
    let col = code[line_start..pos].chars().count();
    let line = &code[line_start..line_end];
    format!("\n  line {line_no}: {line}\n  {}^ here", " ".repeat(col + "line : ".len() + line_no.to_string().len()))
}

/// The combined quality gate: validate + silence lint + mix critique + (for
/// multi-section songs) form critique, in ONE call — cuts the
/// validate→critique→critique_form round-trip tax for full songs.
fn tool_review_pattern(input: &serde_json::Value, state: &AppState) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let cycles = input["cycles"].as_u64().unwrap_or(8) as usize;

    if let Err(e) = strudel::validate_code(code) {
        return Ok(format!("INVALID: {e}\n\nFix the error and review again."));
    }
    let digest = match strudel::inspect_code(code, cycles) {
        Ok(d) => d,
        Err(e) => return Ok(format!("Could not inspect — the code did not evaluate: {e}")),
    };

    let mut out = String::from("REVIEW\n== digest ==\n");
    out.push_str(&format!(
        "  bpm {}  ·  {} events / {} cycles  ·  period {}  ·  max {} voices  ·  sounds: {}\n",
        digest.bpm.map(|b| b.to_string()).unwrap_or_else(|| "unset".into()),
        digest.total_events,
        digest.cycles_queried,
        digest
            .period_cycles
            .map(|p| format!("{p} cycle(s)"))
            .unwrap_or_else(|| "none detected".into()),
        digest.max_voices,
        digest.sounds.join(", "),
    ));

    let mut warns = 0usize;
    let section = |title: &str, findings: &[strudel::Finding], out: &mut String| {
        out.push_str(&format!("== {title} ==\n"));
        if findings.is_empty() {
            out.push_str("  clean\n");
        }
        for f in findings {
            out.push_str(&format!("  [{}] {}: {}\n", f.severity, f.code, f.message));
        }
    };

    let mut lint = strudel::lint_source(code);
    lint.extend(strudel::lint_digest(&digest, &crate::sounds::known_sound_set(state)));
    warns += lint.iter().filter(|f| f.severity == "warn").count();
    section("silence lint", &lint, &mut out);

    if let Ok(c) = strudel::critique_code(code, cycles) {
        warns += c.findings.iter().filter(|f| f.severity == "warn").count();
        section("mix critique", &c.findings, &mut out);
    }

    if code.contains("pickRestart") || code.contains("arrange") {
        // Section→label map so the form is visible without a separate
        // analyze_arrangement call (labels come from the pickRestart selector).
        if let Ok(a) = strudel::analyze_code(code, cycles) {
            out.push_str("== form map ==\n");
            for s in &a.sections {
                out.push_str(&format!(
                    "  {:<10} cyc {:>2}–{:<3} {:>5.1} ev/cyc  {}\n",
                    s.label,
                    s.start_cycle,
                    s.end_cycle,
                    s.avg_events_per_cycle,
                    s.instruments.join(", ")
                ));
            }
        }
        match strudel::critique_form_code(code, cycles) {
            Ok(c) => {
                warns += c.findings.iter().filter(|f| f.severity == "warn").count();
                section("form critique", &c.findings, &mut out);
            }
            Err(e) => out.push_str(&format!("== form critique ==\n  (unavailable: {e})\n")),
        }
    }

    out.push_str(&if warns == 0 {
        "\nVERDICT: ready to play.".to_string()
    } else {
        format!("\nVERDICT: {warns} warning(s) — fix the warns, then play.")
    });
    Ok(out)
}

fn tool_inspect_pattern(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let cycles = input["cycles"].as_u64().unwrap_or(8) as usize;
    // "auto": full event log for short windows, summary for long forms (a
    // 64-cycle dump is thousands of lines nobody can scan).
    let verbosity = input["verbosity"].as_str().unwrap_or("auto");
    let want_events = match verbosity {
        "events" => true,
        "summary" => false,
        _ => cycles <= 4,
    };

    match strudel::inspect_code(code, cycles) {
        Ok(digest) if !want_events => Ok(strudel::digest_to_summary(&digest)),
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

fn tool_critique_form(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let cycles = input["cycles"].as_u64().unwrap_or(32) as usize;

    match strudel::critique_form_code(code, cycles) {
        Ok(critique) => Ok(strudel::form_critique_to_text(&critique)),
        Err(e) => Ok(format!(
            "Could not critique the form — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and try again."
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
fn format_recipe(r: &cycletron_corpus::Recipe) -> String {
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

/// Repair-and-revalidate gate before playback. Playback injects code straight
/// into the editor, and the agent is only *expected* to validate first — nothing
/// forced it, so raw model output could reach the WASM REPL and play (or, worse,
/// silently fail to). This gate closes that loop in three steps:
///
///   1. deterministically repair the mechanical mistakes with one correct fix
///      (fences, `(x) =>` params, negative literal pan — see `sanitize_source`);
///   2. re-validate the result through the *real* evaluator and fail closed —
///      un-evaluable code is never injected, it goes back to the agent to fix;
///   3. run the advisory silence lint — syntactically valid but audibly-dead
///      layers are surfaced (not blocked; the audible layers still play).
///
/// The repaired code — not the raw input — is what reaches the editor and the
/// session, so `current_pattern` always reflects what actually plays.
fn tool_play_pattern(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let raw = input["code"].as_str().ok_or("missing 'code' parameter")?;
    apply_document(state, event_tx, raw, "Pattern sent to editor for playback.")
}

/// The shared commit path for anything that changes the playing document:
/// deterministic repair → re-validate (fail closed) → silence lint (advisory) →
/// store in session → emit `__set_code_and_play` (a phase-preserving hot-swap on
/// the frontend). `lead` is the first sentence of the summary returned to the
/// agent. On a validation failure NOTHING is committed or emitted — the caller's
/// edit is a no-op and the agent is told why.
fn apply_document(
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    raw: &str,
    lead: &str,
) -> Result<String, String> {
    // The resolvable sound set drives both the alias remap and the silence lint.
    let known = crate::sounds::known_sound_set(state);

    // 1. Deterministic repair: mechanical fixes + catalog-backed sound aliases.
    let strudel::Sanitized { code, notes } = strudel::sanitize_source_with_catalog(raw, &known);
    let repair_summary = if notes.is_empty() {
        String::new()
    } else {
        let mut s = String::from("\nAuto-repaired:");
        for n in &notes {
            s.push_str(&format!("\n  • {n}"));
        }
        s
    };

    // 2. Re-validate through the REAL evaluator. Fail closed: never inject code
    //    the engine can't parse — that is silence with no feedback loop.
    if let Err(e) = strudel::validate_code(&code) {
        return Ok(format!(
            "NOT APPLIED — the resulting pattern does not evaluate, so nothing changed.\n\
             INVALID: {e}{}{repair_summary}\n\nFix the error and try again.",
            error_context(&code, &e.to_string()),
        ));
    }

    // 3. Silence lint (advisory): valid syntax, but audibly-dead layers —
    //    invented sounds, unvoiced chords, out-of-range pan. Surface, don't block.
    let mut lint = strudel::lint_source(&code);
    lint.extend(
        strudel::inspect_code(&code, 4)
            .map(|d| strudel::lint_digest(&d, &known))
            .unwrap_or_default(),
    );
    let warns: Vec<_> = lint.iter().filter(|f| f.severity == "warn").collect();

    // 4. Commit the repaired code: store it and inject into the WASM REPL.
    {
        let mut session = state.session.lock().unwrap();
        session.set_pattern(code.clone());
        session.playback = PlaybackState::Playing;
    }
    let _ = event_tx.send(AgentEvent::ToolResult {
        name: "__set_code_and_play".to_string(),
        result: code.clone(),
    });

    // 5. Report back what was repaired and any silent-layer warnings.
    let mut msg = String::from(lead);
    msg.push_str(&repair_summary);
    if !warns.is_empty() {
        msg.push_str("\nPlaying, but these layers may be SILENT — fix, then play again:");
        for f in &warns {
            msg.push_str(&format!("\n  [{}] {}: {}", f.severity, f.code, f.message));
        }
    }
    Ok(msg)
}

/// The document currently in the editor/session, or a friendly error when there
/// is nothing to edit yet.
fn current_document(state: &AppState) -> Result<String, String> {
    state
        .session
        .lock()
        .unwrap()
        .current_pattern
        .clone()
        .ok_or_else(|| {
            "There's no song in the editor yet. Use play_pattern to start one, then edit its \
             tracks with upsert_track / mute_track."
                .to_string()
        })
}

/// List the addressable tracks of the current song (read-only; no playback).
fn tool_list_parts(state: &AppState) -> Result<String, String> {
    let code = current_document(state)?;
    let parts = crate::tracks::list_tracks(&code);
    if parts.is_empty() {
        return Ok("The current document has no tracks yet.".to_string());
    }
    let mut out = format!("{} track(s) in the current song:\n", parts.len());
    for p in &parts {
        let handle = match &p.id {
            Some(id) => format!("@{id}"),
            None => format!("#{} (no id — address by index)", p.index),
        };
        let muted = if p.muted { " [MUTED]" } else { "" };
        out.push_str(&format!("  {}. {}{}  —  {}\n", p.index, handle, muted, p.preview));
    }
    out.push_str(
        "\nEdit one with upsert_track {id, code}; silence one with mute_track {id}.",
    );
    Ok(out)
}

/// Add or replace one track, then hot-swap. Only the target track's text changes.
fn tool_upsert_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let id = input["id"].as_str().ok_or("missing 'id' parameter")?;
    let expr = input["code"].as_str().ok_or("missing 'code' parameter")?;
    let code = current_document(state)?;
    let (new_code, wrote) = crate::tracks::upsert_track(&code, id, expr)?;
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Track @{wrote} updated (other tracks unchanged)."),
    )
}

/// Mute one track (comment it out), then hot-swap.
fn tool_mute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let id = input["id"].as_str().ok_or("missing 'id' parameter")?;
    let code = current_document(state)?;
    let new_code = crate::tracks::mute_track(&code, id)?;
    apply_document(state, event_tx, &new_code, &format!("Track '{id}' muted."))
}

/// Restore a muted track, then hot-swap.
fn tool_unmute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<String, String> {
    let id = input["id"].as_str().ok_or("missing 'id' parameter")?;
    let code = current_document(state)?;
    let new_code = crate::tracks::unmute_track(&code, id)?;
    apply_document(state, event_tx, &new_code, &format!("Track '{id}' unmuted."))
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
