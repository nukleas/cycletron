//! MIDI → Strudel conversion. Wraps the sibling `midi-to-strudel` crate.
//!
//! The upstream crate is CLI-shaped: its `run()` function takes parsed
//! `ConversionArgs` and writes to disk. We mirror the conversion pipeline
//! directly so we can take a byte slice and return a `String`, no files.

use midi_to_strudel::{
    InstrumentMode, MidiData, OutputFormatter, SectionNamingStrategy, TrackBuilder,
    drums::{DrumBank, is_drum_track_name},
    midi::suggest_notes_per_bar,
    track::ChannelMask,
};
use serde::Serialize;

pub struct ImportOptions {
    /// Resolution per bar (4, 8, 16, 32, 64…). When `auto_resolution`, ignored.
    pub notes_per_bar: usize,
    /// Let the converter pick the smallest faithful resolution. Recommended.
    pub auto_resolution: bool,
    /// 0 = no limit. Otherwise caps output length.
    pub bar_limit: usize,
    /// Tab width in the generated strudel code.
    pub tab_size: usize,
    /// Compact repeated bars with `!`. (In `compose` mode each section is
    /// always `!`-compressed upstream, so this flag only affects flat output.)
    pub compact: bool,
    /// Emit a section-based arrangement (`"<intro@4 …>".pickRestart({…})`)
    /// instead of flat `$:` tracks. Detects song sections and stacks each
    /// track's bars per section.
    pub compose: bool,
    /// How detected sections are named in `compose` mode (heuristic
    /// intro/verse/chorus vs generic a/b/c).
    pub section_naming: SectionNamingStrategy,
    /// GM vs waveforms vs hybrid.
    pub instrument_mode: InstrumentMode,
    /// Drum sample bank.
    pub drum_bank: DrumBank,
    /// Detect drum tracks by name (kick/snare/hat/…).
    pub detect_drum_names: bool,
    /// MIDI channels (0-15) to *include* in the output. `None` = all.
    /// Tracks with no channel are always kept.
    pub included_channels: Option<Vec<u8>>,
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self {
            notes_per_bar: 64,
            auto_resolution: true,
            bar_limit: 0,
            tab_size: 2,
            compact: false,
            compose: false,
            section_naming: SectionNamingStrategy::Heuristic,
            instrument_mode: InstrumentMode::Hybrid,
            drum_bank: DrumBank::Simple,
            detect_drum_names: true,
            included_channels: None,
        }
    }
}

pub struct ImportResult {
    pub code: String,
    pub bpm: f64,
}

/// Per-track summary surfaced to the UI for the MIDI Lab. Independent of
/// the upstream `midi_to_strudel::midi::TrackInfo` (which is internal-ish
/// and not Serialize-friendly).
#[derive(Debug, Clone, Serialize)]
pub struct PublicTrackInfo {
    pub index: usize,
    pub channel: Option<u8>,
    pub program: Option<u8>,
    pub name: Option<String>,
    pub note_count: usize,
    pub is_drum: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MidiMetadata {
    pub bpm: f64,
    pub cycle_len: f64,
    pub tracks: Vec<PublicTrackInfo>,
}

/// Convert MIDI bytes into strudel code + detected tempo.
pub fn convert_bytes(data: &[u8], opts: &ImportOptions) -> anyhow::Result<ImportResult> {
    let midi = MidiData::from_bytes(data)?;
    let bpm = midi.bpm;

    let notes_per_bar = if opts.auto_resolution {
        suggest_notes_per_bar(&midi.track_info, midi.cycle_ticks)
            .unwrap_or(opts.notes_per_bar)
    } else {
        opts.notes_per_bar
    };

    // Optional channel filter — applied before the (expensive) track build.
    // `included_channels` is a positive set: keep tracks whose channel is in
    // the set, plus any track that has no channel (rare, but safe to keep).
    let filtered_info: Box<[_]> = match opts.included_channels.as_deref() {
        Some(allowed) if !allowed.is_empty() => midi
            .track_info
            .into_vec()
            .into_iter()
            .filter(|t| t.channel.map_or(true, |c| allowed.contains(&c)))
            .collect(),
        _ => midi.track_info,
    };

    let builder = TrackBuilder::new(
        midi.cycle_len,
        midi.cycle_ticks,
        opts.bar_limit,
        notes_per_bar,
        opts.detect_drum_names,
        ChannelMask::default(),
        opts.drum_bank,
    );

    let mut tracks: Vec<_> = builder.build_tracks(filtered_info).collect();
    if tracks.is_empty() {
        anyhow::bail!("MIDI file contains no convertible tracks (check channel filter)");
    }

    let formatter = OutputFormatter::new(opts.tab_size, opts.compact, opts.instrument_mode);
    let code = if opts.compose {
        // Section-based arrangement. Upstream prefixes a `setcpm(N)` line; we
        // drop it so the app's BPM pathway (`applyBpm` / frontmatter bpm) stays
        // the single source of truth, exactly as for flat output.
        strip_leading_setcpm(formatter.build_composed_output(
            &tracks,
            midi.cycle_len,
            opts.section_naming,
        ))
    } else {
        formatter.build_output(&mut tracks, midi.cycle_len)
    };

    Ok(ImportResult { code, bpm })
}

/// Drop a leading `setcpm(...)` line (and the blank line after it) from
/// generated code. The composed-output path bakes tempo into the code; we
/// strip it so tempo is carried out-of-band via `ImportResult::bpm` like the
/// flat path. A no-op when the code doesn't start with `setcpm(`.
fn strip_leading_setcpm(code: String) -> String {
    let trimmed = code.trim_start();
    if !trimmed.starts_with("setcpm(") {
        return code;
    }
    // Drop everything up to and including the first newline, then any blank
    // lines that immediately follow.
    match trimmed.split_once('\n') {
        Some((_, rest)) => rest.trim_start_matches('\n').to_string(),
        None => String::new(),
    }
}

pub fn convert_file(path: &std::path::Path, opts: &ImportOptions) -> anyhow::Result<ImportResult> {
    let data = std::fs::read(path)?;
    convert_bytes(&data, opts)
}

/// Inspect a MIDI file without converting it. Surfaces enough metadata for
/// the MIDI Lab to render a track list and decide what to include.
pub fn inspect_bytes(data: &[u8]) -> anyhow::Result<MidiMetadata> {
    let midi = MidiData::from_bytes(data)?;
    let tracks = midi
        .track_info
        .iter()
        .enumerate()
        .map(|(index, t)| {
            let channel = t.channel;
            let name = t.name.clone();
            let is_drum = channel == Some(9)
                || name
                    .as_deref()
                    .map(is_drum_track_name)
                    .unwrap_or(false);
            PublicTrackInfo {
                index,
                channel,
                program: t.program.map(|p| p as u8),
                name,
                note_count: t.events.len(),
                is_drum,
            }
        })
        .collect();
    Ok(MidiMetadata {
        bpm: midi.bpm,
        cycle_len: midi.cycle_len,
        tracks,
    })
}

pub fn inspect_file(path: &std::path::Path) -> anyhow::Result<MidiMetadata> {
    let data = std::fs::read(path)?;
    inspect_bytes(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test the pipeline with a real MIDI file from the corpus.
    /// Skipped when the fixture isn't present (so CI on a fresh checkout
    /// that doesn't include strudel-corpus still passes).
    #[test]
    fn converts_real_midi() {
        let candidate = std::path::Path::new(
            "../../strudel-corpus/normalized/midi/toms-diner-suzanne-vega__d88c1f79.mid",
        );
        if !candidate.exists() {
            eprintln!("skipping MIDI smoke test: fixture not found");
            return;
        }
        let opts = ImportOptions::default();
        let result = convert_file(candidate, &opts).expect("should convert");
        assert!(result.code.len() > 20, "expected non-trivial strudel code");
        assert!(result.bpm > 0.0);
    }

    fn fixture() -> Option<&'static std::path::Path> {
        let p = std::path::Path::new(
            "../../strudel-corpus/normalized/midi/toms-diner-suzanne-vega__d88c1f79.mid",
        );
        p.exists().then_some(p)
    }

    /// Composed output must use `pickRestart`, carry no embedded `setcpm`
    /// (tempo is out-of-band via `result.bpm`), and validate through the same
    /// engine the REPL uses.
    #[test]
    fn compose_emits_valid_pickrestart() {
        let Some(path) = fixture() else {
            eprintln!("skipping compose test: fixture not found");
            return;
        };
        let opts = ImportOptions {
            compose: true,
            ..Default::default()
        };
        let result = convert_file(path, &opts).expect("should convert");
        assert!(
            result.code.contains("pickRestart"),
            "composed output should use pickRestart, got:\n{}",
            result.code
        );
        assert!(
            !result.code.contains("setcpm"),
            "composed output should not embed setcpm, got:\n{}",
            result.code
        );
        crate::strudel::validate_code(&result.code)
            .unwrap_or_else(|e| panic!("composed output should validate: {e}\n{}", result.code));
    }

    /// compose + compact compose: still valid, and the `!` replication operator
    /// shows up in the per-section patterns.
    #[test]
    fn compose_with_compact_validates() {
        let Some(path) = fixture() else {
            eprintln!("skipping compose+compact test: fixture not found");
            return;
        };
        let opts = ImportOptions {
            compose: true,
            compact: true,
            ..Default::default()
        };
        let result = convert_file(path, &opts).expect("should convert");
        crate::strudel::validate_code(&result.code)
            .unwrap_or_else(|e| panic!("compose+compact should validate: {e}\n{}", result.code));
    }

    #[test]
    fn strip_leading_setcpm_drops_tempo_line() {
        let with = "setcpm(120)\n\n$: s(\"bd*4\")".to_string();
        assert_eq!(strip_leading_setcpm(with), "$: s(\"bd*4\")");
        // No-op when there's no leading setcpm.
        let without = "$: s(\"bd*4\")".to_string();
        assert_eq!(strip_leading_setcpm(without.clone()), without);
    }
}
