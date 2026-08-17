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

/// A compact record of one tool the assistant invoked during a turn, persisted
/// on the assistant [`ChatMessage`] so the model can recall what it already
/// tried on later turns — otherwise the tool exchange is lost to text-only
/// history and it re-tries the same things. Inputs are kept in full (they are
/// small and must round-trip back into a valid `tool_use` on replay); results
/// are truncated, since large payloads (file / corpus dumps) are what would
/// balloon per-turn input tokens if replayed verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTrace {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    pub result: String,
    #[serde(default)]
    pub is_error: bool,
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

