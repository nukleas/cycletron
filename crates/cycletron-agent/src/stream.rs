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
    /// `message_stop` arrived. Without it the stream ended early.
    complete: bool,
    /// An `error` event arrived; the API gave up on this response.
    error: Option<String>,
    message_id: Option<String>,
    input_tokens: u32,
    output_tokens: u32,
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
            complete: false,
            error: None,
            message_id: None,
            input_tokens: 0,
            output_tokens: 0,
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
                    // A buffer that won't parse was cut off mid-stream; `input`
                    // stays `{}` and `StopReason::max_tokens` names this block
                    // as the cut tool once the stop reason arrives.
                    match serde_json::from_str(&self.tool_input_buffer) {
                        Ok(parsed) => *input = parsed,
                        Err(e) => {
                            if !self.tool_input_buffer.is_empty() {
                                warn!(
                                    "tool '{name}' input JSON unparseable ({e}); {} bytes buffered",
                                    self.tool_input_buffer.len()
                                );
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
                self.complete = true;
            }

            StreamEvent::Ping => {}

            StreamEvent::Error { error } => {
                warn!("Anthropic stream error event: {}", error.message);
                self.error = Some(error.message.clone());
            }
        }
    }

    pub fn into_response(self) -> MessagesResponse {
        let content = self.content_blocks;
        let stop = if let Some(message) = self.error {
            StopReason::Error(message)
        } else if !self.complete {
            StopReason::Dropped
        } else if self.stop_reason.as_deref() == Some("max_tokens") {
            StopReason::max_tokens(&content)
        } else {
            StopReason::from_content(&content)
        };
        MessagesResponse {
            id: self.message_id.unwrap_or_default(),
            content,
            stop,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(acc: &mut StreamAccumulator, json: &str) {
        let (tx, _rx) = mpsc::unbounded_channel();
        acc.on_event(json, &tx);
    }

    fn start() -> StreamAccumulator {
        let mut acc = StreamAccumulator::new();
        feed(
            &mut acc,
            r#"{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3,"output_tokens":0}}}"#,
        );
        acc
    }

    #[test]
    fn missing_message_stop_is_dropped_with_text_kept() {
        let mut acc = start();
        feed(
            &mut acc,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        );
        feed(
            &mut acc,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half a"}}"#,
        );
        let resp = acc.into_response();
        assert_eq!(resp.stop, StopReason::Dropped);
        match &resp.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "half a"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn error_event_is_error_stop() {
        let mut acc = start();
        feed(
            &mut acc,
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        );
        assert_eq!(
            acc.into_response().stop,
            StopReason::Error("Overloaded".to_string())
        );
    }

    #[test]
    fn max_tokens_names_only_the_cut_tool() {
        let mut acc = start();
        // A complete zero-arg call.
        feed(
            &mut acc,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_current_code","input":{}}}"#,
        );
        feed(
            &mut acc,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#,
        );
        feed(&mut acc, r#"{"type":"content_block_stop","index":0}"#);
        // A second call cut mid-arguments.
        feed(
            &mut acc,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t2","name":"play_pattern","input":{}}}"#,
        );
        feed(
            &mut acc,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"code\": \"s(\\\"bd"}}"#,
        );
        feed(&mut acc, r#"{"type":"content_block_stop","index":1}"#);
        feed(
            &mut acc,
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":3,"output_tokens":9}}"#,
        );
        feed(&mut acc, r#"{"type":"message_stop"}"#);
        let resp = acc.into_response();
        assert_eq!(
            resp.stop,
            StopReason::MaxTokens {
                cut_tool: Some("t2".to_string())
            }
        );
    }

    #[test]
    fn max_tokens_in_prose_has_no_cut_tool() {
        let mut acc = start();
        feed(
            &mut acc,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        );
        feed(
            &mut acc,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"long"}}"#,
        );
        feed(&mut acc, r#"{"type":"content_block_stop","index":0}"#);
        feed(
            &mut acc,
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":null}"#,
        );
        feed(&mut acc, r#"{"type":"message_stop"}"#);
        assert_eq!(
            acc.into_response().stop,
            StopReason::MaxTokens { cut_tool: None }
        );
    }
}
