//! MIDI → Strudel conversion. Wraps the sibling `midi-to-strudel` crate.
//!
//! The upstream crate is CLI-shaped: its `run()` function takes parsed
//! `ConversionArgs` and writes to disk. We mirror the conversion pipeline
//! directly so we can take a byte slice and return a `String`, no files.
//!
//! Before conversion we optionally run a **conservative cleanup** (short ghost
//! notes, exact/overlap duplicates, velocity clamp) so imports are smoother
//! without mutating the source file on disk.

pub mod index;

use midi_to_strudel::{
    InstrumentMode, MidiData, OutputFormatter, SectionNamingStrategy, TrackBuilder,
    drums::{DrumBank, is_drum_track_name},
    midi::{NoteEvent, suggest_notes_per_bar},
    track::ChannelMask,
};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// How aggressively to clamp note velocities before conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VelocityMode {
    /// Leave velocities untouched.
    Off,
    /// Soft clamp into ~56–108 (default).
    #[default]
    Moderate,
    /// Tighter clamp into ~64–100.
    Strong,
}

impl VelocityMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "off" | "none" | "raw" => Some(Self::Off),
            "moderate" | "med" | "medium" => Some(Self::Moderate),
            "strong" | "tight" => Some(Self::Strong),
            _ => None,
        }
    }

    fn range(self) -> Option<(u8, u8)> {
        match self {
            Self::Off => None,
            Self::Moderate => Some((56, 108)),
            Self::Strong => Some((64, 100)),
        }
    }
}

/// Conservative note-level cleanup applied **in memory** before conversion.
/// The source `.mid` file is never rewritten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupOptions {
    /// Drop notes shorter than `1/N` of a quarter note (by duration).
    /// `0` disables. Typical: 16 / 32 / 64. Default 32 (very short ghosts only).
    pub short_note_divisor: u32,
    /// Drop exact-onset duplicates and heavy same-pitch overlaps, keeping the
    /// longer / louder note.
    pub remove_duplicates: bool,
    pub velocity_mode: VelocityMode,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            short_note_divisor: 32,
            remove_duplicates: true,
            velocity_mode: VelocityMode::Moderate,
        }
    }
}

impl CleanupOptions {
    /// No cleanup at all — pass notes through as parsed.
    pub fn off() -> Self {
        Self {
            short_note_divisor: 0,
            remove_duplicates: false,
            velocity_mode: VelocityMode::Off,
        }
    }

    pub fn is_active(&self) -> bool {
        self.short_note_divisor > 0
            || self.remove_duplicates
            || self.velocity_mode != VelocityMode::Off
    }
}

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
    /// Pre-conversion note cleanup. Defaults to conservative-on.
    pub cleanup: CleanupOptions,
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
            cleanup: CleanupOptions::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Results / analysis
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct CleanupReport {
    pub notes_before: usize,
    pub notes_after: usize,
    pub removed_short: usize,
    pub removed_duplicates: usize,
    pub velocity_adjusted: usize,
}

pub struct ImportResult {
    pub code: String,
    pub bpm: f64,
    pub cleanup: CleanupReport,
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
    /// Lowest MIDI note number on this track, if any pitched notes.
    pub pitch_min: Option<u8>,
    /// Highest MIDI note number on this track, if any pitched notes.
    pub pitch_max: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MidiMetadata {
    pub bpm: f64,
    pub cycle_len: f64,
    pub tracks: Vec<PublicTrackInfo>,
    /// End time of the last note-off (seconds).
    pub duration_secs: f64,
    /// Total note-on events across all tracks.
    pub note_count: usize,
    pub pitch_min: Option<u8>,
    pub pitch_max: Option<u8>,
    /// Human label like `C3–A5`, or empty when no pitched notes.
    pub pitch_range_label: String,
    /// Peak simultaneous note count (rough polyphony).
    pub max_polyphony: usize,
    /// Distinct MIDI channels that have notes.
    pub channel_count: usize,
    /// Distinct GM program numbers present (track-level).
    pub programs: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/// Convert MIDI bytes into strudel code + detected tempo.
pub fn convert_bytes(data: &[u8], opts: &ImportOptions) -> anyhow::Result<ImportResult> {
    let mut midi = MidiData::from_bytes(data)?;
    let bpm = midi.bpm;

    let cleanup = if opts.cleanup.is_active() {
        apply_cleanup(&mut midi, &opts.cleanup)
    } else {
        CleanupReport {
            notes_before: count_notes(&midi),
            notes_after: count_notes(&midi),
            ..CleanupReport::default()
        }
    };

    let notes_per_bar = if opts.auto_resolution {
        suggest_notes_per_bar(&midi.track_info, midi.cycle_ticks, midi.cycle_len)
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
            .filter(|t| t.channel.is_none_or(|c| allowed.contains(&c)))
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

    Ok(ImportResult { code, bpm, cleanup })
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

// ---------------------------------------------------------------------------
// Inspect / analysis
// ---------------------------------------------------------------------------

/// Inspect a MIDI file without converting it. Surfaces enough metadata for
/// the MIDI Lab to render a track list, score brief, and decide what to include.
pub fn inspect_bytes(data: &[u8]) -> anyhow::Result<MidiMetadata> {
    let midi = MidiData::from_bytes(data)?;
    Ok(analyze_midi(&midi))
}

pub fn inspect_file(path: &std::path::Path) -> anyhow::Result<MidiMetadata> {
    let data = std::fs::read(path)?;
    inspect_bytes(&data)
}

fn analyze_midi(midi: &MidiData) -> MidiMetadata {
    let mut duration_secs = 0.0_f64;
    let mut note_count = 0usize;
    let mut pitch_min: Option<u8> = None;
    let mut pitch_max: Option<u8> = None;
    let mut channels = std::collections::BTreeSet::new();
    let mut programs = std::collections::BTreeSet::new();
    let mut sweep: Vec<(f64, i32)> = Vec::new();

    let tracks: Vec<PublicTrackInfo> = midi
        .track_info
        .iter()
        .enumerate()
        .map(|(index, t)| {
            let channel = t.channel;
            let name = t.name.clone();
            let is_drum =
                channel == Some(9) || name.as_deref().map(is_drum_track_name).unwrap_or(false);
            #[expect(
                clippy::redundant_closure_for_method_calls,
                reason = "MidiNoteNumber's path is not re-exported by midi-to-strudel"
            )]
            let program = t.program.map(|p| p.get());
            if let Some(p) = program {
                programs.insert(p);
            }

            let mut t_min: Option<u8> = None;
            let mut t_max: Option<u8> = None;
            for ev in t.events.iter() {
                note_count += 1;
                channels.insert(ev.channel);
                let end = ev.time_sec + ev.duration_sec;
                if end > duration_secs {
                    duration_secs = end;
                }
                if let Some(midi_n) = parse_note_name(&ev.note) {
                    t_min = Some(t_min.map_or(midi_n, |m| m.min(midi_n)));
                    t_max = Some(t_max.map_or(midi_n, |m| m.max(midi_n)));
                    pitch_min = Some(pitch_min.map_or(midi_n, |m| m.min(midi_n)));
                    pitch_max = Some(pitch_max.map_or(midi_n, |m| m.max(midi_n)));
                }
                // +1 at onset, -1 at offset for polyphony sweep.
                sweep.push((ev.time_sec, 1));
                sweep.push((ev.time_sec + ev.duration_sec.max(1e-6), -1));
            }

            PublicTrackInfo {
                index,
                channel,
                program,
                name,
                note_count: t.events.len(),
                is_drum,
                pitch_min: t_min,
                pitch_max: t_max,
            }
        })
        .collect();

    let max_polyphony = max_polyphony_from_sweep(&mut sweep);

    MidiMetadata {
        bpm: midi.bpm,
        cycle_len: midi.cycle_len,
        tracks,
        duration_secs,
        note_count,
        pitch_min,
        pitch_max,
        pitch_range_label: pitch_range_label(pitch_min, pitch_max),
        max_polyphony,
        channel_count: channels.len(),
        programs: programs.into_iter().collect(),
    }
}

fn max_polyphony_from_sweep(sweep: &mut [(f64, i32)]) -> usize {
    // Sort by time; at equal times process note-offs (-1) before note-ons (+1)
    // so instantaneous re-triggers don't inflate the peak.
    sweep.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    let mut cur = 0i32;
    let mut max = 0i32;
    for &(_, delta) in sweep.iter() {
        cur += delta;
        if cur > max {
            max = cur;
        }
    }
    max.max(0) as usize
}

fn pitch_range_label(min: Option<u8>, max: Option<u8>) -> String {
    match (min, max) {
        (Some(a), Some(b)) if a == b => midi_to_label(a),
        (Some(a), Some(b)) => format!("{}–{}", midi_to_label(a), midi_to_label(b)),
        _ => String::new(),
    }
}

fn midi_to_label(midi: u8) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let octave = (midi as i32 / 12) - 1;
    format!("{}{}", NAMES[(midi % 12) as usize], octave)
}

/// Parse Western pitch labels produced by midi-to-strudel (`C4`, `Db3`, `F#5`).
fn parse_note_name(s: &str) -> Option<u8> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let letter = (bytes[0] as char).to_ascii_lowercase();
    let base = match letter {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let mut semitone = base;
    let mut i = 1;
    // Accidentals after the letter. `b4` is note B (next char is digit);
    // `Bb4` / `bb4` is B-flat (extra `b` accidental).
    while i < bytes.len() {
        match bytes[i] {
            b'#' | b's' | b'S' => {
                semitone += 1;
                i += 1;
            }
            b'b' => {
                semitone -= 1;
                i += 1;
            }
            _ => break,
        }
    }
    let rest = &s[i..];
    let octave = if rest.is_empty() {
        4
    } else {
        rest.parse::<i32>().ok()?
    };
    let midi = (octave + 1) * 12 + semitone;
    (0..=127).contains(&midi).then_some(midi as u8)
}

fn count_notes(midi: &MidiData) -> usize {
    midi.track_info.iter().map(|t| t.events.len()).sum()
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/// Apply cleanup options to every track's note list. Source file is untouched.
pub fn apply_cleanup(midi: &mut MidiData, opts: &CleanupOptions) -> CleanupReport {
    let mut report = CleanupReport {
        notes_before: count_notes(midi),
        ..CleanupReport::default()
    };
    if !opts.is_active() {
        report.notes_after = report.notes_before;
        return report;
    }

    let bpm = if midi.bpm.is_finite() && midi.bpm > 0.0 {
        midi.bpm
    } else {
        120.0
    };
    let quarter_sec = 60.0 / bpm;
    let short_threshold = if opts.short_note_divisor > 0 {
        Some(quarter_sec / f64::from(opts.short_note_divisor))
    } else {
        None
    };
    let vel_range = opts.velocity_mode.range();

    // track_info is a Box<[TrackInfo]>; rebuild each events slice.
    for track in midi.track_info.iter_mut() {
        let mut events: Vec<NoteEvent> = track.events.to_vec();
        let (short, dups, vel) = cleanup_event_list(
            &mut events,
            short_threshold,
            opts.remove_duplicates,
            vel_range,
        );
        report.removed_short += short;
        report.removed_duplicates += dups;
        report.velocity_adjusted += vel;
        track.events = events.into_boxed_slice();
    }

    report.notes_after = count_notes(midi);
    report
}

/// Pure cleanup over a flat note list. Returns (removed_short, removed_dups, velocity_adjusted).
fn cleanup_event_list(
    events: &mut Vec<NoteEvent>,
    short_threshold: Option<f64>,
    remove_duplicates: bool,
    vel_range: Option<(u8, u8)>,
) -> (usize, usize, usize) {
    // 1. Short notes.
    let mut removed_short = 0usize;
    if let Some(thresh) = short_threshold {
        events.retain(|ev| {
            // Zero-duration / missing-off notes are almost always noise.
            let short =
                ev.duration_sec < thresh || (ev.duration_ticks == 0 && ev.duration_sec <= 0.0);
            if short {
                removed_short += 1;
                false
            } else {
                true
            }
        });
    }

    // 2. Duplicates / heavy overlaps on the same channel+pitch.
    let mut removed_dups = 0usize;
    if remove_duplicates && events.len() > 1 {
        let before = events.len();
        *events = greedy_keep_non_overlapping(std::mem::take(events));
        removed_dups = before.saturating_sub(events.len());
    }

    // 3. Velocity clamp.
    let mut velocity_adjusted = 0usize;
    if let Some((lo, hi)) = vel_range {
        for ev in events.iter_mut() {
            if ev.velocity == 0 {
                continue;
            }
            let clamped = ev.velocity.clamp(lo, hi);
            if clamped != ev.velocity {
                velocity_adjusted += 1;
                ev.velocity = clamped;
            }
        }
    }

    (removed_short, removed_dups, velocity_adjusted)
}

/// Keep non-overlapping notes per (channel, pitch). When two notes of the same
/// pitch on the same channel overlap (or share an onset), keep the longer one
/// (tie-break: higher velocity). Later partial overlaps are dropped.
fn greedy_keep_non_overlapping(mut events: Vec<NoteEvent>) -> Vec<NoteEvent> {
    if events.len() <= 1 {
        return events;
    }
    // Sort: channel, note, time, longer duration first, louder first.
    events.sort_by(|a, b| {
        a.channel
            .cmp(&b.channel)
            .then_with(|| a.note.cmp(&b.note))
            .then_with(|| a.time_tick.cmp(&b.time_tick))
            .then_with(|| b.duration_ticks.cmp(&a.duration_ticks))
            .then_with(|| b.velocity.cmp(&a.velocity))
    });

    let mut kept: Vec<NoteEvent> = Vec::with_capacity(events.len());
    for ev in events {
        let start = ev.time_tick;
        let end = start.saturating_add(ev.duration_ticks.max(1));
        let conflicts = kept
            .iter()
            .rev()
            .take_while(|k| k.channel == ev.channel && k.note == ev.note)
            .any(|k| {
                let k_end = k.time_tick.saturating_add(k.duration_ticks.max(1));
                start < k_end && k.time_tick < end
            });
        if !conflicts {
            kept.push(ev);
        }
    }

    // Restore chronological order for the converter.
    kept.sort_by(|a, b| {
        a.time_tick
            .cmp(&b.time_tick)
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.note.cmp(&b.note))
    });
    kept
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn note(tick: u64, dur: u64, name: &str, vel: u8, ch: u8) -> NoteEvent {
        NoteEvent {
            time_tick: tick,
            time_sec: tick as f64 / 480.0 * 0.5, // arbitrary
            note: name.to_string(),
            velocity: vel,
            duration_ticks: dur,
            duration_sec: dur as f64 / 480.0 * 0.5,
            channel: ch,
        }
    }

    #[test]
    fn parse_note_names() {
        assert_eq!(parse_note_name("C4"), Some(60));
        assert_eq!(parse_note_name("c4"), Some(60));
        assert_eq!(parse_note_name("C#4"), Some(61));
        assert_eq!(parse_note_name("Db4"), Some(61));
        assert_eq!(parse_note_name("Bb4"), Some(70));
        assert_eq!(parse_note_name("b4"), Some(71)); // note B, not flat
        assert_eq!(parse_note_name("A0"), Some(21));
        assert_eq!(parse_note_name("bd"), None);
    }

    #[test]
    fn drops_short_notes() {
        let mut events = vec![
            note(0, 120, "C4", 80, 0), // long enough
            note(120, 1, "D4", 40, 0), // ghost
            note(240, 100, "E4", 70, 0),
        ];
        // threshold high enough to kill the 1-tick ghost
        let (short, dups, _) = cleanup_event_list(&mut events, Some(0.01), false, None);
        assert_eq!(short, 1);
        assert_eq!(dups, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].note, "C4");
        assert_eq!(events[1].note, "E4");
    }

    #[test]
    fn drops_same_onset_duplicates() {
        let mut events = vec![
            note(0, 100, "C4", 80, 0),
            note(0, 40, "C4", 60, 0), // same onset, shorter
            note(200, 80, "D4", 70, 0),
        ];
        let (short, dups, _) = cleanup_event_list(&mut events, None, true, None);
        assert_eq!(short, 0);
        assert_eq!(dups, 1);
        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .any(|e| e.note == "C4" && e.duration_ticks == 100)
        );
    }

    #[test]
    fn drops_overlapping_same_pitch() {
        let mut events = vec![
            note(0, 200, "C4", 80, 0),
            note(50, 50, "C4", 90, 0),   // fully inside the first
            note(300, 100, "C4", 70, 0), // after — keep
        ];
        let (_, dups, _) = cleanup_event_list(&mut events, None, true, None);
        assert_eq!(dups, 1);
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn clamps_velocity() {
        let mut events = vec![
            note(0, 100, "C4", 10, 0),
            note(100, 100, "D4", 120, 0),
            note(200, 100, "E4", 80, 0),
        ];
        let (_, _, adj) = cleanup_event_list(&mut events, None, false, Some((56, 108)));
        assert_eq!(adj, 2);
        assert_eq!(events[0].velocity, 56);
        assert_eq!(events[1].velocity, 108);
        assert_eq!(events[2].velocity, 80);
    }

    #[test]
    fn polyphony_counts_overlap() {
        let mut sweep = vec![
            (0.0, 1),
            (0.0, 1),
            (1.0, -1),
            (1.0, -1),
            (2.0, 1),
            (3.0, -1),
        ];
        assert_eq!(max_polyphony_from_sweep(&mut sweep), 2);
    }

    /// Smoke test the pipeline with a real MIDI file from the corpus.
    /// Skipped when the fixture isn't present (so CI on a fresh checkout
    /// that doesn't include strudel-corpus still passes).
    #[test]
    fn converts_real_midi() {
        let candidate = std::path::Path::new(
            "../../../strudel-corpus/normalized/midi/toms-diner-suzanne-vega__d88c1f79.mid",
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
            "../../../strudel-corpus/normalized/midi/toms-diner-suzanne-vega__d88c1f79.mid",
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
        cycletron_analysis::validate_code(&result.code)
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
        cycletron_analysis::validate_code(&result.code)
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

    #[test]
    fn inspect_reports_analysis_fields() {
        let Some(path) = fixture() else {
            eprintln!("skipping inspect test: fixture not found");
            return;
        };
        let meta = inspect_file(path).expect("inspect");
        assert!(meta.note_count > 0);
        assert!(meta.duration_secs > 0.0);
        assert!(meta.max_polyphony >= 1);
        assert!(!meta.tracks.is_empty());
    }
}
