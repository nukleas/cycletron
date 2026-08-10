//! OpenAI-compatible chat/completions codec.
//!
//! Backs any provider that speaks the OpenAI Chat Completions API: xAI Grok
//! (`https://api.x.ai/v1`), OpenAI (`https://api.openai.com/v1`), OpenRouter,
//! Together, and local servers like Ollama / LM Studio
//! (`http://localhost:11434/v1`). Only the base URL, model, and API key differ.
//!
//! This translates the canonical Anthropic-shaped messages the agent loop
//! produces into OpenAI's request shape (system relocated into `messages`,
//! content blocks flattened, `tool_use` → assistant `tool_calls`, `tool_result`
//! → `role: "tool"` messages) and parses OpenAI's streaming `choices[].delta`
//! chunks back into the canonical [`MessagesResponse`] + [`AgentEvent`]s.

use crate::client::AgentError;
use crate::provider::LlmProvider;
use crate::sse::{StreamDecoder, ToolBuf, drive_stream, finish_tool_calls};
use crate::types::*;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio::sync::mpsc;
use tracing::debug;

/// HTTP client for any OpenAI-compatible chat/completions API.
#[derive(Clone)]
pub struct OpenAiClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    max_tokens: u32,
}

impl OpenAiClient {
    /// `base_url` is the API root (e.g. `https://api.x.ai/v1`); requests hit
    /// `{base_url}/chat/completions`. `api_key` may be empty for local servers
    /// (Ollama) that don't authenticate — the `Authorization` header is then
    /// omitted.
    pub fn new(api_key: &str, base_url: &str, model: &str, max_tokens: u32) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if !api_key.is_empty() {
            if let Ok(v) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
                headers.insert(AUTHORIZATION, v);
            }
        }

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("failed to build HTTP client");

        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            max_tokens,
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }
}

#[async_trait::async_trait]
impl LlmProvider for OpenAiClient {
    async fn stream_message(
        &self,
        system: &str,
        messages: &[ApiMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<MessagesResponse, AgentError> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "stream": true,
            "messages": to_openai_messages(system, messages),
        });
        let tool_defs = to_openai_tools(tools);
        if !tool_defs.is_empty() {
            body["tools"] = Value::Array(tool_defs);
        }

        debug!("sending streaming request to {}", self.endpoint());

        drive_stream(
            self.http.post(self.endpoint()).json(&body),
            Accumulator::default(),
            event_tx,
        )
        .await
    }

    fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
}

// --- request adaptation (canonical -> OpenAI) --------------------------------

/// Translate canonical messages + a top-level system prompt into OpenAI's
/// `messages` array. The system prompt becomes a leading `system` message;
/// assistant `tool_use` blocks become `tool_calls`; user-turn `tool_result`
/// blocks become individual `role: "tool"` messages keyed by `tool_call_id`.
fn to_openai_messages(system: &str, messages: &[ApiMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }

    for msg in messages {
        match msg.role.as_str() {
            "assistant" => {
                let mut text = String::new();
                let mut tool_calls = Vec::new();
                for block in &msg.content {
                    match block {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": serde_json::to_string(input)
                                        .unwrap_or_else(|_| "{}".to_string()),
                                }
                            }));
                        }
                        ContentBlock::ToolResult { .. } => {}
                    }
                }
                let mut m = serde_json::Map::new();
                m.insert("role".to_string(), json!("assistant"));
                // `content` must be present; use null when the turn is only
                // tool calls (OpenAI rejects a missing `content` key).
                m.insert(
                    "content".to_string(),
                    if text.is_empty() {
                        Value::Null
                    } else {
                        json!(text)
                    },
                );
                if !tool_calls.is_empty() {
                    m.insert("tool_calls".to_string(), Value::Array(tool_calls));
                }
                out.push(Value::Object(m));
            }
            // user (or any non-assistant) turn.
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
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content,
                            }));
                        }
                        ContentBlock::ToolUse { .. } => {}
                    }
                }
                if !text.is_empty() {
                    out.push(json!({ "role": "user", "content": text }));
                }
            }
        }
    }

    out
}

fn to_openai_tools(tools: &[ToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                }
            })
        })
        .collect()
}

// --- response adaptation (OpenAI stream -> canonical) ------------------------

#[derive(Default, Deserialize)]
struct ChatChunk {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Default, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    delta: ChatDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Default, Deserialize)]
struct ChatDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Default, Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FnDelta>,
}

#[derive(Default, Deserialize)]
struct FnDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

/// Accumulates OpenAI streaming deltas into the canonical response. Text is
/// buffered into a single `Text` block; each tool call (keyed by its stream
/// `index`) has its `id`/`name`/`arguments` assembled from partial deltas.
#[derive(Default)]
struct Accumulator {
    text: String,
    tools: BTreeMap<usize, ToolBuf>,
    finish_reason: Option<String>,
}

impl Accumulator {
    fn process(&mut self, chunk: &ChatChunk, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        let Some(choice) = chunk.choices.first() else {
            return;
        };

        if let Some(content) = &choice.delta.content
            && !content.is_empty()
        {
            self.text.push_str(content);
            let _ = event_tx.send(AgentEvent::TextDelta {
                text: content.clone(),
            });
        }

        if let Some(tool_calls) = &choice.delta.tool_calls {
            for tc in tool_calls {
                let buf = self.tools.entry(tc.index).or_default();
                if let Some(id) = &tc.id
                    && !id.is_empty()
                {
                    buf.id = id.clone();
                }
                if let Some(f) = &tc.function {
                    if let Some(name) = &f.name
                        && !name.is_empty()
                    {
                        buf.name = name.clone();
                    }
                    if let Some(args) = &f.arguments {
                        buf.args.push_str(args);
                    }
                }
            }
        }

        if let Some(reason) = &choice.finish_reason {
            self.finish_reason = Some(reason.clone());
        }
    }

}

impl StreamDecoder for Accumulator {
    fn on_event(&mut self, data: &str, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        match serde_json::from_str::<ChatChunk>(data) {
            Ok(chunk) => self.process(&chunk, event_tx),
            Err(e) => debug!("failed to parse OpenAI chunk: {e}, data: {data}"),
        }
    }

    fn finalize(self, event_tx: &mpsc::UnboundedSender<AgentEvent>) -> MessagesResponse {
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(ContentBlock::Text { text: self.text });
        }
        let (tool_blocks, incomplete_tool_input) =
            finish_tool_calls(self.tools.into_values(), event_tx);
        content.extend(tool_blocks);

        // Map OpenAI finish reasons onto the Anthropic vocabulary the agent
        // loop already understands (notably `max_tokens` for truncation).
        let stop_reason = self.finish_reason.map(|fr| match fr.as_str() {
            "tool_calls" => "tool_use".to_string(),
            "length" => "max_tokens".to_string(),
            "stop" => "end_turn".to_string(),
            other => other.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_relocated_and_user_text_flattened() {
        let msgs = vec![ApiMessage {
            role: "user".to_string(),
            content: vec![ContentBlock::Text {
                text: "hello".to_string(),
            }],
        }];
        let out = to_openai_messages("be terse", &msgs);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[0]["content"], "be terse");
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"], "hello");
    }

    #[test]
    fn tool_use_becomes_tool_calls_and_result_becomes_tool_message() {
        let msgs = vec![
            ApiMessage {
                role: "assistant".to_string(),
                content: vec![ContentBlock::ToolUse {
                    id: "call_1".to_string(),
                    name: "play_pattern".to_string(),
                    input: serde_json::json!({"code": "bd sd"}),
                }],
            },
            ApiMessage {
                role: "user".to_string(),
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".to_string(),
                    content: "ok".to_string(),
                    is_error: None,
                }],
            },
        ];
        let out = to_openai_messages("", &msgs);
        // assistant turn: content null, one tool_call whose arguments is a JSON string.
        assert_eq!(out[0]["role"], "assistant");
        assert!(out[0]["content"].is_null());
        let tc = &out[0]["tool_calls"][0];
        assert_eq!(tc["id"], "call_1");
        assert_eq!(tc["function"]["name"], "play_pattern");
        assert_eq!(tc["function"]["arguments"], "{\"code\":\"bd sd\"}");
        // tool result becomes a `tool` message keyed by the same id.
        assert_eq!(out[1]["role"], "tool");
        assert_eq!(out[1]["tool_call_id"], "call_1");
        assert_eq!(out[1]["content"], "ok");
    }

    #[test]
    fn tools_wrapped_in_function_envelope() {
        let tools = vec![ToolDefinition {
            name: "t".to_string(),
            description: "d".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }];
        let out = to_openai_tools(&tools);
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["function"]["name"], "t");
        assert_eq!(out[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn accumulator_assembles_streamed_tool_call() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut acc = Accumulator::default();
        // First chunk: text + tool call opener (id + name + partial args).
        acc.process(
            &serde_json::from_str(
                r#"{"choices":[{"delta":{"content":"hi ","tool_calls":[{"index":0,"id":"call_9","function":{"name":"play_pattern","arguments":"{\"co"}}]}}]}"#,
            )
            .unwrap(),
            &tx,
        );
        // Second chunk: rest of the arguments.
        acc.process(
            &serde_json::from_str(
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"de\":\"bd\"}"}}]}}]}"#,
            )
            .unwrap(),
            &tx,
        );
        // Final chunk: finish_reason.
        acc.process(
            &serde_json::from_str(r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#)
                .unwrap(),
            &tx,
        );
        let resp = acc.finalize(&tx);
        assert_eq!(resp.stop_reason.as_deref(), Some("tool_use"));
        assert!(!resp.incomplete_tool_input);
        match &resp.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hi "),
            other => panic!("expected text block, got {other:?}"),
        }
        match &resp.content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_9");
                assert_eq!(name, "play_pattern");
                assert_eq!(input["code"], "bd");
            }
            other => panic!("expected tool_use block, got {other:?}"),
        }
    }

    #[test]
    fn length_finish_reason_maps_to_max_tokens() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut acc = Accumulator::default();
        acc.process(
            &serde_json::from_str(
                r#"{"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}"#,
            )
            .unwrap(),
            &tx,
        );
        let resp = acc.finalize(&tx);
        assert_eq!(resp.stop_reason.as_deref(), Some("max_tokens"));
    }
}
