use crate::stream::StreamAccumulator;
use crate::types::*;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use tokio::sync::mpsc;
use tracing::{debug, error};

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

    /// The configured per-response output token limit. Used to phrase
    /// truncation feedback to the model.
    pub fn max_tokens(&self) -> u32 {
        self.max_tokens
    }

    /// Send a streaming request and emit AgentEvents via the channel.
    /// Returns the accumulated response (content blocks + stop reason).
    pub async fn stream_message(
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

        let response = self
            .http
            .post(API_URL)
            .json(&request)
            .send()
            .await
            .map_err(|e| AgentError::Http(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let mut accumulator = StreamAccumulator::new();
        let bytes_stream = response.bytes_stream();

        use std::pin::pin;
        use tokio_stream::StreamExt;

        use eventsource_stream::Eventsource as _;
        let sse_stream = bytes_stream.eventsource();
        let mut sse_stream = pin!(sse_stream);

        while let Some(event_result) = sse_stream.next().await {
            let event = match event_result {
                Ok(ev) => ev,
                Err(e) => {
                    error!("SSE stream error: {e}");
                    continue;
                }
            };

            // Skip empty data or [DONE]
            if event.data.is_empty() || event.data == "[DONE]" {
                continue;
            }

            match serde_json::from_str::<StreamEvent>(&event.data) {
                Ok(stream_event) => {
                    accumulator.process_event(&stream_event, event_tx);
                }
                Err(e) => {
                    debug!("failed to parse SSE event: {e}, data: {}", event.data);
                }
            }
        }

        accumulator.into_response()
    }
}

#[async_trait::async_trait]
impl crate::provider::LlmProvider for ClaudeClient {
    async fn stream_message(
        &self,
        system: &str,
        messages: &[ApiMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<MessagesResponse, AgentError> {
        ClaudeClient::stream_message(self, system, messages, tools, event_tx).await
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

    #[error("stream error: {0}")]
    Stream(String),

    #[error("tool error: {0}")]
    Tool(String),
}
