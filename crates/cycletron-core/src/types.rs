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

/// Musical role label for a corpus part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MusicalRole {
    DrumGroove,
    Bassline,
    MelodicHook,
    HarmonyLoop,
    TextureBed,
    TransitionSeed,
    ArrangementSeed,
    RemixSeed,
}

/// An extracted part from a corpus entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusPart {
    pub source_id: String,
    pub role: MusicalRole,
    pub code: String,
    pub label: Option<String>,
}

/// Query parameters for corpus search.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CorpusQuery {
    pub tags: Vec<String>,
    pub role: Option<MusicalRole>,
    pub tempo_min: Option<f64>,
    pub tempo_max: Option<f64>,
    pub complexity: Option<String>,
    pub sounds: Vec<String>,
    pub keyword: Option<String>,
    pub limit: Option<usize>,
}

/// A message in the chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    pub timestamp: DateTime<Utc>,
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

/// Outcome of an agent session, used for the learning capture system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionOutcome {
    pub session_id: String,
    pub timestamp: DateTime<Utc>,
    pub patterns_generated: Vec<String>,
    pub patterns_accepted: Vec<String>,
    pub patterns_rejected: Vec<String>,
    pub corpus_entries_used: Vec<String>,
    pub user_feedback: Option<String>,
}

/// A memory entry for the three-tier memory system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub key: String,
    pub tier: MemoryTier,
    pub content: String,
    pub created: DateTime<Utc>,
    pub updated: DateTime<Utc>,
    pub access_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryTier {
    /// Always loaded into every prompt.
    AlwaysLoaded,
    /// Auto-loaded for recent sessions.
    SessionContext,
    /// Retrieved on demand via search.
    FullCorpus,
}
