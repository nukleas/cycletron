use crate::sse::StreamDecoder;
use crate::types::*;
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Accumulates streaming SSE events into a complete MessagesResponse.
pub struct StreamAccumulator {
    content_blocks: Vec<ContentBlock>,
    /// Buffer for building up tool_use input JSON from deltas.
    tool_input_buffer: String,
    stop_reason: Option<String>,
    message_id: Option<String>,
    input_tokens: u32,
    output_tokens: u32,
    /// Set when a tool_use block's accumulated JSON failed to parse — almost
    /// always because the response was truncated at `max_tokens` mid-stream.
    /// Without this the input silently stayed `{}` and the agent shipped a
    /// tool call with no arguments.
    incomplete_tool_input: bool,
}

impl Default for StreamAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self {
            content_blocks: Vec::new(),
            tool_input_buffer: String::new(),
            stop_reason: None,
            message_id: None,
            input_tokens: 0,
            output_tokens: 0,
            incomplete_tool_input: false,
        }
    }

    pub fn process_event(
        &mut self,
        event: &StreamEvent,
        event_tx: &mpsc::UnboundedSender<AgentEvent>,
    ) {
        match event {
            StreamEvent::MessageStart { message } => {
                self.message_id = Some(message.id.clone());
                self.input_tokens = message.usage.input_tokens;
                debug!("message started: {}", message.id);
            }

            StreamEvent::ContentBlockStart { content_block, .. } => {
                self.tool_input_buffer.clear();
                self.content_blocks.push(content_block.clone());
            }

            StreamEvent::ContentBlockDelta { delta, .. } => match delta {
                DeltaBlock::TextDelta { text } => {
                    if let Some(ContentBlock::Text { text: t }) = self.content_blocks.last_mut() {
                        t.push_str(text);
                    }
                    // Emit streaming token to UI
                    let _ = event_tx.send(AgentEvent::TextDelta { text: text.clone() });
                }
                DeltaBlock::InputJsonDelta { partial_json } => {
                    self.tool_input_buffer.push_str(partial_json);
                }
            },

            StreamEvent::ContentBlockStop { index } => {
                // If this was a tool_use block, parse the accumulated JSON
                if let Some(ContentBlock::ToolUse { name, input, .. }) =
                    self.content_blocks.get_mut(*index)
                {
                    match serde_json::from_str(&self.tool_input_buffer) {
                        Ok(parsed) => *input = parsed,
                        Err(e) => {
                            // Buffer is non-empty but won't parse → the JSON was
                            // cut off mid-stream. Leaving `input` as `{}` here is
                            // what produced the "missing 'code' parameter" loop.
                            // Flag it so the loop can give the model honest
                            // feedback instead of a misleading arg error.
                            if !self.tool_input_buffer.is_empty() {
                                warn!(
                                    "tool '{name}' input JSON truncated/unparseable ({e}); \
                                     {} bytes buffered — likely max_tokens cutoff",
                                    self.tool_input_buffer.len()
                                );
                                self.incomplete_tool_input = true;
                            }
                        }
                    }
                    // Emit tool call event
                    if let Some(ContentBlock::ToolUse { id, name, input }) =
                        self.content_blocks.get(*index)
                    {
                        let _ = event_tx.send(AgentEvent::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                    }
                }
                self.tool_input_buffer.clear();
            }

            StreamEvent::MessageDelta { delta, usage } => {
                if let Some(reason) = &delta.stop_reason {
                    self.stop_reason = Some(reason.clone());
                }
                if let Some(u) = usage {
                    self.output_tokens = u.output_tokens;
                }
            }

            StreamEvent::MessageStop => {
                debug!("message complete");
            }

            StreamEvent::Ping => {}

            StreamEvent::Error { error } => {
                let _ = event_tx.send(AgentEvent::Error {
                    message: error.message.clone(),
                });
            }
        }
    }

    pub fn into_response(self) -> MessagesResponse {
        MessagesResponse {
            id: self.message_id.unwrap_or_default(),
            content: self.content_blocks,
            stop_reason: self.stop_reason,
            incomplete_tool_input: self.incomplete_tool_input,
            usage: Usage {
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
            },
        }
    }
}

impl StreamDecoder for StreamAccumulator {
    fn on_event(&mut self, data: &str, event_tx: &mpsc::UnboundedSender<AgentEvent>) {
        match serde_json::from_str::<StreamEvent>(data) {
            Ok(stream_event) => self.process_event(&stream_event, event_tx),
            Err(e) => debug!("failed to parse SSE event: {e}, data: {data}"),
        }
    }

    fn finalize(self, _event_tx: &mpsc::UnboundedSender<AgentEvent>) -> MessagesResponse {
        self.into_response()
    }
}
