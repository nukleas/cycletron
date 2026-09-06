//! Agent telemetry: one append-only JSONL record per tool call, so we can see
//! where the agent struggles (validation failures, tool errors, retry loops).
//!
//! Written to `{app_data_dir}/agent-telemetry.jsonl`. Best-effort — a telemetry
//! failure must never disrupt the agent. Analyzed by the `agent-stats` CLI.

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
pub struct ToolEvent {
    /// Unix millis when this call finished.
    pub ts: u128,
    /// Run id (the agent-loop start millis) — groups all tool calls made in
    /// service of one user message, so retries within a request are visible.
    pub run: u128,
    /// Iteration within the run (the agent-loop turn).
    pub turn: usize,
    pub tool: String,
    /// The tool outcome's `ok` — false for every failure, including the
    /// fail-closed kinds (INVALID, NOT APPLIED, budget) that used to hide
    /// inside an Ok result text.
    pub ok: bool,
    /// The outcome's failure category (kebab-case), absent when `ok`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Whether the failure is worth retrying with different input.
    pub retryable: bool,
    /// Wall time of the tool call.
    pub duration_ms: u64,
    /// Truncated, compact JSON of the tool input (the code the agent tried).
    pub input: String,
    /// Truncated tool result (captures "INVALID: …" / "Could not …" prefixes).
    pub result: String,
    /// Char length of any `code` / section body the model emitted (0 if none).
    /// Primary proxy for LLM output cost on write tools.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_chars: Option<usize>,
    /// Write-path classification when relevant: `full`, `reuse`, `track`,
    /// `section`, `binding`, `review`, `review_cache`, `review_budget`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_kind: Option<String>,
}

/// Char count of the code the model emitted on a write tool — the primary proxy
/// for LLM output cost. Reads top-level `code` (play/upsert_track/upsert_section/
/// upsert_binding), else sums the per-patch `code` bodies of a batch call
/// (`upsert_tracks` / `upsert_sections`), which would otherwise report nothing.
pub fn code_chars_of(input: &serde_json::Value) -> Option<usize> {
    if let Some(n) = input
        .get("code")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().count())
        .filter(|&n| n > 0)
    {
        return Some(n);
    }
    let sum: usize = input
        .get("patches")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| p.get("code").and_then(|v| v.as_str()))
        .map(|s| s.chars().count())
        .sum();
    (sum > 0).then_some(sum)
}

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Truncate to `max` chars, appending an ellipsis when cut.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

/// Append one event to `{dir}/agent-telemetry.jsonl`. No-op if `dir` is None;
/// silently ignores IO errors (telemetry must not break the agent).
pub fn record(dir: Option<&Path>, ev: &ToolEvent) {
    let Some(dir) = dir else { return };
    let path = dir.join("agent-telemetry.jsonl");
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    if let Ok(line) = serde_json::to_string(ev) {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn code_chars_reads_top_level_code() {
        assert_eq!(code_chars_of(&json!({ "code": "s(\"bd*4\")" })), Some(9));
        assert_eq!(code_chars_of(&json!({ "code": "" })), None);
        assert_eq!(code_chars_of(&json!({})), None);
    }

    #[test]
    fn code_chars_sums_batch_patch_bodies() {
        let input = json!({
            "patches": [
                { "id": "bass", "code": "s(\"bd*4\")" }, // 9
                { "id": "hats", "code": "s(\"hh*8\")" }, // 9
            ]
        });
        assert_eq!(code_chars_of(&input), Some(18));
    }

    #[test]
    fn code_chars_none_for_empty_patches() {
        assert_eq!(code_chars_of(&json!({ "patches": [] })), None);
        assert_eq!(code_chars_of(&json!({ "patches": [{ "id": "x" }] })), None);
    }
}
