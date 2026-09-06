//! Shared SSE plumbing for the streaming provider codecs.
//!
//! Every backend (Anthropic Messages, OpenAI chat/completions, Codex Responses)
//! drives the same request → SSE → canonical-response pipeline: POST a streaming
//! request, bail on a non-2xx status, then read `data:` events one at a time,
//! skip the empty / `[DONE]` terminators, and hand each payload to a
//! provider-specific [`StreamDecoder`]. Only the request body, the per-event
//! decode, and the finalize step differ — those stay in each codec; the loop
//! lives here so a streaming fix lands in one place instead of three.

use crate::client::AgentError;
use crate::types::{AgentEvent, ContentBlock, MessagesResponse};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{error, warn};

/// The decode half of a streaming response. The shared [`drive_stream`] loop
/// owns the transport; the decoder owns the wire format (it parses its own
/// events and logs+ignores its own parse errors).
pub trait StreamDecoder {
    /// Handle one SSE `data:` payload (never empty, never `[DONE]`).
    fn on_event(&mut self, data: &str, event_tx: &mpsc::UnboundedSender<AgentEvent>);

    /// Consume the decoder and produce the canonical response.
    fn finalize(self, event_tx: &mpsc::UnboundedSender<AgentEvent>) -> MessagesResponse;
}

/// POST a streaming `request` and fold its SSE stream into a [`MessagesResponse`]
/// via `decoder`. Errors on transport failure or a non-success HTTP status;
/// per-event stream errors are logged and skipped so one bad frame can't abort
/// the turn.
pub async fn drive_stream<D: StreamDecoder + Send>(
    request: reqwest::RequestBuilder,
    mut decoder: D,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> Result<MessagesResponse, AgentError> {
    let response = request
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

    use eventsource_stream::Eventsource as _;
    use tokio_stream::StreamExt;
    let mut sse = std::pin::pin!(response.bytes_stream().eventsource());

    while let Some(event) = sse.next().await {
        let event = match event {
            Ok(ev) => ev,
            Err(e) => {
                error!("SSE stream error: {e}");
                continue;
            }
        };
        if event.data.is_empty() || event.data == "[DONE]" {
            continue;
        }
        decoder.on_event(&event.data, event_tx);
    }

    Ok(decoder.finalize(event_tx))
}

/// A tool call assembled from streamed deltas — shared by the OpenAI-family
/// codecs (chat/completions and Codex Responses), which both reconstruct a call
/// from `id` / `name` / partial `arguments` fragments.
#[derive(Default)]
pub struct ToolBuf {
    pub id: String,
    pub name: String,
    pub args: String,
}

/// Turn streamed tool-call buffers into canonical [`ContentBlock::ToolUse`]
/// blocks, emitting an [`AgentEvent::ToolCall`] for each. Empty args become
/// `{}`; unparseable args (almost always a `max_tokens` cutoff mid-arguments)
/// become `{}` and flip the returned `incomplete` flag, so the loop can give the
/// model honest feedback instead of a misleading "missing parameter" error. A
/// missing id is synthesized from the tool name so the `tool_result` round-trip
/// still matches.
pub fn finish_tool_calls(
    tools: impl IntoIterator<Item = ToolBuf>,
    event_tx: &mpsc::UnboundedSender<AgentEvent>,
) -> (Vec<ContentBlock>, bool) {
    let mut blocks = Vec::new();
    let mut incomplete = false;

    for buf in tools {
        let input: Value = if buf.args.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&buf.args) {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        "tool '{}' input JSON truncated/unparseable ({e}); {} bytes buffered",
                        buf.name,
                        buf.args.len()
                    );
                    incomplete = true;
                    json!({})
                }
            }
        };

        let id = if buf.id.is_empty() {
            format!("call_{}", buf.name)
        } else {
            buf.id
        };
        let _ = event_tx.send(AgentEvent::ToolCall {
            id: id.clone(),
            name: buf.name.clone(),
            input: input.clone(),
        });

        blocks.push(ContentBlock::ToolUse {
            id,
            name: buf.name,
            input,
        });
    }

    (blocks, incomplete)
}
