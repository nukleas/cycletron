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
    /// Whether `execute_tool` returned Ok (vs. a hard error like unknown tool).
    /// Note: a tool can return Ok and still report failure in `result`
    /// (e.g. validate_pattern → "INVALID: …") — the analyzer classifies that.
    pub ok: bool,
    /// Truncated, compact JSON of the tool input (the code the agent tried).
    pub input: String,
    /// Truncated tool result (captures "INVALID: …" / "Could not …" prefixes).
    pub result: String,
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
