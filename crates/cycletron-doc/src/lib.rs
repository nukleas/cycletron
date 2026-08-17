//! Surgical `.strudel` document editing: the text/line-span models behind the
//! agent's targeted write tools. Extracted from the Tauri app so the same
//! editing rules are testable (and reusable) without a GUI.
//!
//! - [`tracks`] — `$:`-track model: address, upsert, mute one track by id.
//! - [`sections`] — `pickRestart`/`arrange` section spans: rewrite one section.
//! - [`structure`] — AST-backed `let` binding splices.
//!
//! Every operation is span-based; untouched lines stay byte-identical. The
//! caller re-validates the full buffer through the evaluator before anything
//! reaches audio.

pub mod sections;
pub mod structure;
pub mod tracks;
