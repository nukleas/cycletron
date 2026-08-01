use crate::sse::drive_stream;
use crate::stream::StreamAccumulator;
use crate::types::*;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use tokio::sync::mpsc;
use tracing::debug;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

/// HTTP client for the Claude Messages API.
#[derive(Clone)]
pub struct ClaudeClient {
    http: reqwest::Client,
    model: String,
    max_tokens: u32,
}

impl ClaudeClient {
    pub fn new(api_key: &str, model: &str, max_tokens: u32) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_str(api_key).unwrap());
        headers.insert("anthropic-version", HeaderValue::from_static(API_VERSION));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("failed to build HTTP client");

        Self {
            http,
            model: model.to_string(),
            max_tokens,
        }
    }

}

#[async_trait::async_trait]
impl crate::provider::LlmProvider for ClaudeClient {
    /// Send a streaming request and emit AgentEvents via the channel.
    /// Returns the accumulated response (content blocks + stop reason).
    async fn stream_message(
        &self,
        system: &str,
        messages: &[ApiMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<MessagesResponse, AgentError> {
        let request = MessagesRequest {
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            system: system.to_string(),
            messages: messages.to_vec(),
            tools: tools.to_vec(),
            stream: true,
        };

        debug!("sending streaming request to Claude API");

        drive_stream(
            self.http.post(API_URL).json(&request),
            StreamAccumulator::new(),
            event_tx,
        )
        .await
    }

    fn max_tokens(&self) -> u32 {
        self.max_tokens
    }
}

/// Errors specific to the agent.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("HTTP error: {0}")]
    Http(String),

    #[error("API error (status {status}): {body}")]
    Api { status: u16, body: String },
}
