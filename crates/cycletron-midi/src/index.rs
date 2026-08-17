//! Wire format for `<dataset>.index.json` — the manifest `midi-ingest` writes
//! and `strudel-search` reads. One type pair for both sides, so a field added
//! to the writer can't silently vanish from the reader.

use serde::{Deserialize, Serialize};

/// One converted (or failed) MIDI file in a dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub source: String,
    pub stem: String,
    /// Parent folder name — for artist-organized sets (clean_midi) this is the
    /// artist; useful metadata + disambiguates same-titled songs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default)]
    pub bpm: f64,
    #[serde(default)]
    pub valid: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Length of the converted strudel code in bytes.
    #[serde(default)]
    pub code_len: usize,
    /// Relative path (under the out dir) to the converted `.strudel`, if valid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strudel: Option<String>,
}

/// A dataset manifest: every walked MIDI file, valid or not.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    #[serde(default)]
    pub dataset: String,
    #[serde(default)]
    pub source_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default)]
    pub bars: usize,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub valid: usize,
    pub entries: Vec<Entry>,
}
