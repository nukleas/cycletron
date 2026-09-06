use cycletron_core::types::ToolOutcome;
use serde::{Deserialize, Serialize};

/// A message in the Claude API conversation format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiMessage {
    pub role: String,
    pub content: Vec<ContentBlock>,
}

/// Content block in the Claude API format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// Request body for Claude Messages API. Borrows everything — it exists only
/// to be serialized once per request, and the agent loop makes up to 20
/// requests per user message with the full history and tool schemas each time.
#[derive(Debug, Serialize)]
pub struct MessagesRequest<'a> {
    pub model: &'a str,
    pub max_tokens: u32,
    pub system: &'a str,
    pub messages: &'a [ApiMessage],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub tools: &'a [ToolDefinition],
    pub stream: bool,
}

/// Tool definition for the Claude API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Response from Claude Messages API (non-streaming).
#[derive(Debug, Deserialize)]
pub struct MessagesResponse {
    pub id: String,
    pub content: Vec<ContentBlock>,
    pub stop_reason: Option<String>,
    /// True when a tool_use block's argument JSON was truncated mid-stream
    /// (max_tokens cutoff). Not part of the API wire format — set by the
    /// stream accumulator. Defaults to false on the `message_start` event,
    /// which deserializes into this same struct.
    #[serde(default)]
    pub incomplete_tool_input: bool,
    pub usage: Usage,
}

#[derive(Debug, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// SSE streaming event types from Claude API.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: MessagesResponse },

    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        content_block: ContentBlock,
    },

    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: usize, delta: DeltaBlock },

    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },

    #[serde(rename = "message_delta")]
    MessageDelta {
        delta: MessageDeltaBody,
        usage: Option<Usage>,
    },

    #[serde(rename = "message_stop")]
    MessageStop,

    #[serde(rename = "ping")]
    Ping,

    #[serde(rename = "error")]
    Error { error: ApiError },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum DeltaBlock {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },

    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Deserialize)]
pub struct MessageDeltaBody {
    pub stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApiError {
    pub message: String,
}

/// Events emitted by the agent loop to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum AgentEvent {
    /// Streaming text token from AI.
    #[serde(rename = "text_delta")]
    TextDelta { text: String },

    /// AI is calling a tool. `id` pairs it with its `tool_result`.
    #[serde(rename = "tool_call")]
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    /// A tool finished: its typed envelope and how long it ran.
    #[serde(rename = "tool_result")]
    ToolResult {
        id: String,
        name: String,
        outcome: ToolOutcome,
        duration_ms: u64,
    },

    /// A tool asks the frontend to act: `__set_code_and_play` (payload = the
    /// code), `__stop_playback`, `__set_tempo` (payload = bpm),
    /// `__library_changed` (payload = the song's @path). Tools have no
    /// AppHandle, so this is how they reach the REPL and the file tree.
    #[serde(rename = "ui_action")]
    UiAction { name: String, payload: String },

    /// AI response is complete.
    #[serde(rename = "done")]
    Done { full_text: String },

    /// Error occurred.
    #[serde(rename = "error")]
    Error { message: String },
}
