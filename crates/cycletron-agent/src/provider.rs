//! Provider abstraction for the agent loop.
//!
//! The agent loop and the whole app work against a single canonical message
//! shape (`ApiMessage` / `ContentBlock` / `ToolDefinition` / `MessagesResponse`
//! in [`crate::types`]). Each backend — Anthropic's Messages API, or any
//! OpenAI-compatible chat API (xAI Grok, OpenAI, OpenRouter, Ollama, …) —
//! implements this trait by translating to and from that canonical shape, so
//! providers are fully interchangeable and callers never branch on which one
//! is active.

use crate::client::AgentError;
use crate::types::{AgentEvent, ApiMessage, MessagesResponse, ToolDefinition};
use tokio::sync::mpsc;

/// A streaming chat/agent LLM backend.
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// Send a streaming request, emit [`AgentEvent`]s over `event_tx` as tokens
    /// and tool calls arrive, and return the accumulated response in the
    /// canonical [`MessagesResponse`] shape.
    async fn stream_message(
        &self,
        system: &str,
        messages: &[ApiMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> Result<MessagesResponse, AgentError>;

    /// The configured per-response output token limit. Used to phrase
    /// truncation feedback to the model.
    fn max_tokens(&self) -> u32;
}
