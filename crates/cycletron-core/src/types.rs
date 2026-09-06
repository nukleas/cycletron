use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A corpus entry with extracted metadata, loaded from normalized-metadata.jsonl.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusEntry {
    pub id: String,
    pub filename: String,
    /// Original file type from the corpus inventory (e.g. "strudel", "js-song", "tidal").
    /// Used by the UI to visually distinguish entries that are native to the strudel-rs
    /// mini-notation engine vs. ones that were authored against the full JS web-strudel runtime.
    pub file_type: Option<String>,
    pub title: Option<String>,
    pub author: Option<String>,
    pub tempo: Option<f64>,
    pub sounds: Vec<String>,
    pub effects: Vec<String>,
    pub scales: Vec<String>,
    pub tags: Vec<String>,
    pub features: Vec<String>,
    pub complexity: Option<String>,
    pub source_code: Option<String>,
}

/// Query parameters for corpus search.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CorpusQuery {
    pub tags: Vec<String>,
    pub tempo_min: Option<f64>,
    pub tempo_max: Option<f64>,
    pub complexity: Option<String>,
    pub sounds: Vec<String>,
    pub keyword: Option<String>,
    pub limit: Option<usize>,
}

/// Why a tool call failed. The model (and the UI, telemetry, agent-stats)
/// branch on this instead of parsing prose. `Some` iff `!ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    /// Engine parse/eval failure (validate / review / inspect / critique).
    InvalidCode,
    /// Fail-closed write: nothing changed (apply_document, the play gate).
    NotApplied,
    /// Song / example / track / section / binding / recipe missing.
    NotFound,
    /// Missing or invalid parameter, unknown generator, unknown tool.
    BadArgument,
    /// Empty editor, no prior review, corpus not loaded.
    Precondition,
    /// Per-run budget spent (reviews, library reads).
    BudgetExhausted,
    /// Blocked by policy (full-rewrite guard) — retry with `force: true`.
    PolicyBlocked,
    /// Path escapes the library root.
    PathDenied,
    /// Destination already exists.
    Conflict,
    /// Filesystem / serialization failure.
    Io,
    /// The model's tool arguments were cut off at the token limit.
    Truncated,
    Unknown,
}

impl ToolCategory {
    /// Whether calling the tool again *with different input* can succeed.
    /// Budget, I/O and policy-by-root failures do not change on retry.
    pub fn retryable(self) -> bool {
        match self {
            Self::InvalidCode
            | Self::NotApplied
            | Self::NotFound
            | Self::BadArgument
            | Self::Precondition
            | Self::PolicyBlocked
            | Self::Truncated => true,
            Self::BudgetExhausted
            | Self::PathDenied
            | Self::Conflict
            | Self::Io
            | Self::Unknown => false,
        }
    }

    /// The kebab-case wire name (`invalid-code`), also used in the
    /// `[result …]` header the model reads.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidCode => "invalid-code",
            Self::NotApplied => "not-applied",
            Self::NotFound => "not-found",
            Self::BadArgument => "bad-argument",
            Self::Precondition => "precondition",
            Self::BudgetExhausted => "budget-exhausted",
            Self::PolicyBlocked => "policy-blocked",
            Self::PathDenied => "path-denied",
            Self::Conflict => "conflict",
            Self::Io => "io",
            Self::Truncated => "truncated",
            Self::Unknown => "unknown",
        }
    }
}

/// One lint finding carried on a tool result — the `{severity, code, message}`
/// shape the analysis crate's silence lint / critique already produce.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolFinding {
    /// "warn" (likely a problem) or "note" (observation).
    pub severity: String,
    /// Machine-stable id, e.g. "unknown-sound", "clipping".
    pub code: String,
    pub message: String,
}

/// Longest `summary` a tool may carry — one line for the chat row and header.
pub const TOOL_SUMMARY_CHARS: usize = 120;

/// The typed envelope every tool returns. `text` is the full human-readable
/// result the model reads; the other fields let every consumer (agent loop,
/// UI, telemetry, session replay) branch without parsing that prose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolOutcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<ToolCategory>,
    /// Meaningful iff `!ok`: whether a retry with different input can succeed.
    pub retryable: bool,
    /// One line, at most [`TOOL_SUMMARY_CHARS`].
    pub summary: String,
    /// The full result text.
    pub text: String,
    /// Lint findings (silence lint, critique). They also appear in `text`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ToolFinding>,
    /// Deterministic repairs applied before the code was committed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repairs: Vec<String>,
    /// Structured payload for tools that have one (measurements, listings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ToolOutcome {
    pub fn ok(summary: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            ok: true,
            category: None,
            retryable: false,
            summary: clip_summary(summary.into()),
            text: text.into(),
            warnings: Vec::new(),
            repairs: Vec::new(),
            data: None,
        }
    }

    /// A failure. The summary is the first line of `text`, which every
    /// failure text leads with (`INVALID: …`, `NOT PLAYED — …`, `no track
    /// matches …`).
    pub fn failed(category: ToolCategory, text: impl Into<String>) -> Self {
        let text = text.into();
        Self {
            ok: false,
            category: Some(category),
            retryable: category.retryable(),
            summary: clip_summary(text.lines().next().unwrap_or_default().to_string()),
            text,
            warnings: Vec::new(),
            repairs: Vec::new(),
            data: None,
        }
    }

    pub fn with_warnings(mut self, warnings: Vec<ToolFinding>) -> Self {
        self.warnings = warnings;
        self
    }

    pub fn with_repairs(mut self, repairs: Vec<String>) -> Self {
        self.repairs = repairs;
        self
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// The exact content the model reads, on every provider: one machine
    /// header line, then the prose. Warnings are already in the text; the
    /// count is a pointer. Models that only read prose lose nothing.
    ///
    /// ```text
    /// [result ok=false category=invalid-code retryable=yes]
    /// INVALID: …
    /// ```
    pub fn to_model_text(&self) -> String {
        let mut header = String::from("[result ok=");
        header.push_str(if self.ok { "true" } else { "false" });
        if let Some(c) = self.category {
            header.push_str(" category=");
            header.push_str(c.as_str());
            header.push_str(if self.retryable {
                " retryable=yes"
            } else {
                " retryable=no"
            });
        }
        let warns = self
            .warnings
            .iter()
            .filter(|w| w.severity == "warn")
            .count();
        if warns > 0 {
            header.push_str(&format!(" warnings={warns}"));
        }
        header.push(']');
        if self.text.is_empty() {
            header
        } else {
            format!("{header}\n{}", self.text)
        }
    }

    /// The same envelope with `text` cut to `max` chars — what the session
    /// keeps per tool call so replaying past turns stays cheap.
    pub fn truncated(&self, max: usize) -> Self {
        let mut out = self.clone();
        if out.text.chars().count() > max {
            out.text = out.text.chars().take(max).collect();
            out.text.push('…');
        }
        out
    }
}

fn clip_summary(s: String) -> String {
    let s = s.trim();
    if s.chars().count() <= TOOL_SUMMARY_CHARS {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(TOOL_SUMMARY_CHARS - 1).collect();
        t.push('…');
        t
    }
}

/// A compact record of one tool the assistant invoked during a turn, persisted
/// on the assistant [`ChatMessage`] so the model can recall what it already
/// tried on later turns — otherwise the tool exchange is lost to text-only
/// history and it re-tries the same things. Inputs are kept in full (they are
/// small and must round-trip back into a valid `tool_use` on replay); the
/// outcome's text is truncated, since large payloads (file / corpus dumps) are
/// what would balloon per-turn input tokens if replayed verbatim.
///
/// Snapshots written before the envelope existed carry `result` + `is_error`
/// instead of `outcome`; they are migrated on read (see [`ToolTraceWire`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ToolTraceWire")]
pub struct ToolTrace {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    pub outcome: ToolOutcome,
    #[serde(default)]
    pub duration_ms: u64,
}

/// On-disk shape of [`ToolTrace`]: the current `outcome` form, or the legacy
/// `result` + `is_error` pair from snapshots saved before the envelope.
#[derive(Deserialize)]
struct ToolTraceWire {
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(default)]
    outcome: Option<ToolOutcome>,
    #[serde(default)]
    result: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    duration_ms: u64,
}

impl From<ToolTraceWire> for ToolTrace {
    fn from(w: ToolTraceWire) -> Self {
        let outcome = w.outcome.unwrap_or_else(|| {
            if w.is_error {
                ToolOutcome::failed(ToolCategory::Unknown, w.result)
            } else {
                let summary = w.result.lines().next().unwrap_or_default().to_string();
                ToolOutcome::ok(summary, w.result)
            }
        });
        Self {
            id: w.id,
            name: w.name,
            input: w.input,
            outcome,
            duration_ms: w.duration_ms,
        }
    }
}

/// A message in the chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    /// Structured tool exchange for assistant turns that called tools. Empty for
    /// plain-text turns and for older snapshots (serde default), and skipped on
    /// the wire when empty so the persisted format is byte-identical for
    /// text-only chats and the frontend contract is unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolTrace>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

/// Current state of audio playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    Stopped,
    Playing,
}

/// Transport state sent to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportState {
    pub playback: PlaybackState,
    pub tempo: f64,
    pub cycle: f64,
    pub pattern_code: Option<String>,
}

#[cfg(test)]
mod tool_outcome_tests {
    use super::*;

    #[test]
    fn header_carries_status_category_and_warning_count() {
        let ok = ToolOutcome::ok("played", "Pattern sent to editor for playback.");
        assert_eq!(
            ok.to_model_text(),
            "[result ok=true]\nPattern sent to editor for playback."
        );

        let warned = ToolOutcome::ok("valid, 1 warn", "valid syntax, BUT…").with_warnings(vec![
            ToolFinding {
                severity: "warn".into(),
                code: "unknown-sound".into(),
                message: "x".into(),
            },
            ToolFinding {
                severity: "note".into(),
                code: "n".into(),
                message: "y".into(),
            },
        ]);
        assert!(
            warned
                .to_model_text()
                .starts_with("[result ok=true warnings=1]\n")
        );

        let bad = ToolOutcome::failed(ToolCategory::InvalidCode, "INVALID: parse error\nmore");
        assert_eq!(bad.summary, "INVALID: parse error");
        assert!(bad.retryable);
        assert_eq!(
            bad.to_model_text(),
            "[result ok=false category=invalid-code retryable=yes]\nINVALID: parse error\nmore"
        );

        let budget = ToolOutcome::failed(ToolCategory::BudgetExhausted, "Review budget used");
        assert!(!budget.retryable);
        assert!(
            budget
                .to_model_text()
                .starts_with("[result ok=false category=budget-exhausted retryable=no]")
        );
    }

    #[test]
    fn summary_is_clipped_to_one_short_line() {
        let long = "x".repeat(400);
        let o = ToolOutcome::ok(long.clone(), long);
        assert_eq!(o.summary.chars().count(), TOOL_SUMMARY_CHARS);
        assert!(o.summary.ends_with('…'));
    }

    #[test]
    fn truncated_keeps_envelope_and_cuts_text() {
        let o = ToolOutcome::failed(ToolCategory::NotFound, "abcdefghij");
        let t = o.truncated(4);
        assert_eq!(t.text, "abcd…");
        assert_eq!(t.category, Some(ToolCategory::NotFound));
        assert_eq!(t.summary, "abcdefghij");
    }

    #[test]
    fn outcome_serde_round_trips_and_omits_empty_optionals() {
        let o = ToolOutcome::failed(ToolCategory::PolicyBlocked, "NOT PLAYED — blocked")
            .with_repairs(vec!["fence removed".into()]);
        let json = serde_json::to_string(&o).unwrap();
        assert!(json.contains("\"category\":\"policy-blocked\""));
        assert!(!json.contains("warnings"));
        assert!(!json.contains("data"));
        let back: ToolOutcome = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
    }

    #[test]
    fn legacy_trace_without_outcome_migrates_on_read() {
        let legacy = r#"{"id":"c1","name":"save_song","input":{"name":"x"},"result":"denied","is_error":true}"#;
        let t: ToolTrace = serde_json::from_str(legacy).unwrap();
        assert!(!t.outcome.ok);
        assert_eq!(t.outcome.category, Some(ToolCategory::Unknown));
        assert_eq!(t.outcome.text, "denied");
        assert_eq!(t.duration_ms, 0);

        let legacy_ok = r#"{"id":"c2","name":"play_pattern","input":{},"result":"playing\nmore"}"#;
        let t: ToolTrace = serde_json::from_str(legacy_ok).unwrap();
        assert!(t.outcome.ok);
        assert_eq!(t.outcome.summary, "playing");

        // The current form round-trips through the same path.
        let now = ToolTrace {
            id: "c3".into(),
            name: "validate_pattern".into(),
            input: serde_json::json!({}),
            outcome: ToolOutcome::failed(ToolCategory::InvalidCode, "INVALID: x"),
            duration_ms: 12,
        };
        let json = serde_json::to_string(&now).unwrap();
        assert!(!json.contains("is_error"));
        let back: ToolTrace = serde_json::from_str(&json).unwrap();
        assert_eq!(back.outcome, now.outcome);
        assert_eq!(back.duration_ms, 12);
    }
}
