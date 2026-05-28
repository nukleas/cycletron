use crate::state::AppState;
use crate::strudel;
use robostrudel_agent::ClaudeClient;
use robostrudel_agent::types::*;
use robostrudel_core::traits::CorpusIndex;
use robostrudel_core::types::{ChatMessage, ChatRole, CorpusQuery, MusicalRole, PlaybackState};
use std::sync::LazyLock;
use tokio::sync::mpsc;
use tracing::{debug, info};

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

        let mut tool_results = Vec::new();
        for (id, name, input) in &tool_calls {
            info!("executing tool: {name}");
            let result = execute_tool(name, input, state, &event_tx).await;
            let (content, is_error) = match result {
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
            };
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
        "validate_pattern" => tool_validate_pattern(input),
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

fn tool_validate_pattern(input: &serde_json::Value) -> Result<String, String> {
    let code = input["code"].as_str().ok_or("missing 'code' parameter")?;

    match strudel::validate_code(code) {
        Ok(_) => Ok("valid — safe to play".to_string()),
        Err(e) => Ok(format!(
            "INVALID: {e}\n\nFix the error and validate again before playing."
        )),
    }
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
