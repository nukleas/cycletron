use cycletron_agent::types::*;

/// Recover tool calls a model wrote as TEXT into real `ToolUse` blocks. Weak and
/// local models frequently understand which tool to call but can't emit the
/// native tool-call format — they print a ```json {"name":…,"arguments":…}```
/// block instead. This rescues those. No-op if a native `ToolUse` is present or
/// no recognisable tool call is in the text.
pub(super) fn recover_text_tool_calls(
    content: &mut Vec<ContentBlock>,
    tool_defs: &[ToolDefinition],
) {
    if content
        .iter()
        .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
    {
        return;
    }
    let known: std::collections::HashSet<&str> =
        tool_defs.iter().map(|t| t.name.as_str()).collect();

    let mut kept: Vec<ContentBlock> = Vec::new();
    let mut recovered: Vec<ContentBlock> = Vec::new();
    for block in content.drain(..) {
        if let ContentBlock::Text { text } = &block {
            let calls = extract_tool_calls_from_text(text, &known);
            if !calls.is_empty() {
                for (name, input) in calls {
                    recovered.push(ContentBlock::ToolUse {
                        id: format!("txt-{}", recovered.len()),
                        name,
                        input,
                    });
                }
                continue; // drop the raw JSON text so the user doesn't see it
            }
        }
        kept.push(block);
    }
    kept.append(&mut recovered);
    *content = kept;
}

/// Pull `{name, arguments}`-shaped tool calls out of free text — tolerant of code
/// fences, surrounding prose, `function`-wrapping, and a few key aliases models
/// use. Only returns calls whose tool name is in `known`.
fn extract_tool_calls_from_text(
    text: &str,
    known: &std::collections::HashSet<&str>,
) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    for v in scan_json_objects(text) {
        // Accept either a top-level {name, arguments} or an OpenAI-ish
        // {function: {name, arguments}} wrapper.
        let obj = v.get("function").filter(|f| f.is_object()).unwrap_or(&v);
        let name = ["name", "tool", "tool_name"]
            .iter()
            .find_map(|k| obj.get(*k).and_then(|x| x.as_str()));
        let Some(name) = name else { continue };
        if !known.contains(name) {
            continue;
        }
        let args = ["arguments", "parameters", "args", "input", "tool_input"]
            .iter()
            .find_map(|k| obj.get(*k).cloned())
            .unwrap_or_else(|| serde_json::json!({}));
        // Some models stringify the arguments object; unwrap that.
        let args = match args {
            serde_json::Value::String(s) => {
                serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
            }
            other => other,
        };
        out.push((name.to_string(), args));
    }
    out
}

/// Every balanced `{…}` JSON object in `text` that parses (string-aware, so
/// braces inside strings don't break nesting). Handles fenced and bare JSON.
fn scan_json_objects(text: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let (mut depth, mut in_str, mut esc) = (0i32, false, false);
        let start = i;
        let mut j = i;
        while j < bytes.len() {
            let c = bytes[j];
            if in_str {
                if esc {
                    esc = false;
                } else if c == b'\\' {
                    esc = true;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            j += 1;
        }
        if depth == 0 && j < bytes.len() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[start..=j]) {
                out.push(v);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn defs() -> &'static [ToolDefinition] {
        cycletron_agent::tools::music_tool_definitions()
    }

    #[test]
    fn recovers_a_fenced_text_tool_call() {
        // A small local model emitting a fenced JSON tool call as text instead
        // of a native tool_use block — the case recover_text_tool_calls exists for.
        let text = "Sure, let's play it:\n```json\n{\n  \"name\": \"play_pattern\",\n  \
                    \"arguments\": { \"code\": \"s(\\\"bd*4\\\")\" }\n}\n```";
        let mut content = vec![ContentBlock::Text {
            text: text.to_string(),
        }];
        recover_text_tool_calls(&mut content, defs());
        let call = content.iter().find_map(|b| match b {
            ContentBlock::ToolUse { name, input, .. } => Some((name.clone(), input.clone())),
            _ => None,
        });
        let (name, input) = call.expect("should recover a tool call");
        assert_eq!(name, "play_pattern");
        assert_eq!(input["code"], "s(\"bd*4\")");
    }

    #[test]
    fn recovers_function_wrapped_and_stringified_args() {
        let text =
            r#"{"function": {"name": "save_current_as", "arguments": "{\"name\": \"dub\"}"}}"#;
        let mut content = vec![ContentBlock::Text {
            text: text.to_string(),
        }];
        recover_text_tool_calls(&mut content, defs());
        let ok = content.iter().any(|b| {
            matches!(b, ContentBlock::ToolUse { name, input, .. }
            if name == "save_current_as" && input["name"] == "dub")
        });
        assert!(ok, "got: {content:?}");
    }

    #[test]
    fn leaves_prose_and_native_calls_alone() {
        // Plain prose → no tool call invented.
        let mut prose = vec![ContentBlock::Text {
            text: "Here's a nice house groove!".into(),
        }];
        recover_text_tool_calls(&mut prose, defs());
        assert!(
            !prose
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        );
        // Unknown tool name in text → ignored.
        let mut bogus = vec![ContentBlock::Text {
            text: r#"{"name": "delete_everything", "arguments": {}}"#.into(),
        }];
        recover_text_tool_calls(&mut bogus, defs());
        assert!(
            !bogus
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        );
    }
}
