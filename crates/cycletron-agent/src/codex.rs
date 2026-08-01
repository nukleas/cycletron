//! ChatGPT / Codex Responses API client (subscription OAuth).
//!
//! Hits `https://chatgpt.com/backend-api/codex/responses` with a ChatGPT
//! access token + `ChatGPT-Account-Id` header — the same surface the Codex
//! CLI uses. Translates to/from the agent loop's canonical message shape.

use crate::client::AgentError;
use crate::provider::LlmProvider;
use crate::sse::{StreamDecoder, ToolBuf, drive_stream, finish_tool_calls};
use crate::types::*;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// HTTP client for the Codex ChatGPT Responses backend.
#[derive(Clone)]
pub struct CodexClient {
    http: reqwest::Client,
    /// Full responses URL, e.g. `https://chatgpt.com/backend-api/codex/responses`.
    endpoint: String,
    model: String,
    max_tokens: u32,
}

impl CodexClient {
    /// `access_token` and `account_id` come from Codex/ChatGPT OAuth.
    pub fn new(
        access_token: &str,
        account_id: &str,
        model: &str,
        max_tokens: u32,
        base_url: Option<&str>,
    ) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {access_token}")) {
            headers.insert(AUTHORIZATION, v);
        }
        if let Ok(v) = HeaderValue::from_str(account_id) {
            headers.insert("ChatGPT-Account-Id", v);
        }
        // Identity headers the Codex backend expects from CLI-class clients.
        headers.insert("OpenAI-Beta", HeaderValue::from_static("responses=experimental"));
        headers.insert("originator", HeaderValue::from_static("codex_cli_rs"));

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("failed to build Codex HTTP client");

        let base = base_url
            .unwrap_or("https://chatgpt.com/backend-api/codex")
            .trim_end_matches('/');
        let endpoint = if base.ends_with("/responses") {
            base.to_string()
        } else {
            format!("{base}/responses")
        };

        Self {
            http,
            endpoint,
            model: model.to_string(),
            max_tokens,
        }
    }
}

#[async_trait::async_trait]
impl LlmProvider for CodexClient {
    async fn stream_message(
        &self,
        system: &str,
        messages: &[ApiMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<MessagesResponse, AgentError> {
        let mut body = json!({
            "model": self.model,
            "instructions": system,
            "input": to_responses_input(messages),
            "stream": true,
            "store": false,
            "max_output_tokens": self.max_tokens,
        });
        let tool_defs = to_responses_tools(tools);
        if !tool_defs.is_empty() {
            body["tools"] = Value::Array(tool_defs);
        }

        debug!("sending Codex Responses stream to {}", self.endpoint);

        drive_stream(
            self.http.post(&self.endpoint).json(&body),
            ResponsesAccumulator::default(),
            event_tx,
        )
        .await
    }

    fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
}

// --- request adaptation ----------------------------------------------------

fn to_responses_input(messages: &[ApiMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for msg in messages {
        match msg.role.as_str() {
            "assistant" => {
                let mut text = String::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolUse { id, name, input } => {
                            out.push(json!({
                                "type": "function_call",
                                "call_id": id,
                                "name": name,
                                "arguments": serde_json::to_string(input)
                                    .unwrap_or_else(|_| "{}".to_string()),
                            }));
                        }
                        ContentBlock::ToolResult { .. } => {}
                    }
                }
                if !text.is_empty() {
                    out.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
            }
            _ => {
                let mut text = String::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            out.push(json!({
                                "type": "function_call_output",
                                "call_id": tool_use_id,
                                "output": content,
                            }));
                        }
                        ContentBlock::ToolUse { .. } => {}
                    }
                }
                if !text.is_empty() {
                    out.push(json!({
                        "role": "user",
                        "content": [{ "type": "input_text", "text": text }],
                    }));
                }
            }
        }
    }
    out
}

fn to_responses_tools(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            })
        })
        .collect()
}

// --- response adaptation ---------------------------------------------------

#[derive(Default)]
struct ResponsesAccumulator {
    text: String,
    /// call_id / name / arguments by item id or call index.
    tools: BTreeMap<String, ToolBuf>,
    /// Map stream item_id → call_id key.
    item_keys: BTreeMap<String, String>,
    stop_reason: Option<String>,
}

impl ResponsesAccumulator {
    fn process(&mut self, v: &Value, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            // Text deltas — Responses API variants.
            "response.output_text.delta" | "response.content_part.delta" => {
                let delta = v
                    .get("delta")
                    .and_then(|d| d.as_str())
                    .or_else(|| {
                        v.pointer("/delta/text")
                            .and_then(|t| t.as_str())
                    })
                    .unwrap_or("");
                if !delta.is_empty() {
                    self.text.push_str(delta);
                    let _ = event_tx.send(AgentEvent::TextDelta {
                        text: delta.to_string(),
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                let delta = v.get("delta").and_then(|d| d.as_str()).unwrap_or("");
                let item_id = v
                    .get("item_id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("default");
                let key = self
                    .item_keys
                    .get(item_id)
                    .cloned()
                    .unwrap_or_else(|| item_id.to_string());
                let buf = self.tools.entry(key).or_default();
                buf.args.push_str(delta);
            }
            "response.output_item.added" | "response.output_item.done" => {
                let item = v.get("item").unwrap_or(v);
                let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if item_type == "function_call" || item_type == "custom_tool_call" {
                    let call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = item
                        .get("arguments")
                        .and_then(|a| a.as_str())
                        .unwrap_or("")
                        .to_string();
                    let item_id = item
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or(call_id.as_str())
                        .to_string();
                    let key = if call_id.is_empty() {
                        item_id.clone()
                    } else {
                        call_id.clone()
                    };
                    self.item_keys.insert(item_id, key.clone());
                    let buf = self.tools.entry(key).or_default();
                    if !call_id.is_empty() {
                        buf.id = call_id;
                    }
                    if !name.is_empty() {
                        buf.name = name;
                    }
                    // On `done`, arguments may be complete; prefer non-empty.
                    if !args.is_empty() {
                        buf.args = args;
                    }
                } else if item_type == "message" {
                    // Final message text sometimes only appears on done.
                    if let Some(arr) = item.get("content").and_then(|c| c.as_array()) {
                        for part in arr {
                            let t = part.get("type").and_then(|x| x.as_str()).unwrap_or("");
                            if t == "output_text" || t == "text" {
                                if let Some(text) = part.get("text").and_then(|x| x.as_str()) {
                                    if self.text.is_empty() {
                                        self.text.push_str(text);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "response.completed" => {
                self.stop_reason = Some(if self.tools.is_empty() {
                    "end_turn".into()
                } else {
                    "tool_use".into()
                });
            }
            "response.incomplete" => {
                self.stop_reason = Some("max_tokens".into());
            }
            "error" => {
                let msg = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown Codex stream error");
                warn!("Codex stream error event: {msg}");
            }
            _ => {}
        }
    }

}

impl StreamDecoder for ResponsesAccumulator {
    fn on_event(&mut self, data: &str, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        match serde_json::from_str::<Value>(data) {
            Ok(v) => self.process(&v, event_tx),
            Err(e) => debug!("failed to parse Codex event: {e}"),
        }
    }

    fn finalize(self, event_tx: &mpsc::UnboundedSender<AgentEvent>) -> MessagesResponse {
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(ContentBlock::Text { text: self.text });
        }
        // Capture the explicit stop before moving `self.tools`; if the stream
        // never sent `response.completed`/`incomplete`, infer it from whether
        // any tool call landed.
        let explicit_stop = self.stop_reason;
        let (tool_blocks, incomplete_tool_input) =
            finish_tool_calls(self.tools.into_values(), event_tx);
        content.extend(tool_blocks);

        let stop_reason = explicit_stop.or_else(|| {
            Some(
                if content
                    .iter()
                    .any(|c| matches!(c, ContentBlock::ToolUse { .. }))
                {
                    "tool_use".into()
                } else {
                    "end_turn".into()
                },
            )
        });

        MessagesResponse {
            id: String::new(),
            content,
            stop_reason,
            incomplete_tool_input,
            usage: Usage {
                input_tokens: 0,
                output_tokens: 0,
            },
        }
    }
}
