use crate::state::AppState;
use cycletron_agent::LlmProvider;
use cycletron_agent::ToolName;
use cycletron_agent::types::*;
use cycletron_analysis as strudel;
use cycletron_core::types::{
    ChatMessage, ChatRole, CorpusQuery, PlaybackState, ToolCategory, ToolFinding, ToolOutcome,
    ToolTrace,
};
use std::sync::LazyLock;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

/// System prompt: the embedded copy is authoritative. In dev we also probe a
/// few cwd-relative paths first so `prompts/system.md` can be hot-edited without
/// a rebuild; release builds skip the probing (it only ever succeeds in the repo
/// tree) and use the embedded copy silently — no misleading "file not found".
static SYSTEM_PROMPT: LazyLock<String> = LazyLock::new(|| {
    #[cfg(debug_assertions)]
    for path in [
        "prompts/system.md",
        "../prompts/system.md",
        "src-tauri/../prompts/system.md",
    ] {
        if let Ok(content) = std::fs::read_to_string(path) {
            tracing::info!("loaded system prompt from {path}");
            return content;
        }
    }
    tracing::debug!("using embedded system prompt");
    include_str!("../../prompts/system.md").to_string()
});

/// A tool's answer: the typed envelope, or a hard failure the loop turns into
/// one. `Ok(outcome)` may itself carry `ok: false` (INVALID, NOT APPLIED,
/// budget…) — those are results the tool composed; `Err` is for the
/// short-circuit cases (`?` on a missing argument, a denied path, an I/O
/// failure) where there is no report to write.
type ToolResult = Result<ToolOutcome, ToolErr>;

/// A classified hard failure. There is deliberately no `From<String>`: every
/// `?` on a string error names its category at the site, so the category is a
/// decision, not a default.
#[derive(Debug)]
struct ToolErr {
    category: ToolCategory,
    message: String,
}

impl ToolErr {
    fn new(category: ToolCategory, message: impl std::fmt::Display) -> Self {
        Self {
            category,
            message: message.to_string(),
        }
    }
    fn bad_argument(m: impl std::fmt::Display) -> Self {
        Self::new(ToolCategory::BadArgument, m)
    }
    fn not_found(m: impl std::fmt::Display) -> Self {
        Self::new(ToolCategory::NotFound, m)
    }
    fn precondition(m: impl std::fmt::Display) -> Self {
        Self::new(ToolCategory::Precondition, m)
    }
    fn budget(m: impl std::fmt::Display) -> Self {
        Self::new(ToolCategory::BudgetExhausted, m)
    }
    fn io(m: impl std::fmt::Display) -> Self {
        Self::new(ToolCategory::Io, m)
    }
    fn into_outcome(self) -> ToolOutcome {
        ToolOutcome::failed(self.category, self.message)
    }
}

impl From<crate::library_index::LibError> for ToolErr {
    fn from(e: crate::library_index::LibError) -> Self {
        use crate::library_index::LibError as L;
        let category = match &e {
            L::PathDenied(_) => ToolCategory::PathDenied,
            L::NotFound(_) => ToolCategory::NotFound,
            L::BadArgument(_) => ToolCategory::BadArgument,
            L::Conflict(_) => ToolCategory::Conflict,
            L::Io(_) => ToolCategory::Io,
        };
        Self::new(category, e)
    }
}

impl From<cycletron_doc::DocError> for ToolErr {
    fn from(e: cycletron_doc::DocError) -> Self {
        use cycletron_doc::DocError as D;
        let category = match &e {
            D::BadArgument(_) => ToolCategory::BadArgument,
            D::NotFound(_) => ToolCategory::NotFound,
            D::NoStructure(_) => ToolCategory::Precondition,
        };
        Self::new(category, e)
    }
}

/// Lint findings in the envelope's shape (core cannot depend on analysis).
fn findings(fs: &[strudel::Finding]) -> Vec<ToolFinding> {
    fs.iter()
        .map(|f| ToolFinding {
            severity: f.severity.clone(),
            code: f.code.clone(),
            message: f.message.clone(),
        })
        .collect()
}

/// How much of each tool result to keep in cross-turn memory. Inputs are stored
/// in full (small, and must rebuild a valid tool_use); results are capped here
/// so replaying past turns doesn't resend large file/corpus dumps every time.
const TOOL_RESULT_MEMORY_CHARS: usize = 600;

/// Run the full agent loop: conversation with Claude, tool execution, return the
/// final text plus the compact tool traces to persist for cross-turn memory.
pub async fn run_agent_loop(
    client: &dyn LlmProvider,
    session_messages: &[ChatMessage],
    state: &AppState,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
) -> Result<(String, Vec<ToolTrace>), String> {
    let mut api_messages = session_to_api_messages(session_messages);
    let tool_defs = cycletron_agent::tools::music_tool_definitions();

    // Build the system prompt with current editor code injected
    let current_code = {
        let session = state.session.lock();
        session.current_pattern.clone()
    };
    let system_prompt = if let Some(code) = &current_code {
        format!(
            "{}\n\n## Current editor code (what the user hears right now)\n\n```\n{}\n```\n\n\
             When the user asks to modify, add to, or expand the song, work from this code. \
             Do not ask them to paste it — you already have it.",
            *SYSTEM_PROMPT, code
        )
    } else {
        SYSTEM_PROMPT.clone()
    };

    let mut full_text = String::new();
    // Compact record of every tool this turn called, persisted onto the
    // assistant message so the next turn's context includes what was already
    // tried instead of collapsing to text-only.
    let mut turn_tools: Vec<ToolTrace> = Vec::new();
    // Run id groups all tool calls made for this one user message, so the
    // telemetry analyzer can see retries within a single request.
    let run = crate::telemetry::now_millis();
    // Fresh per-turn egress budget: bounds how much library content read_song can
    // send to the (possibly cloud) model in one user turn — no folder-dumping.
    state.reset_read_budget();
    // Fresh review budget for this user message (keeps last-reviewed buffer).
    state.reset_agent_write_run();
    let telemetry_dir = state.app_data_dir();
    // 20 leaves the agent room to call tools several times (each tool round
    // is one iteration) before the loop forces an answer. 10 was tight
    // enough that complex prompts would get cut mid-thought.
    let max_iterations = 20;

    for iteration in 0..max_iterations {
        debug!("agent loop iteration {iteration}");

        let mut response = client
            .stream_message(&system_prompt, &api_messages, tool_defs, &event_tx)
            .await
            .map_err(|e| format!("AI provider error: {e}"))?;

        // Weak/local models often emit a tool call as TEXT (```json {name,
        // arguments}```) instead of a native tool_call. Recover those into real
        // ToolUse blocks so the same models that pick the right tool but can't
        // format it still work. No-op when a native call is already present.
        recover_text_tool_calls(&mut response.content, tool_defs);

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
        let truncated =
            response.stop_reason.as_deref() == Some("max_tokens") || response.incomplete_tool_input;

        let mut tool_results = Vec::new();
        for (id, name, input) in &tool_calls {
            let input_empty = input.as_object().is_none_or(serde_json::Map::is_empty);
            let started = std::time::Instant::now();
            let outcome = if truncated && input_empty {
                warn!("tool '{name}' arguments truncated at token limit; not executing");
                ToolOutcome::failed(
                    ToolCategory::Truncated,
                    format!(
                        "Your previous message hit the {} token output limit before the \
                         arguments to `{name}` finished streaming, so the tool received no \
                         input. Emit a more compact pattern — use `*n` for repeats, `@n` for \
                         holds, and `slowcat`/`<...>` instead of fully expanding every event — \
                         and keep the whole reply shorter so the tool call completes.",
                        client.max_tokens()
                    ),
                )
            } else {
                info!("executing tool: {name}");
                match execute_tool(name, input, state, &event_tx).await {
                    Ok(outcome) => outcome,
                    Err(e) => e.into_outcome(),
                }
            };
            let duration_ms = started.elapsed().as_millis() as u64;
            // Prefer write_kind the tool may have stamped into state
            // (review_cache / reuse / full) over input-only inference.
            let write_kind = state
                .take_write_kind()
                .or_else(|| infer_write_kind(name, input));
            let _ = event_tx.send(AgentEvent::ToolResult {
                id: id.clone(),
                name: name.clone(),
                outcome: outcome.clone(),
                duration_ms,
            });

            crate::telemetry::record(
                telemetry_dir.as_deref(),
                &crate::telemetry::ToolEvent {
                    ts: crate::telemetry::now_millis(),
                    run,
                    turn: iteration,
                    tool: name.clone(),
                    ok: outcome.ok,
                    category: outcome.category.map(|c| c.as_str().to_string()),
                    retryable: outcome.retryable,
                    duration_ms,
                    input: crate::telemetry::truncate(
                        &serde_json::to_string(input).unwrap_or_default(),
                        240,
                    ),
                    result: crate::telemetry::truncate(&outcome.text, 200),
                    code_chars: crate::telemetry::code_chars_of(input),
                    write_kind,
                },
            );

            // Persist a compact trace of the call for cross-turn memory: full
            // input (must round-trip into a valid tool_use on replay), result
            // text truncated so large dumps don't inflate later turns' input.
            turn_tools.push(ToolTrace {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                outcome: outcome.truncated(TOOL_RESULT_MEMORY_CHARS),
                duration_ms,
            });

            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: id.clone(),
                content: outcome.to_model_text(),
                is_error: (!outcome.ok).then_some(true),
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

    Ok((full_text, turn_tools))
}

/// Execute a tool by name.
async fn execute_tool(
    name: &str,
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    // Exhaustive over ToolName (no wildcard): a tool defined in
    // cycletron-agent without a dispatch arm here is a compile error.
    let Some(tool) = ToolName::parse(name) else {
        return Err(ToolErr::bad_argument(format!("unknown tool: {name}")));
    };
    match tool {
        ToolName::SearchCorpus => tool_search_corpus(input, state),
        ToolName::GetExample => tool_get_example(input, state),
        ToolName::ListLibrary => tool_list_library(input, state),
        ToolName::SearchLibrary => tool_search_library(input, state),
        ToolName::ReadSong => tool_read_song(input, state),
        ToolName::SaveSong => tool_save_song(input, state, event_tx),
        ToolName::SaveCurrentAs => tool_save_current_as(input, state, event_tx),
        ToolName::RenameSong => tool_rename_song(input, state, event_tx),
        ToolName::MoveSong => tool_move_song(input, state, event_tx),
        ToolName::NewFolder => tool_new_folder(input, state, event_tx),
        ToolName::ListSounds => tool_list_sounds(state),
        ToolName::ListMethods => tool_list_methods(input),
        ToolName::GeneratePattern => tool_generate_pattern(input),
        ToolName::ValidatePattern => tool_validate_pattern(input, state),
        ToolName::ReviewPattern => tool_review_pattern(input, state),
        ToolName::HearPattern => tool_hear_pattern(input, state).await,
        ToolName::InspectPattern => tool_inspect_pattern(input),
        ToolName::AnalyzeArrangement => tool_analyze_arrangement(input),
        ToolName::CritiquePattern => tool_critique_pattern(input),
        ToolName::CritiqueForm => tool_critique_form(input),
        ToolName::GenreRecipe => tool_genre_recipe(input, state),
        ToolName::PlayPattern => tool_play_pattern(input, state, event_tx),
        ToolName::ListParts => tool_list_parts(state),
        ToolName::ListSections => tool_list_sections(state),
        ToolName::UpsertTrack => tool_upsert_track(input, state, event_tx),
        ToolName::UpsertTracks => tool_upsert_tracks(input, state, event_tx),
        ToolName::UpsertSection => tool_upsert_section(input, state, event_tx),
        ToolName::UpsertSections => tool_upsert_sections(input, state, event_tx),
        ToolName::UpsertBinding => tool_upsert_binding(input, state, event_tx),
        ToolName::MuteTrack => tool_mute_track(input, state, event_tx),
        ToolName::UnmuteTrack => tool_unmute_track(input, state, event_tx),
        ToolName::Stop => tool_stop(state, event_tx),
        ToolName::SetTempo => tool_set_tempo(input, state, event_tx),
    }
}

/// Required string argument: uniform "missing 'key' parameter" error.
fn req_str<'a>(input: &'a serde_json::Value, key: &str) -> Result<&'a str, ToolErr> {
    input[key]
        .as_str()
        .ok_or_else(|| ToolErr::bad_argument(format!("missing '{key}' parameter")))
}

fn opt_usize(input: &serde_json::Value, key: &str, default: usize) -> usize {
    input[key].as_u64().map_or(default, |n| n as usize)
}

fn tool_search_corpus(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let query = CorpusQuery {
        tags: input["tags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
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

    let corpus = state.corpus.lock();
    match &*corpus {
        Some(index) => {
            let results = index.search(&query);
            let text = serde_json::to_string_pretty(&results).map_err(ToolErr::io)?;
            Ok(ToolOutcome::ok(
                format!("{} corpus match(es)", results.len()),
                text,
            ))
        }
        None => Ok(ToolOutcome::ok("corpus not loaded — no matches", "[]")),
    }
}

fn tool_get_example(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let id = req_str(input, "id")?;
    let corpus = state.corpus.lock();
    match &*corpus {
        Some(index) => index
            .get_source(id)
            .map(|src| ToolOutcome::ok(format!("example {id}"), src))
            .map_err(ToolErr::not_found),
        None => Err(ToolErr::precondition("corpus not loaded")),
    }
}

// --- Library awareness (read-only) -------------------------------------------
// The agent can see and read the user's OWN saved songs, not just the curated
// corpus. All three tools are read-only and confined to the library root.

/// One line per song for the agent: name, tempo, tags, sounds, path, preview.
fn format_song_line(s: &crate::library_index::LibrarySong) -> String {
    let bpm = s
        .bpm
        .map(|b| format!("{b:.0} BPM"))
        .unwrap_or_else(|| "—".into());
    let tags = if s.tags.is_empty() {
        String::new()
    } else {
        format!(" · #{}", s.tags.join(" #"))
    };
    let sounds = if s.sounds.is_empty() {
        String::new()
    } else {
        format!(
            " · sounds: {}",
            s.sounds
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "• {} [{bpm}]{tags}  @{}{sounds}\n    {}",
        s.name, s.rel_path, s.preview
    )
}

/// List the user's saved songs (newest first). Optional `limit` (default 30).
fn tool_list_library(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let root = state.library_root();
    let warn = crate::library_index::root_warning(&root)
        .map(|w| format!("{w}\n\n"))
        .unwrap_or_default();
    let idx = crate::library_index::LibraryIndex::build(&root);
    if idx.songs.is_empty() {
        return Ok(ToolOutcome::ok(
            "library is empty",
            format!("{warn}Your library is empty — no saved songs yet."),
        ));
    }
    let limit = input["limit"].as_u64().map(|n| n as usize).unwrap_or(30);
    let shown = idx.songs.len().min(limit);
    let mut out = format!(
        "{warn}Your library: {} song(s){}\n",
        idx.songs.len(),
        if shown < idx.songs.len() {
            format!(" (showing newest {shown})")
        } else {
            String::new()
        }
    );
    for s in idx.songs.iter().take(limit) {
        out.push_str(&format_song_line(s));
        out.push('\n');
    }
    out.push_str("\nUse read_song with an @path to open one.");
    Ok(ToolOutcome::ok(
        format!("{} song(s) in the library", idx.songs.len()),
        out,
    ))
}

/// Search the user's saved songs by keyword / tag / sound / tempo range.
fn tool_search_library(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let q = crate::library_index::LibraryQuery {
        keyword: input["keyword"].as_str().map(String::from),
        tag: input["tag"].as_str().map(String::from),
        sound: input["sound"].as_str().map(String::from),
        bpm_min: input["bpm_min"].as_f64(),
        bpm_max: input["bpm_max"].as_f64(),
        limit: input["limit"].as_u64().map(|n| n as usize).or(Some(15)),
    };
    let root = state.library_root();
    let warn = crate::library_index::root_warning(&root)
        .map(|w| format!("{w}\n\n"))
        .unwrap_or_default();
    let idx = crate::library_index::LibraryIndex::build(&root);
    let hits = idx.search(&q);
    if hits.is_empty() {
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            format!(
                "{warn}No songs in your library match that. Try list_library to see everything."
            ),
        ));
    }
    let mut out = format!("{warn}{} matching song(s):\n", hits.len());
    let n = hits.len();
    for s in hits {
        out.push_str(&format_song_line(s));
        out.push('\n');
    }
    Ok(ToolOutcome::ok(format!("{n} matching song(s)"), out))
}

/// Open one of the user's saved songs (by its @rel_path) to remix or continue it.
fn tool_read_song(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let path = input["path"]
        .as_str()
        .ok_or_else(|| {
            ToolErr::bad_argument("missing 'path' — use the @path from list_library/search_library")
        })?
        .trim()
        .trim_start_matches('@');
    let root = state.library_root();
    let doc = crate::library_index::read_song(&root, path)?;
    // Charge this read against the per-turn egress budget; if it would exceed the
    // ceiling, refuse — the content is NOT returned, so nothing leaves the machine.
    state
        .account_read(doc.code.len())
        .map_err(ToolErr::budget)?;
    let fm = doc.frontmatter.unwrap_or_default();
    let header = format!(
        "// {} — {}{}\n",
        fm.name.unwrap_or_else(|| path.to_string()),
        fm.bpm
            .map(|b| format!("{b:.0} BPM"))
            .unwrap_or_else(|| "tempo unset".into()),
        if fm.tags.is_empty() {
            String::new()
        } else {
            format!(" · #{}", fm.tags.join(" #"))
        },
    );
    Ok(ToolOutcome::ok(
        format!("read @{path}"),
        format!("{header}{}", doc.code),
    ))
}

// --- Library writes (Tier B) — optimistic + reversible, root-confined --------

/// Notify the frontend that the library changed: refresh the file tree + toast.
/// Mirrors the `__set_code_and_play` sentinel pattern (tools have no AppHandle).
fn emit_library_changed(event_tx: &mpsc::UnboundedSender<AgentEvent>, rel_path: &str) {
    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__library_changed".to_string(),
        payload: rel_path.to_string(),
    });
}

/// Save agent-supplied code as a named song in the library.
fn tool_save_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let code = req_str(input, "code")?;
    let folder = input["folder"].as_str();
    let root = state.library_root();
    let rel = crate::library_index::save_song(
        &root,
        state.app_data_dir().as_deref(),
        name,
        code,
        folder,
    )?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("saved @{rel}"),
        format!(
            "Saved '{name}' to your library at @{rel} (prior version snapshotted; undo from the file's history)."
        ),
    ))
}

/// Save the CURRENT editor buffer as a named song.
fn tool_save_current_as(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let folder = input["folder"].as_str();
    let code = current_document(state)?;
    let root = state.library_root();
    let rel = crate::library_index::save_song(
        &root,
        state.app_data_dir().as_deref(),
        name,
        &code,
        folder,
    )?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("saved @{rel}"),
        format!("Saved the current song as '{name}' at @{rel}."),
    ))
}

fn tool_rename_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let new_name = req_str(input, "new_name")?;
    let root = state.library_root();
    let rel = crate::library_index::rename_song(&root, path, new_name)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("renamed to @{rel}"),
        format!("Renamed to '{new_name}' — now at @{rel}."),
    ))
}

fn tool_move_song(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let folder = req_str(input, "folder")?;
    let root = state.library_root();
    let rel = crate::library_index::move_song(&root, path, folder)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("moved to @{rel}"),
        format!("Moved to @{rel}."),
    ))
}

fn tool_new_folder(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let path = req_str(input, "path")?;
    let root = state.library_root();
    let rel = crate::library_index::create_folder(&root, path)?;
    emit_library_changed(event_tx, &rel);
    Ok(ToolOutcome::ok(
        format!("created @{rel}"),
        format!("Created folder @{rel}."),
    ))
}

/// Report the sounds currently playable (synths, drums, GM instruments, and
/// any user-loaded sample banks) so the agent picks names that actually exist.
fn tool_list_sounds(state: &AppState) -> ToolResult {
    let text =
        serde_json::to_string_pretty(&crate::sounds::sound_catalog(state)).map_err(ToolErr::io)?;
    Ok(ToolOutcome::ok("sound catalog", text))
}

/// Report the DSL method/function/keyword surface the validator accepts, so the
/// agent uses real names instead of guessing. Backed by the generated
/// `dsl-surface.json` (ground truth = `docs/STRUDEL_RS_SUPPORTED.md`).
fn tool_list_methods(input: &serde_json::Value) -> ToolResult {
    let kind = input["kind"].as_str();
    let category = input["category"].as_str();
    Ok(ToolOutcome::ok(
        "method listing",
        strudel::methods_listing(kind, category),
    ))
}

/// Generate ready-to-play strudel code from an algorithmic-composition
/// primitive (`cycletron_gen`). Returns complete `.strudel` source the agent
/// can then validate / play / edit. Missing params fall back to the same
/// defaults as the `gen-pattern` CLI.
/// Recover tool calls a model wrote as TEXT into real `ToolUse` blocks. Weak and
/// local models frequently understand which tool to call but can't emit the
/// native tool-call format — they print a ```json {"name":…,"arguments":…}```
/// block instead. This rescues those. No-op if a native `ToolUse` is present or
/// no recognisable tool call is in the text.
fn recover_text_tool_calls(content: &mut Vec<ContentBlock>, tool_defs: &[ToolDefinition]) {
    if content
        .iter()
        .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
    {
        return;
    }
    let known: std::collections::HashSet<&str> =
        tool_defs.iter().map(|t| t.name.as_str()).collect();

    let mut kept: Vec<ContentBlock> = Vec::new();
    let mut recovered: Vec<ContentBlock> = Vec::new();
    for block in content.drain(..) {
        if let ContentBlock::Text { text } = &block {
            let calls = extract_tool_calls_from_text(text, &known);
            if !calls.is_empty() {
                for (name, input) in calls {
                    recovered.push(ContentBlock::ToolUse {
                        id: format!("txt-{}", recovered.len()),
                        name,
                        input,
                    });
                }
                continue; // drop the raw JSON text so the user doesn't see it
            }
        }
        kept.push(block);
    }
    kept.append(&mut recovered);
    *content = kept;
}

/// Pull `{name, arguments}`-shaped tool calls out of free text — tolerant of code
/// fences, surrounding prose, `function`-wrapping, and a few key aliases models
/// use. Only returns calls whose tool name is in `known`.
fn extract_tool_calls_from_text(
    text: &str,
    known: &std::collections::HashSet<&str>,
) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    for v in scan_json_objects(text) {
        // Accept either a top-level {name, arguments} or an OpenAI-ish
        // {function: {name, arguments}} wrapper.
        let obj = v.get("function").filter(|f| f.is_object()).unwrap_or(&v);
        let name = ["name", "tool", "tool_name"]
            .iter()
            .find_map(|k| obj.get(*k).and_then(|x| x.as_str()));
        let Some(name) = name else { continue };
        if !known.contains(name) {
            continue;
        }
        let args = ["arguments", "parameters", "args", "input", "tool_input"]
            .iter()
            .find_map(|k| obj.get(*k).cloned())
            .unwrap_or_else(|| serde_json::json!({}));
        // Some models stringify the arguments object; unwrap that.
        let args = match args {
            serde_json::Value::String(s) => {
                serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
            }
            other => other,
        };
        out.push((name.to_string(), args));
    }
    out
}

/// Every balanced `{…}` JSON object in `text` that parses (string-aware, so
/// braces inside strings don't break nesting). Handles fenced and bare JSON.
fn scan_json_objects(text: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let (mut depth, mut in_str, mut esc) = (0i32, false, false);
        let start = i;
        let mut j = i;
        while j < bytes.len() {
            let c = bytes[j];
            if in_str {
                if esc {
                    esc = false;
                } else if c == b'\\' {
                    esc = true;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            j += 1;
        }
        if depth == 0 && j < bytes.len() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[start..=j]) {
                out.push(v);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Resolve which generator to run. Models (small local ones especially) fill the
/// specific param (`genre`, `hex`, `motif`, …) but often omit the `generator`
/// discriminator because it feels redundant — so infer it from what's present,
/// defaulting to `genre` (the overwhelmingly common request).
fn infer_generator(input: &serde_json::Value) -> &'static str {
    if let Some(g) = input["generator"].as_str() {
        return match g {
            "infinity" => "infinity",
            "hexbeat" => "hexbeat",
            "numerals" => "numerals",
            "palindrome" => "palindrome",
            "automaton" => "automaton",
            _ => "genre",
        };
    }
    let has = |k: &str| !input[k].is_null();
    if has("hex") {
        "hexbeat"
    } else if has("motif") {
        "palindrome"
    } else if has("numerals") {
        "numerals"
    } else if has("rule") || has("gens") {
        "automaton"
    } else if has("genre") {
        "genre"
    } else if has("count") || has("root") {
        "infinity"
    } else {
        "genre"
    }
}

fn tool_generate_pattern(input: &serde_json::Value) -> ToolResult {
    let generator = infer_generator(input);

    let code = match generator {
        "genre" => {
            let genre = input["genre"].as_str().unwrap_or("house");
            let seed = input["seed"].as_u64().unwrap_or(7);
            cycletron_gen::compose::by_name(genre, seed)
                .map_err(ToolErr::bad_argument)
                .map(|piece| {
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
                })?
        }
        "infinity" => {
            let count = opt_usize(input, "count", 16);
            let root = input["root"].as_i64().unwrap_or(60) as i32;
            cycletron_gen::infinity(count, root)
        }
        "hexbeat" => {
            let hex = input["hex"].as_str().unwrap_or("a4f2");
            cycletron_gen::hexbeat(hex).map_err(ToolErr::bad_argument)?
        }
        "numerals" => {
            let key = input["key"].as_str().unwrap_or("C");
            let numerals = input["numerals"].as_str().unwrap_or("ii V I vi");
            cycletron_gen::numerals(key, numerals).map_err(ToolErr::bad_argument)?
        }
        "palindrome" => {
            let motif = input["motif"].as_str().unwrap_or("c4 e4 g4 b4");
            cycletron_gen::palindrome(motif)
        }
        "automaton" => {
            let rule = input["rule"].as_u64().unwrap_or(90).min(255) as u8;
            let width = opt_usize(input, "width", 8);
            let gens = opt_usize(input, "gens", 4);
            cycletron_gen::automaton(rule, width, gens).map_err(ToolErr::bad_argument)?
        }
        other => {
            return Err(ToolErr::bad_argument(format!(
                "unknown generator '{other}'; supported: genre, infinity, hexbeat, numerals, palindrome, automaton"
            )));
        }
    };
    Ok(ToolOutcome::ok(format!("generated ({generator})"), code))
}

/// Hash used as a review-cache key (stable for identical source).
fn code_hash(code: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    code.hash(&mut h);
    h.finish()
}

/// Resolve optional `code` for review/validate: explicit arg → current editor.
fn resolve_code_or_editor(input: &serde_json::Value, state: &AppState) -> Result<String, ToolErr> {
    if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(c.to_string());
    }
    current_document(state).map_err(|_| {
        ToolErr::precondition(
            "No code provided and nothing is in the editor. Pass `code`, or play a pattern first.",
        )
    })
}

/// Telemetry write-kind when the tool didn't stamp one: full play vs track edit.
fn infer_write_kind(name: &str, input: &serde_json::Value) -> Option<String> {
    match name {
        "play_pattern" => {
            if input
                .get("code")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
            {
                Some("full".into())
            } else {
                Some("reuse".into())
            }
        }
        "upsert_track" | "upsert_tracks" => Some("track".into()),
        "upsert_section" | "upsert_sections" => Some("section".into()),
        "upsert_binding" => Some("binding".into()),
        "review_pattern" => Some("review".into()),
        "hear_pattern" => Some("hear".into()),
        "validate_pattern" => Some("validate".into()),
        _ => None,
    }
}

fn tool_validate_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;

    if code.trim().is_empty() {
        return Ok(ToolOutcome::ok("valid (empty)", "valid — safe to play"));
    }
    match strudel::Evaluated::new(&code, 4) {
        Ok(ev) => {
            // Syntax is fine — now hunt the silent-failure class: events that
            // evaluate but will never sound (unknown sounds, unvoiced chords,
            // NaN pan). Lint over a short window; failures here never block.
            let mut lint = strudel::lint_source(&code);
            lint.extend(strudel::lint_digest(
                ev.digest(),
                &crate::sounds::known_sound_set(state),
            ));
            if lint.is_empty() {
                Ok(ToolOutcome::ok("valid", "valid — safe to play"))
            } else {
                let mut out = String::from("valid syntax, BUT with audibility issues:\n");
                for f in &lint {
                    out.push_str(&format!("  [{}] {}: {}\n", f.severity, f.code, f.message));
                }
                out.push_str("\nFix the warns (they mean silent layers) before playing.");
                let warns = lint.iter().filter(|f| f.severity == "warn").count();
                Ok(
                    ToolOutcome::ok(format!("valid, {warns} audibility warning(s)"), out)
                        .with_warnings(findings(&lint)),
                )
            }
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error and validate again before playing.",
                error_context(&code, &e.to_string())
            ),
        )),
    }
}

/// If an engine error carries a byte span ("… at 16..20"), render the
/// offending line with a caret under it so nobody counts characters by hand.
fn error_context(code: &str, err: &str) -> String {
    let Some(pos) = err
        .rsplit_once(" at ")
        .and_then(|(_, span)| span.split("..").next())
        .and_then(|s| {
            s.trim()
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse::<usize>()
                .ok()
        })
    else {
        return String::new();
    };
    let pos = pos.min(code.len());
    let line_start = code[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = code[pos..]
        .find('\n')
        .map(|i| pos + i)
        .unwrap_or(code.len());
    let line_no = code[..line_start].matches('\n').count() + 1;
    let col = code[line_start..pos].chars().count();
    let line = &code[line_start..line_end];
    let caret = format!(
        "\n  line {line_no}: {line}\n  {}^ here",
        " ".repeat(col + "line : ".len() + line_no.to_string().len())
    );
    // Common typo: a method chained on a string literal INSIDE a call, e.g.
    // `s("bd*4".fast(2))` — the quote closed too early; it should be
    // `s("bd*4").fast(2)` (chain on the pattern, not the string in the call).
    let hint = if quote_then_method(line) {
        "\n  hint: a method looks chained on a string INSIDE a call — did the quote close too \
         early? `s(\"bd*4\".fast(2))` should be `s(\"bd*4\").fast(2)`."
    } else {
        ""
    };
    format!("{caret}{hint}")
}

/// True when a line contains a closing `"` immediately followed by `.method` —
/// the tell-tale of `s("bd*4".fast(2))` (method chained on the string literal).
fn quote_then_method(line: &str) -> bool {
    let b = line.as_bytes();
    b.windows(2).enumerate().any(|(i, w)| {
        w[0] == b'"' && w[1] == b'.' && b.get(i + 2).is_some_and(u8::is_ascii_alphabetic)
    })
}

/// The combined quality gate: validate + silence lint + mix critique + (for
/// multi-section songs) form critique, in ONE call — cuts the
/// validate→critique→critique_form round-trip tax for full songs.
///
/// `code` is optional: omit to review the document currently in the editor
/// (avoids re-emitting a full song just to gate it). Identical code is served
/// from a per-run cache; a hard budget of
/// [`crate::state::MAX_REVIEWS_PER_RUN`] real reviews per user message stops
/// thrash loops.
fn tool_review_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let code = resolve_code_or_editor(input, state)?;
    let cycles = input["cycles"].as_u64().unwrap_or(8).min(64) as usize;
    let hash = code_hash(&code);

    // Cache hit / budget check. Do not call stamp_write_kind while holding the
    // agent_write lock — it re-locks the same mutex (non-reentrant → deadlock).
    let cache_or_budget: Option<(ToolOutcome, &str)> = {
        let w = state.agent_write.lock();
        if w.last_review_hash == Some(hash) {
            w.last_review_result.as_ref().map(|cached| {
                let mut o = cached.clone();
                o.summary = format!("cached review: {}", cached.summary);
                o.text.push_str(
                    "\n\n(cached — identical code to previous review; \
                     call play_pattern with no code to play it, or edit then re-review.)",
                );
                (o, "review_cache")
            })
        } else if w.review_calls >= crate::state::MAX_REVIEWS_PER_RUN {
            Some((
                ToolOutcome::failed(
                    ToolCategory::BudgetExhausted,
                    format!(
                        "Review budget used ({}/{} this request). Fix from the prior review's \
                         warns, then call play_pattern (omit code to play the last reviewed \
                         buffer) or upsert_track for a surgical edit. Do not re-review.",
                        crate::state::MAX_REVIEWS_PER_RUN,
                        crate::state::MAX_REVIEWS_PER_RUN,
                    ),
                ),
                "review_budget",
            ))
        } else {
            None
        }
    };
    if let Some((early, kind)) = cache_or_budget {
        state.stamp_write_kind(kind);
        return Ok(early);
    }

    let result = review_code(&code, cycles, state);
    state.stamp_write_kind("review");

    // Count every non-cached attempt against the budget, and cache successful
    // (parseable) reviews so play_pattern can reuse the buffer without a second
    // full-document generation from the model.
    {
        let mut w = state.agent_write.lock();
        w.review_calls += 1;
        w.last_review_hash = Some(hash);
        w.last_review_result = Some(result.clone());
        if result.ok {
            w.last_reviewed_code = Some(code);
        }
    }
    Ok(result)
}

/// Core review pipeline — pure-ish (needs state only for the sound catalog).
/// Shared by `review_pattern` and the built-in play gate. The envelope's
/// `warnings` are every finding the report printed, so callers never re-parse
/// the report text.
pub(crate) fn review_code(code: &str, cycles: usize, state: &AppState) -> ToolOutcome {
    match strudel::review_report(code, cycles, &crate::sounds::known_sound_set(state)) {
        strudel::ReviewOutcome::Invalid(e) => ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error and review again.",
                error_context(code, &e)
            ),
        ),
        strudel::ReviewOutcome::Report {
            mut text,
            findings: found,
        } => {
            let warns = found.iter().filter(|f| f.severity == "warn").count();
            let summary = if warns == 0 {
                "review: ready to play".to_string()
            } else {
                format!("review: {warns} warning(s)")
            };
            text.push_str(&if warns == 0 {
                "\nVERDICT: ready to play. Call play_pattern with no code to play this buffer."
                    .to_string()
            } else {
                format!(
                    "\nVERDICT: {warns} warning(s) — fix the warns, then play \
                     (play_pattern with no code reuses this buffer after a clean re-review)."
                )
            });
            ToolOutcome::ok(summary, text).with_warnings(findings(&found))
        }
    }
}

/// Render the pattern offline and measure it — the agent's ears. The render
/// is CPU-bound (mix + every stem), so it runs on a blocking thread; the
/// envelope carries the full report as `data` and its findings as warnings.
async fn tool_hear_pattern(input: &serde_json::Value, state: &AppState) -> ToolResult {
    // Explicit code → last reviewed buffer → current editor, like play_pattern.
    let code = if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        c.to_string()
    } else if let Some(c) = state.last_reviewed_code() {
        c
    } else {
        current_document(state).map_err(|_| {
            ToolErr::precondition(
                "Nothing to hear: pass `code`, review a pattern first, or play one so it is in \
                 the editor.",
            )
        })?
    };

    let Some(samples) = state.sample_paths.lock().clone() else {
        return Err(ToolErr::precondition(
            "No sample set is resolved for offline rendering yet — the active set is not \
             downloaded. The user can pick or download one in the Samples manager.",
        ));
    };

    {
        let mut w = state.agent_write.lock();
        if w.hear_calls >= crate::state::MAX_HEARS_PER_RUN {
            return Ok(ToolOutcome::failed(
                ToolCategory::BudgetExhausted,
                format!(
                    "Hear budget used ({}/{} this request). Act on the last measurement — fix \
                     the mix surgically and play it; do not render again.",
                    crate::state::MAX_HEARS_PER_RUN,
                    crate::state::MAX_HEARS_PER_RUN,
                ),
            ));
        }
        w.hear_calls += 1;
    }

    // Fail as the review would on code that does not evaluate, before paying
    // for a render.
    if let Err(e) = strudel::Evaluated::new(&code, 1) {
        return Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "INVALID: {e}{}\n\nFix the error (review_pattern) before hearing it.",
                error_context(&code, &e)
            ),
        ));
    }

    let opts = cycletron_render::HearOptions {
        cycles: input["cycles"].as_u64().map(|n| n as usize),
        stems: input["stems"].as_bool().unwrap_or(true),
        bpm: Some(state.session.lock().tempo),
        ..cycletron_render::HearOptions::default()
    };
    let report = tokio::task::spawn_blocking(move || cycletron_render::hear(&code, &samples, opts))
        .await
        .map_err(|e| ToolErr::io(format!("render task failed: {e}")))?
        .map_err(ToolErr::io)?;

    let summary = format!(
        "mix: {} · {} cycle(s), {:.1} s{} · {} ms",
        report.verdict,
        report.cycles,
        report.seconds,
        if report.stems.is_empty() {
            String::new()
        } else {
            format!(", {} stems", report.stems.len())
        },
        report.render_ms,
    );
    let warnings = findings(&report.findings);
    let data = serde_json::to_value(&report).map_err(ToolErr::io)?;
    Ok(
        ToolOutcome::ok(summary, cycletron_render::report_to_text(&report))
            .with_warnings(warnings)
            .with_data(data),
    )
}

fn tool_inspect_pattern(input: &serde_json::Value) -> ToolResult {
    let code = req_str(input, "code")?;
    let cycles = opt_usize(input, "cycles", 8);
    // "auto": full event log for short windows, summary for long forms (a
    // 64-cycle dump is thousands of lines nobody can scan).
    let verbosity = input["verbosity"].as_str().unwrap_or("auto");
    let want_events = match verbosity {
        "events" => true,
        "summary" => false,
        _ => cycles <= 4,
    };

    match strudel::Evaluated::new(code, cycles) {
        Ok(ev) if !want_events => Ok(ToolOutcome::ok(
            format!("digest summary, {cycles} cycles"),
            strudel::digest_to_summary(ev.digest()),
        )),
        Ok(ev) => Ok(ToolOutcome::ok(
            format!("event log, {cycles} cycles"),
            strudel::digest_to_text(ev.digest()),
        )),
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not inspect — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and inspect again."
            ),
        )),
    }
}

fn tool_analyze_arrangement(input: &serde_json::Value) -> ToolResult {
    let code = req_str(input, "code")?;
    let max_cycles = opt_usize(input, "max_cycles", 32);

    match strudel::Evaluated::new(code, max_cycles) {
        Ok(ev) => {
            let a = strudel::analyze(&ev);
            Ok(ToolOutcome::ok(
                format!("{} section(s)", a.sections.len()),
                strudel::analyze_to_text(&a),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not analyze — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and analyze again."
            ),
        )),
    }
}

fn tool_critique_pattern(input: &serde_json::Value) -> ToolResult {
    let code = req_str(input, "code")?;
    let cycles = opt_usize(input, "cycles", 16);

    match strudel::Evaluated::new(code, cycles.max(4)) {
        Ok(ev) => {
            let c = strudel::critique(&ev);
            Ok(critique_outcome(
                "mix critique",
                &c.findings,
                strudel::critique_to_text(&c),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not critique — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and critique again."
            ),
        )),
    }
}

/// A critique as an envelope: its findings become `warnings`, the summary
/// counts the warns.
fn critique_outcome(what: &str, found: &[strudel::Finding], text: String) -> ToolOutcome {
    let warns = found.iter().filter(|f| f.severity == "warn").count();
    let summary = if warns == 0 {
        format!("{what}: clean")
    } else {
        format!("{what}: {warns} warning(s)")
    };
    ToolOutcome::ok(summary, text).with_warnings(findings(found))
}

fn tool_critique_form(input: &serde_json::Value) -> ToolResult {
    let code = req_str(input, "code")?;
    let cycles = opt_usize(input, "cycles", 32);

    match strudel::Evaluated::new(code, cycles.clamp(8, 64)) {
        Ok(ev) => {
            let c = strudel::critique_form(&ev);
            Ok(critique_outcome(
                "form critique",
                &c.findings,
                strudel::form_critique_to_text(&c),
            ))
        }
        Err(e) => Ok(ToolOutcome::failed(
            ToolCategory::InvalidCode,
            format!(
                "Could not critique the form — the code did not evaluate: {e}\n\nFix it (try validate_pattern) and try again."
            ),
        )),
    }
}

fn tool_genre_recipe(input: &serde_json::Value, state: &AppState) -> ToolResult {
    let recipes = state.recipes.lock();
    if recipes.is_empty() {
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            "No genre recipes are loaded yet (corpus/genres/ is empty).",
        ));
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
        return Ok(ToolOutcome::ok(
            format!("{} recipe(s) available", recipes.len()),
            s,
        ));
    }

    let matches: Vec<_> = recipes.iter().filter(|r| r.matches(query)).collect();
    if matches.is_empty() {
        let names: Vec<&str> = recipes.iter().map(|r| r.genre.as_str()).collect();
        return Ok(ToolOutcome::failed(
            ToolCategory::NotFound,
            format!(
                "No recipe matches '{query}'. Available: {}.",
                names.join(", ")
            ),
        ));
    }
    let names: Vec<&str> = matches.iter().map(|r| r.genre.as_str()).collect();
    Ok(ToolOutcome::ok(
        format!("recipe: {}", names.join(", ")),
        matches
            .iter()
            .map(|r| format_recipe(r))
            .collect::<Vec<_>>()
            .join("\n\n---\n\n"),
    ))
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
) -> ToolResult {
    // Prefer explicit code → last reviewed buffer → current editor.
    // Omitting code after a successful review is the fast path: the model does
    // not re-stream a full multi-KB song just to commit what it already gated.
    let (raw, reused) = if let Some(c) = input["code"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        (c.to_string(), false)
    } else if let Some(c) = state.last_reviewed_code() {
        state.stamp_write_kind("reuse");
        (c, true)
    } else if let Ok(c) = current_document(state) {
        state.stamp_write_kind("reuse");
        (c, true)
    } else {
        return Err(ToolErr::precondition(
            "play_pattern needs `code`, or a prior successful review_pattern, or a song \
             already in the editor.",
        ));
    };

    // Latency guard (telemetry: list_sections → full 34k play ×2 ≈ 9 min).
    // After the agent listed structure, a full-document rewrite is almost
    // always wrong — use upsert_section / upsert_track. Escape: force: true.
    let force = input
        .get("force")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !reused
        && !force
        && state.listed_structure()
        && raw.len() >= crate::state::FULL_REWRITE_GUARD_CHARS
        && current_document(state)
            .map(|d| d.len() > 200)
            .unwrap_or(false)
    {
        state.stamp_write_kind("full_blocked");
        let secs =
            cycletron_doc::sections::list_sections(&current_document(state).unwrap_or_default());
        let hint = if secs.is_empty() {
            "upsert_track / upsert_tracks (or list_parts first)".to_string()
        } else {
            format!(
                "upsert_section / upsert_sections on: {}",
                secs.iter()
                    .take(12)
                    .map(|s| s.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        return Ok(ToolOutcome::failed(
            ToolCategory::PolicyBlocked,
            format!(
                "NOT PLAYED — full rewrite blocked after list_sections/list_parts in this \
                 request ({code_chars} chars). Streaming the whole song again is the #1 \
                 latency footgun.\n\
                 Edit surgically with {hint}.\n\
                 Only if you truly must replace the entire arrangement, call play_pattern \
                 again with the same code AND force: true.",
                code_chars = raw.len(),
                hint = hint,
            ),
        ));
    }

    // Optional built-in gate: one generation + server-side review, no second tool.
    // Default true for multi-section / large docs; false when the model opts out
    // with review:false (already gated this request).
    let want_review = match input.get("review") {
        Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
        _ => {
            raw.contains("pickRestart")
                || raw.contains("arrange")
                || raw.len() > 2_000
                || raw.lines().count() > 40
        }
    };

    let mut gate_note = String::new();
    let mut gate_warnings: Vec<ToolFinding> = Vec::new();
    if want_review {
        let cycles = input["cycles"].as_u64().unwrap_or(8).min(64) as usize;
        let report = review_code(&raw, cycles, state);
        if !report.ok {
            let mut msg = format!(
                "NOT PLAYED — built-in review failed, so nothing changed.\n{}",
                report.text
            );
            if report.text.contains("Arrow functions") || raw.contains("=>") {
                msg.push_str(
                    "\n\nHint: free-standing `const f = x => …` helpers are not valid \
                     top-level strudel. Inline the chain (`.s(\"supersaw\").gain(…)`) \
                     on each note/stack, or use only method callbacks like \
                     `.every(2, x => x.fast(2))`. Do NOT re-emit a second full song — \
                     fix the arrow footgun in a surgical edit if possible.",
                );
            }
            return Ok(ToolOutcome::failed(ToolCategory::NotApplied, msg));
        }
        // Stash as last-reviewed so a later play_pattern() reuses it.
        {
            let mut w = state.agent_write.lock();
            w.last_review_hash = Some(code_hash(&raw));
            w.last_review_result = Some(report.clone());
            w.last_reviewed_code = Some(raw.clone());
        }
        // Compact the gate for the tool result (full report can be huge): the
        // digest line, a verdict, and the first few warns — from the envelope,
        // not re-parsed out of the report text.
        let digest = report
            .text
            .lines()
            .find(|l| l.trim_start().starts_with("bpm "))
            .unwrap_or("")
            .trim();
        let warns: Vec<&ToolFinding> = report
            .warnings
            .iter()
            .filter(|w| w.severity == "warn")
            .collect();
        gate_note = format!("\n[built-in review] {digest}\n");
        if warns.is_empty() {
            gate_note.push_str("VERDICT: ready to play.");
        } else {
            gate_note.push_str(&format!(
                "VERDICT: {} warning(s) — fix the warns, then play.\nWarnings:",
                warns.len()
            ));
            for w in warns.iter().take(6) {
                gate_note.push_str(&format!("\n  [{}] {}: {}", w.severity, w.code, w.message));
            }
        }
        gate_warnings = report.warnings;
    }

    let lead = if reused {
        "Pattern sent to editor for playback (reused last reviewed / current buffer — no code re-emitted)."
    } else {
        state.stamp_write_kind("full");
        "Pattern sent to editor for playback."
    };
    let mut out = apply_document(state, event_tx, &raw, lead)?;
    if out.ok {
        out.text.push_str(&gate_note);
        // The gate's critique findings join the commit's silence lint;
        // silence-lint findings the review also ran are deduplicated.
        for w in gate_warnings {
            if !out.warnings.contains(&w) {
                out.warnings.push(w);
            }
        }
        let warns = out.warnings.iter().filter(|w| w.severity == "warn").count();
        if warns > 0 {
            out.summary = format!("playing, {warns} warning(s)");
        }
    }
    Ok(out)
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
) -> ToolResult {
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
    let evaluated = match strudel::Evaluated::new(&code, 4) {
        Ok(ev) => ev,
        Err(e) => {
            return Ok(ToolOutcome::failed(
                ToolCategory::NotApplied,
                format!(
                    "NOT APPLIED — the resulting pattern does not evaluate, so nothing changed.\n\
                     INVALID: {e}{}{repair_summary}\n\nFix the error and try again.",
                    error_context(&code, &e),
                ),
            )
            .with_repairs(notes));
        }
    };

    // 3. Silence lint (advisory): valid syntax, but audibly-dead layers —
    //    invented sounds, unvoiced chords, out-of-range pan. Surface, don't block.
    let mut lint = strudel::lint_source(&code);
    lint.extend(strudel::lint_digest(evaluated.digest(), &known));
    let warns: Vec<_> = lint.iter().filter(|f| f.severity == "warn").collect();

    // 4. Commit the repaired code: store it and inject into the WASM REPL.
    {
        let mut session = state.session.lock();
        session.set_pattern(code.clone());
        session.playback = PlaybackState::Playing;
    }
    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__set_code_and_play".to_string(),
        payload: code.clone(),
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
    let mut summary = lead
        .split_once(" (")
        .map_or(lead, |(head, _)| head)
        .trim_end_matches('.')
        .to_string();
    if !warns.is_empty() {
        summary.push_str(&format!(", {} silent-layer warning(s)", warns.len()));
    }
    if !notes.is_empty() {
        summary.push_str(&format!(", {} repair(s)", notes.len()));
    }
    Ok(ToolOutcome::ok(summary, msg)
        .with_warnings(findings(&lint))
        .with_repairs(notes))
}

/// The document currently in the editor/session, or a friendly error when there
/// is nothing to edit yet.
fn current_document(state: &AppState) -> Result<String, ToolErr> {
    state.session.lock().current_pattern.clone().ok_or_else(|| {
        ToolErr::precondition(
            "There's no song in the editor yet. Use play_pattern to start one, then edit its \
             tracks with upsert_track / mute_track.",
        )
    })
}

/// List the addressable tracks of the current song (read-only; no playback).
fn tool_list_parts(state: &AppState) -> ToolResult {
    state.mark_listed_structure();
    let code = current_document(state)?;
    let parts = cycletron_doc::tracks::list_tracks(&code);
    if parts.is_empty() {
        return Ok(ToolOutcome::ok(
            "no tracks",
            "The current document has no tracks yet.",
        ));
    }
    let mut out = format!("{} track(s) in the current song:\n", parts.len());
    for p in &parts {
        let handle = match &p.id {
            Some(id) => format!("@{id}"),
            None => format!("#{} (no id — address by index)", p.index),
        };
        let muted = if p.muted { " [MUTED]" } else { "" };
        out.push_str(&format!(
            "  {}. {}{}  —  {}\n",
            p.index, handle, muted, p.preview
        ));
    }
    out.push_str(
        "\nEdit one with upsert_track {id, code}; batch with upsert_tracks; \
         silence with mute_track {id}. For pickRestart songs use list_sections / upsert_section.",
    );
    Ok(ToolOutcome::ok(format!("{} track(s)", parts.len()), out))
}

/// List named sections of a pickRestart/arrange song (read-only).
fn tool_list_sections(state: &AppState) -> ToolResult {
    state.mark_listed_structure();
    let code = current_document(state)?;
    let secs = cycletron_doc::sections::list_sections(&code);
    if secs.is_empty() {
        return Ok(ToolOutcome::ok(
            "no sections",
            "No section object found (const sections = {…} or pickRestart/arrange). \
             For `$:` tracks use list_parts / upsert_track.",
        ));
    }
    let mut out = format!("{} section(s) in the current arrangement:\n", secs.len());
    for s in &secs {
        out.push_str(&format!(
            "  {}. @{}  (lines {}–{})  —  {}\n",
            s.index,
            s.id,
            s.start_line + 1,
            s.end_line,
            s.preview
        ));
    }
    out.push_str(
        "\nEdit surgically with upsert_section {id, code} or upsert_sections — \
         do NOT play_pattern the whole song after listing. `code` is only that \
         section's expression (no `drop1:`, no full document). Full rewrite after \
         this call is blocked unless force: true.",
    );
    Ok(ToolOutcome::ok(format!("{} section(s)", secs.len()), out))
}

/// Add or replace one track, then hot-swap. Only the target track's text changes.
fn tool_upsert_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    let (new_code, wrote) = cycletron_doc::tracks::upsert_track(&code, id, expr)?;
    state.stamp_write_kind("track");
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Track @{wrote} updated (other tracks unchanged)."),
    )
}

/// Batch track upserts in one apply (one LLM round-trip for multi-part rebuilds).
fn tool_upsert_tracks(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let patches = parse_id_code_patches(input)?;
    let code = current_document(state).unwrap_or_default();
    let (new_code, wrote) = cycletron_doc::tracks::upsert_tracks(&code, &patches)?;
    state.stamp_write_kind("track");
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!(
            "{} track(s) updated: {}.",
            wrote.len(),
            wrote
                .iter()
                .map(|id| format!("@{id}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )
}

/// Replace one pickRestart/arrange section, then hot-swap.
fn tool_upsert_section(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    let (new_code, wrote) = cycletron_doc::sections::upsert_section(&code, id, expr)?;
    state.stamp_write_kind("section");
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Section @{wrote} updated (other sections unchanged)."),
    )
}

/// Batch section upserts in one apply.
fn tool_upsert_sections(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let patches = parse_id_code_patches(input)?;
    let code = current_document(state)?;
    let (new_code, wrote) = cycletron_doc::sections::upsert_sections(&code, &patches)?;
    state.stamp_write_kind("section");
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!(
            "{} section(s) updated: {}.",
            wrote.len(),
            wrote
                .iter()
                .map(|id| format!("@{id}"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    )
}

/// Replace one top-level const/let binding body (a shared helper — gain bus,
/// synth def, drum kit), then hot-swap. Only that binding's expression changes.
fn tool_upsert_binding(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let name = req_str(input, "name")?;
    let expr = req_str(input, "code")?;
    let code = current_document(state)?;
    let (new_code, wrote) = cycletron_doc::structure::upsert_binding(&code, name, expr)?;
    state.stamp_write_kind("binding");
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Binding `{wrote}` updated (rest of the document unchanged)."),
    )
}

/// Parse `{ patches: [{id, code}, ...] }` or a single `{id, code}`.
fn parse_id_code_patches(input: &serde_json::Value) -> Result<Vec<(String, String)>, ToolErr> {
    if let Some(arr) = input.get("patches").and_then(|v| v.as_array()) {
        let mut out = Vec::with_capacity(arr.len());
        for (i, p) in arr.iter().enumerate() {
            let id = p["id"]
                .as_str()
                .ok_or_else(|| ToolErr::bad_argument(format!("patches[{i}]: missing 'id'")))?
                .to_string();
            let code = p["code"]
                .as_str()
                .ok_or_else(|| ToolErr::bad_argument(format!("patches[{i}]: missing 'code'")))?
                .to_string();
            out.push((id, code));
        }
        if out.is_empty() {
            return Err(ToolErr::bad_argument("patches array is empty"));
        }
        return Ok(out);
    }
    // Single-object sugar: {id, code} treated as one patch.
    if let (Some(id), Some(code)) = (input["id"].as_str(), input["code"].as_str()) {
        return Ok(vec![(id.to_string(), code.to_string())]);
    }
    Err(ToolErr::bad_argument(
        "expected { patches: [{id, code}, ...] } or {id, code}",
    ))
}

/// Mute one track (comment it out), then hot-swap.
fn tool_mute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let code = current_document(state)?;
    let new_code = cycletron_doc::tracks::mute_track(&code, id)?;
    apply_document(state, event_tx, &new_code, &format!("Track '{id}' muted."))
}

/// Restore a muted track, then hot-swap.
fn tool_unmute_track(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let id = req_str(input, "id")?;
    let code = current_document(state)?;
    let new_code = cycletron_doc::tracks::unmute_track(&code, id)?;
    apply_document(
        state,
        event_tx,
        &new_code,
        &format!("Track '{id}' unmuted."),
    )
}

fn tool_stop(state: &AppState, event_tx: &mpsc::UnboundedSender<AgentEvent>) -> ToolResult {
    {
        let mut session = state.session.lock();
        session.playback = PlaybackState::Stopped;
    }

    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__stop_playback".to_string(),
        payload: String::new(),
    });
    Ok(ToolOutcome::ok("stopped", "stop command sent"))
}

fn tool_set_tempo(
    input: &serde_json::Value,
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> ToolResult {
    let bpm = input["bpm"]
        .as_f64()
        .ok_or_else(|| ToolErr::bad_argument("missing 'bpm' parameter"))?;

    {
        let mut session = state.session.lock();
        session.tempo = bpm;
    }

    let _ = event_tx.send(AgentEvent::UiAction {
        name: "__set_tempo".to_string(),
        payload: format!("{bpm}"),
    });
    Ok(ToolOutcome::ok(
        format!("tempo {bpm} BPM"),
        format!("tempo set to {bpm} BPM"),
    ))
}

/// Convert session ChatMessages to Claude API messages.
///
/// Assistant turns that called tools are expanded back into their structured
/// exchange — the assistant's `tool_use` blocks followed by a matching `user`
/// turn of `tool_result` blocks — so the model recalls what it already tried.
/// Without this, tool activity is lost to text-only history and the model
/// repeats itself. The system prompt is passed separately, so System messages
/// are skipped.
fn session_to_api_messages(messages: &[ChatMessage]) -> Vec<ApiMessage> {
    let mut out = Vec::new();
    for m in messages {
        let role = match m.role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::System => continue,
        };

        if role == "assistant" && !m.tools.is_empty() {
            // Rebuild the assistant turn: any prose, then each tool_use.
            let mut content = Vec::new();
            if !m.content.is_empty() {
                content.push(ContentBlock::Text {
                    text: m.content.clone(),
                });
            }
            for t in &m.tools {
                content.push(ContentBlock::ToolUse {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    input: t.input.clone(),
                });
            }
            out.push(ApiMessage {
                role: "assistant".to_string(),
                content,
            });

            // The paired user turn carrying every tool_result (order matches).
            let results = m
                .tools
                .iter()
                .map(|t| ContentBlock::ToolResult {
                    tool_use_id: t.id.clone(),
                    content: t.outcome.to_model_text(),
                    is_error: (!t.outcome.ok).then_some(true),
                })
                .collect();
            out.push(ApiMessage {
                role: "user".to_string(),
                content: results,
            });
        } else {
            out.push(ApiMessage {
                role: role.to_string(),
                content: vec![ContentBlock::Text {
                    text: m.content.clone(),
                }],
            });
        }
    }
    out
}

#[cfg(test)]
mod write_path_tests {
    use super::*;
    use serde_json::json;

    fn state_with_code(code: &str) -> AppState {
        let s = AppState::new();
        s.session.lock().set_pattern(code.to_string());
        s.reset_agent_write_run();
        s
    }

    fn sink() -> mpsc::UnboundedSender<AgentEvent> {
        let (tx, _rx) = mpsc::unbounded_channel();
        tx
    }

    #[test]
    fn review_without_code_uses_editor() {
        let s = state_with_code(r#"s("bd*4")"#);
        let out = tool_review_pattern(&json!({}), &s).unwrap();
        assert!(out.ok, "got: {out:?}");
        assert!(out.text.starts_with("REVIEW"), "got: {}", out.text);
        assert!(
            s.last_reviewed_code().as_deref() == Some(r#"s("bd*4")"#),
            "review should stash the buffer"
        );
    }

    #[test]
    fn review_cache_hits_on_identical_code() {
        let s = state_with_code(r#"s("bd*4")"#);
        let a = tool_review_pattern(&json!({"code": r#"s("bd*4")"#}), &s).unwrap();
        assert!(!a.text.contains("(cached"));
        let b = tool_review_pattern(&json!({"code": r#"s("bd*4")"#}), &s).unwrap();
        assert!(
            b.text.contains("(cached"),
            "second identical review should cache: {}",
            b.text
        );
        assert!(b.summary.starts_with("cached review"), "{}", b.summary);
        assert!(b.ok);
        // Cache hits must not burn the review budget.
        assert_eq!(s.agent_write.lock().review_calls, 1);
    }

    #[test]
    fn review_budget_blocks_third_distinct_review() {
        let s = AppState::new();
        s.reset_agent_write_run();
        let codes = [r#"s("bd*4")"#, r#"s("bd*8")"#, r#"s("hh*8")"#];
        for (i, code) in codes.iter().enumerate() {
            let out = tool_review_pattern(&json!({"code": code}), &s).unwrap();
            if i < 2 {
                assert!(
                    out.text.starts_with("REVIEW"),
                    "review {i} should run, got: {}",
                    out.text
                );
            } else {
                assert_eq!(
                    out.category,
                    Some(ToolCategory::BudgetExhausted),
                    "third review should hit budget, got: {out:?}"
                );
                assert!(!out.retryable);
                assert!(out.text.contains("Review budget used"));
            }
        }
        assert_eq!(s.agent_write.lock().review_calls, 2);
    }

    #[test]
    fn play_without_code_reuses_last_reviewed() {
        let s = AppState::new();
        s.reset_agent_write_run();
        let code = r#"s("bd*4").gain(0.8)"#;
        let rev = tool_review_pattern(&json!({"code": code}), &s).unwrap();
        assert!(rev.text.contains("VERDICT"), "{}", rev.text);

        let out = tool_play_pattern(&json!({}), &s, &sink()).unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            out.text.contains("reused") || out.text.contains("playback"),
            "play with no code should reuse: {}",
            out.text
        );
        assert_eq!(s.session.lock().current_pattern.as_deref(), Some(code));
        assert_eq!(s.take_write_kind().as_deref(), Some("reuse"));
    }

    #[test]
    fn play_with_code_stamps_full() {
        let s = AppState::new();
        let out = tool_play_pattern(&json!({"code": r#"s("sd*2")"#}), &s, &sink()).unwrap();
        assert!(out.ok, "{out:?}");
        assert!(out.text.contains("playback"), "{}", out.text);
        assert_eq!(out.to_model_text().lines().next(), Some("[result ok=true]"));
        // stamp may already be taken by a caller; stamp_write_kind sets pending
        // — tool_play_pattern stamps "full" for explicit code.
        // We already consumed nothing; pending should be "full".
        assert_eq!(s.take_write_kind().as_deref(), Some("full"));
    }

    #[test]
    fn model_output_chars_proxy_drops_on_reuse_path() {
        // Proxy for LLM cost: when play reuses the reviewed code (omits its own),
        // a review→play turn emits the song once, not twice.
        let song = r#"s("bd*4")"#.repeat(500); // ~4k chars
        let legacy_emit = song.len() * 2; // review + play both with code
        let fast_emit = song.len(); // review only; play reuses
        assert!(fast_emit * 2 == legacy_emit);
        assert_eq!(fast_emit, legacy_emit / 2);
    }

    #[test]
    fn section_upsert_beats_full_rewrite_on_chars() {
        let song =
            std::fs::read_to_string("/tmp/cycletron-bench-song.strudel").unwrap_or_else(|_| {
                r#"
"<intro@1 drop1@2>".slow(4).pickRestart({
  intro: stack(s("bd*4")),
  drop1: stack(s("bd*4").gain(1.0), s("sd*2"))
})
"#
                .into()
            });
        let secs = cycletron_doc::sections::list_sections(&song);
        assert!(
            !secs.is_empty(),
            "bench song should parse as pickRestart sections"
        );
        let drop = secs
            .iter()
            .find(|s| s.id == "drop1")
            .expect("drop1 section");
        let section_body = &song[drop.expr_start..drop.expr_end];
        // Surgical path emits ~section size; legacy re-emits whole song twice.
        let surgical = section_body.len();
        let legacy = song.len() * 2;
        assert!(
            surgical * 5 < legacy,
            "section upsert should be >>5× smaller emit than full review+play \
             (section={surgical}, legacy={legacy})"
        );
    }

    #[test]
    fn play_with_builtin_review_blocks_invalid() {
        let s = AppState::new();
        // Truly un-evaluable: unclosed call + junk method.
        let out = tool_play_pattern(
            &json!({"code": "s(\"bd*4\").nope(((", "review": true}),
            &s,
            &sink(),
        )
        .unwrap();
        assert_eq!(
            out.category,
            Some(ToolCategory::NotApplied),
            "invalid code must not play: {out:?}"
        );
        assert!(out.retryable);
        assert!(out.text.starts_with("NOT PLAYED"), "{}", out.text);
        assert!(s.session.lock().current_pattern.is_none());
    }

    #[test]
    fn play_with_silent_layer_carries_structured_warnings() {
        let s = AppState::new();
        // `nope` is not a sound → the silence lint warns, but the pattern
        // still plays (advisory). The warn must be in the envelope, not only
        // in the prose.
        let out = tool_play_pattern(
            &json!({"code": r#"stack(s("bd*4"), s("nope*2"))"#, "review": false}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            out.warnings.iter().any(|w| w.severity == "warn"),
            "expected a silence-lint warn in the envelope: {out:?}"
        );
        assert!(out.summary.contains("warning"), "{}", out.summary);
        assert!(out.to_model_text().starts_with("[result ok=true warnings="));
    }

    #[test]
    fn repairs_are_reported_structurally() {
        let s = AppState::new();
        // A fenced pattern is mechanically repaired before it plays.
        let out = tool_play_pattern(
            &json!({"code": "```js\ns(\"bd*4\")\n```", "review": false}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(
            !out.repairs.is_empty(),
            "fence removal should be a repair: {out:?}"
        );
        assert_eq!(
            s.session.lock().current_pattern.as_deref(),
            Some("s(\"bd*4\")")
        );
    }

    #[test]
    fn hard_failures_are_classified() {
        let s = AppState::new();
        // Nothing in the editor → precondition, not a generic error.
        let e = tool_list_parts(&s).unwrap_err();
        assert_eq!(e.category, ToolCategory::Precondition);
        let e = tool_upsert_track(&json!({"id": "x"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::BadArgument);
        assert!(e.message.contains("'code'"));

        let s = state_with_code(r#"$: s("bd*4") // @drums"#);
        let e = tool_mute_track(&json!({"id": "lead"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::NotFound);
        assert!(e.message.contains("@drums"));
        let e = tool_upsert_section(&json!({"id": "a", "code": "x"}), &s, &sink()).unwrap_err();
        assert_eq!(e.category, ToolCategory::Precondition);
        s.library.lock().root = std::env::temp_dir();
        let e = tool_read_song(&json!({"path": "/etc/passwd"}), &s).unwrap_err();
        assert_eq!(e.category, ToolCategory::PathDenied);
        assert!(!e.into_outcome().retryable);
    }

    #[test]
    fn full_play_blocked_after_list_sections_unless_force() {
        let song = r#"setbpm(120);
const sections = {
  intro: stack(s("bd*4").gain(0.5)),
  drop1: stack(s("bd*4").gain(0.9), s("sd*2")),
  outro: note("c2").s("sine")
};
$: "<intro@1 drop1@2 outro@1>".slow(4).pickRestart({
  intro: sections.intro, drop1: sections.drop1, outro: sections.outro
})
"#;
        // Pad so full rewrite exceeds FULL_REWRITE_GUARD_CHARS.
        let song = format!("{song}\n// {}\n", "x".repeat(4_200));
        let s = state_with_code(&song);
        let listed = tool_list_sections(&s).unwrap();
        assert_eq!(listed.summary, "3 section(s)");
        assert!(listed.text.contains("@drop1"), "{}", listed.text);
        assert!(
            listed.text.contains("stack") || listed.text.contains("bd"),
            "fat preview: {}",
            listed.text
        );

        let big = format!("{song}\n// rewrite attempt\n");
        assert!(big.len() >= crate::state::FULL_REWRITE_GUARD_CHARS);
        let blocked =
            tool_play_pattern(&json!({"code": big, "review": false}), &s, &sink()).unwrap();
        assert_eq!(
            blocked.category,
            Some(ToolCategory::PolicyBlocked),
            "expected full rewrite block, got: {blocked:?}"
        );
        assert!(blocked.retryable, "the model may retry with force:true");
        assert!(blocked.text.contains("force: true"), "{}", blocked.text);
        assert_eq!(s.take_write_kind().as_deref(), Some("full_blocked"));

        let forced = tool_play_pattern(
            &json!({"code": &song, "review": false, "force": true}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(forced.ok, "force:true must allow play: {forced:?}");
    }

    #[test]
    fn list_and_upsert_section_roundtrip() {
        let song = r#"
setbpm(120);
"<a@1 b@1>".slow(2).pickRestart({
  a: s("bd*4"),
  b: s("sd*2")
})
"#;
        let s = state_with_code(song);
        let listed = tool_list_sections(&s).unwrap();
        assert!(listed.text.contains("@a"), "{}", listed.text);
        assert!(listed.text.contains("@b"), "{}", listed.text);

        let out = tool_upsert_section(
            &json!({"id": "b", "code": r#"s("hh*8").gain(0.5)"#}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert_eq!(out.summary, "Section @b updated");
        assert!(out.text.contains("Section @b"), "{}", out.text);
        let doc = s.session.lock().current_pattern.clone().unwrap();
        assert!(doc.contains(r#"b: s("hh*8").gain(0.5)"#));
        assert!(doc.contains(r#"a: s("bd*4")"#));
    }

    #[test]
    fn upsert_binding_replaces_helper_const() {
        let song = r#"setbpm(120);
const lead = note("c e g").s("sawtooth").gain(0.6);
$: lead.slow(2)
"#;
        let s = state_with_code(song);
        let out = tool_upsert_binding(
            &json!({"name": "lead", "code": r#"note("a c e").s("square")"#}),
            &s,
            &sink(),
        )
        .unwrap();
        assert!(out.ok, "{out:?}");
        assert!(out.text.contains("Binding `lead`"), "{}", out.text);
        let doc = s.session.lock().current_pattern.clone().unwrap();
        // Only the binding body changed; the track and directive are intact.
        assert!(
            doc.contains(r#"const lead = note("a c e").s("square");"#),
            "{doc}"
        );
        assert!(doc.contains("$: lead.slow(2)"));
        assert!(doc.contains("setbpm(120);"));
        assert!(!doc.contains("sawtooth"));
    }

    /// Local wall-time + emit-size bench (no LLM). Run with:
    ///   cargo test -p cycletron-app write_path_bench -- --nocapture --ignored
    #[test]
    #[ignore = "manual bench — needs /tmp/cycletron-bench-song.strudel"]
    fn write_path_bench() {
        use std::time::Instant;
        let song = std::fs::read_to_string("/tmp/cycletron-bench-song.strudel")
            .expect("export session song to /tmp/cycletron-bench-song.strudel first");
        let s = AppState::new();
        let secs = cycletron_doc::sections::list_sections(&song);
        eprintln!("=== write-path bench ===");
        eprintln!(
            "song: {} chars, {} lines, {} sections",
            song.len(),
            song.lines().count(),
            secs.len()
        );

        let t0 = Instant::now();
        let report = review_code(&song, 8, &s);
        let review_ms = t0.elapsed().as_millis();
        eprintln!(
            "review_code (8 cyc): {review_ms} ms  verdict={}",
            report.text.lines().last().unwrap_or("")
        );

        let t1 = Instant::now();
        let _ = cycletron_doc::sections::list_sections(&song);
        eprintln!("list_sections: {} µs", t1.elapsed().as_micros());

        if let Some(drop) = secs.iter().find(|x| x.id == "drop1") {
            let body = &song[drop.expr_start..drop.expr_end];
            let t2 = Instant::now();
            let (new_doc, _) =
                cycletron_doc::sections::upsert_section(&song, "drop1", body).unwrap();
            eprintln!(
                "upsert_section(drop1) same body: {} µs  (emit proxy: section={} vs full×2={})",
                t2.elapsed().as_micros(),
                body.len(),
                song.len() * 2
            );
            assert_eq!(new_doc, song, "identity upsert should be byte-identical");
        }

        // Model-output proxy for the last song's 4-turn session shape.
        let legacy_edit = song.len() * 2; // review+play full
        let reuse_edit = song.len(); // review full, play()
        let section_edit = secs
            .iter()
            .find(|x| x.id == "drop1")
            .map(|d| d.expr_end - d.expr_start)
            .unwrap_or(500);
        eprintln!("emit-size proxy (chars the model must stream):");
        eprintln!("  legacy review+play:     {legacy_edit}");
        eprintln!(
            "  review + play reuse:    {reuse_edit}  (−{}%)",
            100 - 100 * reuse_edit / legacy_edit
        );
        eprintln!(
            "  upsert_section(drop1):  {section_edit}  (−{}%)",
            100 - 100 * section_edit / legacy_edit
        );
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn defs() -> &'static [ToolDefinition] {
        cycletron_agent::tools::music_tool_definitions()
    }

    #[test]
    fn recovers_a_fenced_text_tool_call() {
        // A small local model emitting a fenced JSON tool call as text instead
        // of a native tool_use block — the case recover_text_tool_calls exists for.
        let text = "Sure, let's play it:\n```json\n{\n  \"name\": \"play_pattern\",\n  \
                    \"arguments\": { \"code\": \"s(\\\"bd*4\\\")\" }\n}\n```";
        let mut content = vec![ContentBlock::Text {
            text: text.to_string(),
        }];
        recover_text_tool_calls(&mut content, defs());
        let call = content.iter().find_map(|b| match b {
            ContentBlock::ToolUse { name, input, .. } => Some((name.clone(), input.clone())),
            _ => None,
        });
        let (name, input) = call.expect("should recover a tool call");
        assert_eq!(name, "play_pattern");
        assert_eq!(input["code"], "s(\"bd*4\")");
    }

    #[test]
    fn recovers_function_wrapped_and_stringified_args() {
        let text =
            r#"{"function": {"name": "save_current_as", "arguments": "{\"name\": \"dub\"}"}}"#;
        let mut content = vec![ContentBlock::Text {
            text: text.to_string(),
        }];
        recover_text_tool_calls(&mut content, defs());
        let ok = content.iter().any(|b| {
            matches!(b, ContentBlock::ToolUse { name, input, .. }
            if name == "save_current_as" && input["name"] == "dub")
        });
        assert!(ok, "got: {content:?}");
    }

    #[test]
    fn leaves_prose_and_native_calls_alone() {
        // Plain prose → no tool call invented.
        let mut prose = vec![ContentBlock::Text {
            text: "Here's a nice house groove!".into(),
        }];
        recover_text_tool_calls(&mut prose, defs());
        assert!(
            !prose
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        );
        // Unknown tool name in text → ignored.
        let mut bogus = vec![ContentBlock::Text {
            text: r#"{"name": "delete_everything", "arguments": {}}"#.into(),
        }];
        recover_text_tool_calls(&mut bogus, defs());
        assert!(
            !bogus
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        );
    }
}

#[cfg(test)]
mod generator_inference_tests {
    use super::infer_generator;
    use serde_json::json;

    #[test]
    fn infers_generator_from_the_param_present() {
        // The failure the local-model eval caught: genre set, discriminator omitted.
        assert_eq!(infer_generator(&json!({"genre": "acid-house"})), "genre");
        assert_eq!(infer_generator(&json!({"hex": "a4f2"})), "hexbeat");
        assert_eq!(infer_generator(&json!({"motif": "c4 e4 g4"})), "palindrome");
        assert_eq!(infer_generator(&json!({"numerals": "ii V I"})), "numerals");
        assert_eq!(infer_generator(&json!({"rule": 90})), "automaton");
        assert_eq!(infer_generator(&json!({"count": 16})), "infinity");
        // explicit discriminator still wins; empty defaults to genre.
        assert_eq!(infer_generator(&json!({"generator": "hexbeat"})), "hexbeat");
        assert_eq!(infer_generator(&json!({})), "genre");
    }
}

#[cfg(test)]
mod session_history_tests {
    use super::*;
    use chrono::Utc;
    use cycletron_core::types::{ToolCategory, ToolOutcome, ToolTrace};
    use serde_json::json;

    fn chat(role: ChatRole, content: &str, tools: Vec<ToolTrace>) -> ChatMessage {
        ChatMessage {
            id: "m".to_string(),
            role,
            content: content.to_string(),
            timestamp: Utc::now(),
            tools,
        }
    }

    #[test]
    fn tool_turns_replay_as_structured_exchange() {
        // An assistant turn that called a tool must come back as the assistant
        // tool_use + a paired user tool_result — otherwise the model forgets
        // what it already did (the #2 amnesia bug).
        let history = vec![
            chat(ChatRole::User, "make a house beat", vec![]),
            chat(
                ChatRole::Assistant,
                "Here you go",
                vec![ToolTrace {
                    id: "call_1".into(),
                    name: "play_pattern".into(),
                    input: json!({ "code": "bd*4" }),
                    outcome: ToolOutcome::ok("playing", "playing"),
                    duration_ms: 3,
                }],
            ),
            chat(ChatRole::User, "louder", vec![]),
        ];

        let api = session_to_api_messages(&history);
        // user, assistant(text+tool_use), user(tool_result), user.
        assert_eq!(api.len(), 4);

        assert_eq!(api[1].role, "assistant");
        assert!(matches!(&api[1].content[0], ContentBlock::Text { text } if text == "Here you go"));
        match &api[1].content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "play_pattern");
                assert_eq!(input["code"], "bd*4");
            }
            other => panic!("expected tool_use, got {other:?}"),
        }

        assert_eq!(api[2].role, "user");
        match &api[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "call_1");
                // The envelope header survives replay so categories reach the
                // model on later turns too.
                assert_eq!(content, "[result ok=true]\nplaying");
                assert_eq!(*is_error, None);
            }
            other => panic!("expected tool_result, got {other:?}"),
        }

        assert_eq!(api[3].role, "user");
    }

    #[test]
    fn text_only_history_is_flat_and_system_is_skipped() {
        let history = vec![
            chat(ChatRole::System, "sys", vec![]),
            chat(ChatRole::User, "hi", vec![]),
            chat(ChatRole::Assistant, "hello", vec![]),
        ];
        let api = session_to_api_messages(&history);
        // System dropped (passed separately); two plain text turns remain.
        assert_eq!(api.len(), 2);
        assert_eq!(api[0].role, "user");
        assert_eq!(api[1].role, "assistant");
        assert!(matches!(&api[1].content[0], ContentBlock::Text { text } if text == "hello"));
    }

    #[test]
    fn errored_tool_and_toolless_prose_round_trip() {
        // Empty assistant prose + an errored tool: the assistant turn is just
        // the tool_use, and the result carries is_error = Some(true) plus the
        // failure header.
        let history = vec![chat(
            ChatRole::Assistant,
            "",
            vec![ToolTrace {
                id: "c9".into(),
                name: "save_song".into(),
                input: json!({ "name": "x" }),
                outcome: ToolOutcome::failed(ToolCategory::PathDenied, "denied"),
                duration_ms: 0,
            }],
        )];
        let api = session_to_api_messages(&history);
        assert_eq!(api[0].content.len(), 1);
        assert!(matches!(&api[0].content[0], ContentBlock::ToolUse { .. }));
        match &api[1].content[0] {
            ContentBlock::ToolResult {
                is_error, content, ..
            } => {
                assert_eq!(*is_error, Some(true));
                assert_eq!(
                    content,
                    "[result ok=false category=path-denied retryable=no]\ndenied"
                );
            }
            other => panic!("expected tool_result, got {other:?}"),
        }
    }
}
