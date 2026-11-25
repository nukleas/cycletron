use crate::state::AppState;
use cycletron_agent::LlmProvider;
use cycletron_agent::ToolName;
use cycletron_agent::types::*;
use cycletron_analysis as strudel;
use cycletron_core::types::{
    ChatMessage, ChatRole, ToolCategory, ToolFinding, ToolOutcome, ToolTrace,
};
use std::sync::LazyLock;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

mod recovery;
#[cfg(test)]
mod tests;
mod tools_analysis;
mod tools_doc;
mod tools_library;

use recovery::recover_text_tool_calls;
pub(crate) use tools_analysis::{code_hash, review_code};
use tools_analysis::{
    infer_write_kind, tool_analyze_arrangement, tool_critique_form, tool_critique_pattern,
    tool_hear_pattern, tool_inspect_pattern, tool_review_pattern, tool_validate_pattern,
};
use tools_doc::{
    apply_document, tool_list_parts, tool_list_sections, tool_mute_track, tool_play_pattern,
    tool_set_tempo, tool_stop, tool_unmute_track, tool_upsert_binding, tool_upsert_section,
    tool_upsert_sections, tool_upsert_track, tool_upsert_tracks,
};
use tools_library::{
    tool_generate_pattern, tool_genre_recipe, tool_get_example, tool_list_library,
    tool_list_methods, tool_list_sounds, tool_move_song, tool_new_folder, tool_read_song,
    tool_rename_song, tool_save_current_as, tool_save_song, tool_search_corpus,
    tool_search_library,
};

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
    include_str!("../../../prompts/system.md").to_string()
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

/// What one user message produced. `text` and `tools` are everything that
/// landed, whichever way the turn ended, so a tool that already rewrote the
/// editor stays on record even when the provider failed afterwards.
pub struct Turn {
    pub text: String,
    pub tools: Vec<ToolTrace>,
    pub end: TurnEnd,
}

pub enum TurnEnd {
    /// The model gave a final answer.
    Complete,
    /// The final answer was cut at the output token limit.
    Truncated,
    /// The tool-round cap was reached before a final answer.
    IterationCap,
    /// The provider or the connection failed; the message says how.
    Failed(String),
}

impl TurnEnd {
    /// The line the user sees under the reply, when the turn did not finish.
    pub fn notice(&self) -> Option<String> {
        match self {
            Self::Complete => None,
            Self::Truncated => Some(
                "The reply was cut off at the output token limit. Ask it to continue.".to_string(),
            ),
            Self::IterationCap => Some(format!(
                "Stopped after {MAX_ITERATIONS} tool rounds without a final answer."
            )),
            Self::Failed(message) => Some(message.clone()),
        }
    }
}

/// Tool rounds per user message. Each round is one model call plus its tool
/// results; complex prompts need several, and the loop stops here with
/// `TurnEnd::IterationCap` rather than forcing an answer.
const MAX_ITERATIONS: usize = 20;

/// Run the full agent loop: conversation with the model, tool execution, and
/// the text plus compact tool traces to persist for cross-turn memory.
pub async fn run_agent_loop(
    client: &dyn LlmProvider,
    session_messages: &[ChatMessage],
    state: &AppState,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
) -> Turn {
    let mut api_messages = session_to_api_messages(session_messages);
    let tool_defs = cycletron_agent::tools::music_tool_definitions();

    // Build the system prompt with current editor code injected
    let current_code = {
        let session = state.session.lock();
        session.current_pattern.clone()
    };
    let mut system_prompt = if let Some(code) = &current_code {
        format!(
            "{}\n\n## Current editor code (what the user hears right now)\n\n```\n{}\n```\n\n\
             When the user asks to modify, add to, or expand the song, work from this code. \
             Do not ask them to paste it — you already have it.",
            *SYSTEM_PROMPT, code
        )
    } else {
        SYSTEM_PROMPT.clone()
    };
    system_prompt.push_str(&policy_prompt(*state.agent_policy.lock()));

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

    for iteration in 0..MAX_ITERATIONS {
        debug!("agent loop iteration {iteration}");

        let mut response = match client
            .stream_message(&system_prompt, &api_messages, tool_defs, &event_tx)
            .await
        {
            Ok(response) => response,
            Err(e) => {
                return Turn {
                    text: full_text,
                    tools: turn_tools,
                    end: TurnEnd::Failed(format!("AI provider error: {e}")),
                };
            }
        };

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

        // A stream that did not finish is not a reply. Keep the text that
        // arrived, run nothing from it, and tell the user.
        let failed = match &response.stop {
            StopReason::Dropped => {
                Some("Connection to the AI dropped before the reply finished.".to_string())
            }
            StopReason::Error(message) => Some(format!("AI provider error: {message}")),
            _ => None,
        };
        if let Some(message) = failed {
            return Turn {
                text: full_text,
                tools: turn_tools,
                end: TurnEnd::Failed(message),
            };
        }

        if tool_calls.is_empty() {
            let end = match response.stop {
                StopReason::MaxTokens { .. } => TurnEnd::Truncated,
                _ => TurnEnd::Complete,
            };
            return Turn {
                text: full_text,
                tools: turn_tools,
                end,
            };
        }

        api_messages.push(ApiMessage {
            role: "assistant".to_string(),
            content: response.content.clone(),
        });

        // A tool whose arguments were cut at the token limit has `input` `{}`.
        // Executing it yields "missing 'code' parameter", which the model
        // cannot act on; it retries, truncates again, and loops. Feed back the
        // real cause instead.
        let cut_tool = match &response.stop {
            StopReason::MaxTokens { cut_tool } => cut_tool.clone(),
            _ => None,
        };

        let mut tool_results = Vec::new();
        for (id, name, input) in &tool_calls {
            let started = std::time::Instant::now();
            let outcome = if cut_tool.as_deref() == Some(id.as_str()) {
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

    Turn {
        text: full_text,
        tools: turn_tools,
        end: TurnEnd::IterationCap,
    }
}

/// The write-policy rules the model is told, matching what the tools enforce.
/// Empty under the leeway policy, so the eval's two arms differ only here and
/// in the tools' refusals.
fn policy_prompt(policy: crate::state::AgentPolicy) -> String {
    let mut s = String::new();
    if policy.advisory_notes {
        s.push_str(
            "\n\n## Review notes\n`[note]` findings in a review (hot-mix, masking, balance) are \
             observations, not defects: mention them to the user if relevant, and do NOT rewrite a \
             section or track to chase them unless the user asked about the mix — hear_pattern \
             measures it. Only `[warn]` lines need fixing before play.",
        );
    }
    if policy.rewrite_cap < usize::MAX {
        s.push_str(&format!(
            "\n\n## Rewrite budget\nEach section, track or binding may be rewritten at most \
             {} time(s) per request. After that, play what is there and let the user judge; \
             a further rewrite of the same target is refused.",
            policy.rewrite_cap
        ));
    }
    s
}

/// Refuse a rewrite of any target already at this request's cap. Only
/// *applied* rewrites count (a NOT APPLIED attempt must be retryable), so the
/// third successful take of one section in a request is the cut.
fn rewrite_budget_block(state: &AppState, targets: &[&str]) -> Option<ToolOutcome> {
    let cap = state.agent_policy.lock().rewrite_cap;
    let w = state.agent_write.lock();
    let over: Vec<String> = targets
        .iter()
        .map(|t| rewrite_key(t))
        .filter(|k| w.rewrites.get(k).copied().unwrap_or(0) >= cap)
        .map(|k| format!("@{k}"))
        .collect();
    if over.is_empty() {
        return None;
    }
    Some(ToolOutcome::failed(
        ToolCategory::BudgetExhausted,
        format!(
            "Rewrite budget used for {} — each section/track may be rewritten at most {cap} \
             time(s) per request, and it has been. Play what is there (play_pattern with no \
             code) and let the user judge; edit it again only when they ask.",
            over.join(", ")
        ),
    ))
}

/// Count an applied rewrite of each target.
fn record_rewrites(state: &AppState, targets: &[&str]) {
    let mut w = state.agent_write.lock();
    for t in targets {
        *w.rewrites.entry(rewrite_key(t)).or_insert(0) += 1;
    }
}

fn rewrite_key(target: &str) -> String {
    target.trim().trim_start_matches('@').to_ascii_lowercase()
}

/// `apply_document` for a targeted write: the cap check before, the count
/// after a successful apply.
fn apply_rewrite(
    state: &AppState,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
    targets: &[&str],
    new_code: &str,
    lead: &str,
) -> ToolResult {
    if let Some(blocked) = rewrite_budget_block(state, targets) {
        return Ok(blocked);
    }
    let out = apply_document(state, event_tx, new_code, lead)?;
    if out.ok {
        record_rewrites(state, targets);
    }
    Ok(out)
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
        ToolName::InspectPattern => tool_inspect_pattern(input, state),
        ToolName::AnalyzeArrangement => tool_analyze_arrangement(input, state),
        ToolName::CritiquePattern => tool_critique_pattern(input, state),
        ToolName::CritiqueForm => tool_critique_form(input, state),
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
