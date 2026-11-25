//! Cut a MIDI file into loop-sized single-voice parts for the Parts shelf.
//!
//! A converted track is a whole song. A part is the phrase a track keeps
//! coming back to: 1, 2, 4 or 8 bars. Each track is read bar by bar, repeated
//! phrases are found longest first, and each one is converted on its own
//! through the same pipeline as a normal import.

use crate::{CleanupOptions, ImportOptions, apply_cleanup, parse_note_name};
use midi_to_strudel::{
    MidiData, OutputFormatter, TrackBuilder,
    drums::is_drum_track_name,
    midi::{NoteEvent, TrackInfo, suggest_notes_per_bar},
    track::ChannelMask,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};

/// GM percussion channel (0-based).
const DRUM_CHANNEL: u8 = 9;
/// Phrase lengths looked for, in bars, longest first.
const LENGTHS: [usize; 4] = [8, 4, 2, 1];
/// Positions inside a bar are compared on this many steps.
const BAR_STEPS: f64 = 96.0;
/// Notes below this (C3) make a bass part.
const BASS_CEILING: f64 = 48.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Drums,
    Bass,
    Chords,
    Lead,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drums => "drums",
            Self::Bass => "bass",
            Self::Chords => "chords",
            Self::Lead => "lead",
        }
    }
}

pub struct PartOptions {
    /// Sounds, drum bank and cleanup, as for a normal import.
    pub import: ImportOptions,
    /// Most parts kept from one track.
    pub max_per_track: usize,
}

impl Default for PartOptions {
    /// Snapped to 16ths: a part is meant to be read and edited.
    fn default() -> Self {
        Self {
            import: ImportOptions {
                cleanup: CleanupOptions {
                    snap_per_bar: 16,
                    ..CleanupOptions::default()
                },
                ..ImportOptions::default()
            },
            max_per_track: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExtractedPart {
    /// Track position in the file, from 0.
    pub track: usize,
    pub track_name: Option<String>,
    pub role: Role,
    pub bars: usize,
    /// Bar the phrase first starts on, from 0.
    pub start_bar: usize,
    /// Times the phrase plays in the track. 1 when nothing repeated.
    pub occurrences: usize,
    /// Key the converter read from the notes, e.g. `C:minor`.
    pub key: Option<String>,
    /// Tempo that plays one bar per cycle, as `setbpm` counts it (4 beats a cycle).
    pub bpm: f64,
    /// One expression, ready to follow `$:`.
    pub code: String,
}

pub fn extract_parts(data: &[u8], opts: &PartOptions) -> anyhow::Result<Vec<ExtractedPart>> {
    let mut midi = MidiData::from_bytes(data)?;
    if opts.import.cleanup.is_active() {
        apply_cleanup(
            &mut midi,
            &opts.import.cleanup,
            opts.import.detect_drum_names,
        );
    }
    if !midi.cycle_len.is_finite() || midi.cycle_len <= 0.0 {
        return Ok(Vec::new());
    }
    let bar = BarClock {
        ticks: midi.cycle_ticks.filter(|&t| t > 0),
        seconds: midi.cycle_len,
    };

    let mut parts = Vec::new();
    let mut taken: HashSet<Vec<u64>> = HashSet::new();
    for (index, track) in midi.track_info.iter().enumerate() {
        if track.events.is_empty() {
            continue;
        }
        let drums = track.channel == Some(DRUM_CHANNEL)
            || (opts.import.detect_drum_names
                && track.name.as_deref().is_some_and(is_drum_track_name));
        let track = &TrackInfo {
            events: tidied(&track.events, drums),
            ..track.clone()
        };
        for phrase in phrases(&track.events, bar, opts.max_per_track) {
            if !taken.insert(phrase.print.clone()) {
                continue;
            }
            let window = cut(track, bar, phrase.start, phrase.bars);
            let role = if drums {
                Role::Drums
            } else {
                pitched_role(&window.events)
            };
            if !drums && !has_shape(&window.events, role, phrase.bars, bar) {
                continue;
            }
            let Some((code, key)) = convert(&window, &midi, phrase.bars, opts) else {
                continue;
            };
            parts.push(ExtractedPart {
                track: index,
                track_name: track.name.clone().filter(|n| {
                    let n = n.trim();
                    !n.is_empty() && !n.eq_ignore_ascii_case("untitled")
                }),
                role,
                bars: phrase.bars,
                start_bar: phrase.start,
                occurrences: phrase.occurrences,
                key: if drums { None } else { key },
                bpm: (240.0 / midi.cycle_len * 100.0).round() / 100.0,
                code,
            });
        }
    }
    Ok(parts)
}

/// The track ready to cut: drum notes on their GM numbers, and a note that
/// lands twice on one step (two hits snapped together) kept once.
fn tidied(events: &[NoteEvent], drums: bool) -> Box<[NoteEvent]> {
    let mut seen: HashSet<(u64, u64, String)> = HashSet::new();
    events
        .iter()
        .map(|ev| if drums { gm_hat(ev) } else { ev.clone() })
        .filter(|ev| {
            let ms = (ev.time_sec * 1000.0).round() as u64;
            seen.insert((ev.time_tick, ms, ev.note.clone()))
        })
        .collect()
}

/// Roland V-Drums send the hi-hat edge on notes below the General MIDI drum
/// range: 22 closed and 26 open. Move them to the GM hi-hats.
fn gm_hat(ev: &NoteEvent) -> NoteEvent {
    let note = match ev.note.as_str() {
        "A#0" | "Bb0" => "F#2",
        "D1" => "A#2",
        _ => return ev.clone(),
    };
    NoteEvent {
        note: note.to_string(),
        ..ev.clone()
    }
}

/// Bar length, in ticks when the file has a steady meter, else in seconds.
#[derive(Clone, Copy)]
struct BarClock {
    ticks: Option<u64>,
    seconds: f64,
}

impl BarClock {
    /// Onset in bars from the start of the file.
    fn position(self, ev: &NoteEvent) -> f64 {
        match self.ticks {
            Some(t) => ev.time_tick as f64 / t as f64,
            None => ev.time_sec / self.seconds,
        }
    }

    fn length(self, ev: &NoteEvent) -> f64 {
        match self.ticks {
            Some(t) => ev.duration_ticks as f64 / t as f64,
            None => ev.duration_sec / self.seconds,
        }
    }
}

struct Phrase {
    start: usize,
    bars: usize,
    occurrences: usize,
    /// The bar hashes, to spot the same notes doubled on another track.
    print: Vec<u64>,
}

/// Fewest separate onsets a phrase needs. One held note or chord is not a part.
const MIN_ONSETS: usize = 3;
/// Longest part kept, in characters. Past this the conversion is a tangle of
/// overlapping notes that nobody would edit.
const MAX_CODE: usize = 600;

/// One hash per bar of what sounds in it (0 for an empty bar), and how many
/// separate onsets the bar has.
fn fingerprints(events: &[NoteEvent], bar: BarClock) -> (Vec<u64>, Vec<usize>) {
    let mut bars: Vec<Vec<(u32, &str, u32)>> = Vec::new();
    for ev in events {
        let pos = bar.position(ev);
        if !pos.is_finite() || pos < 0.0 {
            continue;
        }
        let index = pos.floor() as usize;
        if bars.len() <= index {
            bars.resize_with(index + 1, Vec::new);
        }
        let step = ((pos - pos.floor()) * BAR_STEPS).round() as u32;
        let len = (bar.length(ev) * BAR_STEPS).round() as u32;
        bars[index].push((step, ev.note.as_str(), len));
    }
    bars.into_iter()
        .map(|mut notes| {
            if notes.is_empty() {
                return (0, 0);
            }
            notes.sort_unstable();
            let mut hasher = DefaultHasher::new();
            notes.hash(&mut hasher);
            notes.dedup_by_key(|n| n.0);
            (hasher.finish().max(1), notes.len())
        })
        .unzip()
}

/// The phrases a track repeats, best first. A track that never repeats gives
/// one phrase from its body instead.
fn phrases(events: &[NoteEvent], bar: BarClock, max: usize) -> Vec<Phrase> {
    let (prints, onsets) = fingerprints(events, bar);
    let usable = |start: usize, len: usize| {
        usable(&prints[start..start + len])
            && onsets[start..start + len].iter().sum::<usize>() >= MIN_ONSETS
    };
    let mut covered = vec![false; prints.len()];
    let mut found: Vec<Phrase> = Vec::new();

    for len in LENGTHS {
        let mut seen: HashMap<&[u64], Vec<usize>> = HashMap::new();
        for start in (0..prints.len().saturating_sub(len - 1)).step_by(len) {
            if usable(start, len) {
                seen.entry(&prints[start..start + len])
                    .or_default()
                    .push(start);
            }
        }
        let mut repeated: Vec<_> = seen.into_iter().filter(|(_, at)| at.len() > 1).collect();
        repeated.sort_by_key(|(_, at)| (std::cmp::Reverse(at.len()), at[0]));
        for (_, starts) in repeated {
            // Part of a longer phrase that was kept, unless it also repeats
            // on its own somewhere else.
            let alone = starts
                .iter()
                .filter(|&&s| !covered[s..s + len].iter().all(|&c| c))
                .count();
            if alone < 2 {
                continue;
            }
            for &s in &starts {
                covered[s..s + len].fill(true);
            }
            found.push(Phrase {
                start: starts[0],
                bars: len,
                occurrences: starts.len(),
                print: prints[starts[0]..starts[0] + len].to_vec(),
            });
        }
    }

    // A file of eight bars or fewer is one phrase already, unless most of it
    // is a shorter loop.
    let looped = covered.iter().filter(|&&c| c).count();
    if LENGTHS.contains(&prints.len()) && looped * 2 <= prints.len() && usable(0, prints.len()) {
        return vec![Phrase {
            start: 0,
            bars: prints.len(),
            occurrences: 1,
            print: prints,
        }];
    }

    if found.is_empty() {
        // Nothing repeats (live playing, a through-written melody). Take four
        // bars or fewer from a quarter of the way in, past any count-in.
        let first = LENGTHS.iter().filter(|&&len| len <= 4).find_map(|&len| {
            let starts: Vec<usize> = (0..prints.len().saturating_sub(len - 1))
                .step_by(len)
                .collect();
            let skip = starts.len() / 4;
            starts[skip..]
                .iter()
                .chain(&starts[..skip])
                .find(|&&s| usable(s, len))
                .map(|&start| Phrase {
                    start,
                    bars: len,
                    occurrences: 1,
                    print: prints[start..start + len].to_vec(),
                })
        });
        found.extend(first);
    }

    found.sort_by_key(|p| (std::cmp::Reverse(p.occurrences * p.bars), p.start));
    found.truncate(max);
    found
}

/// A phrase worth keeping: sounds in its first and last bar, is mostly not
/// rests, and is not a shorter phrase played twice.
fn usable(bars: &[u64]) -> bool {
    let n = bars.len();
    if bars[0] == 0 || bars[n - 1] == 0 {
        return false;
    }
    if bars.iter().filter(|&&b| b != 0).count() * 2 < n {
        return false;
    }
    n == 1 || bars[..n / 2] != bars[n / 2..]
}

/// The track cut down to `bars` bars from `start`, moved to the top of the file.
fn cut(track: &TrackInfo, bar: BarClock, start: usize, bars: usize) -> TrackInfo {
    TrackInfo {
        events: cut_events(&track.events, bar, start, bars),
        ..track.clone()
    }
}

fn cut_events(events: &[NoteEvent], bar: BarClock, start: usize, bars: usize) -> Box<[NoteEvent]> {
    match bar.ticks {
        Some(t) => {
            let offset = (start as u64).saturating_mul(t);
            let end = ((start + bars) as u64).saturating_mul(t);
            let per_tick = bar.seconds / t as f64;
            events
                .iter()
                .filter(|ev| (offset..end).contains(&ev.time_tick))
                .map(|ev| {
                    let mut ev = ev.clone();
                    ev.duration_ticks = ev.duration_ticks.min(end.saturating_sub(ev.time_tick));
                    ev.time_tick = ev.time_tick.saturating_sub(offset);
                    ev.time_sec = ev.time_tick as f64 * per_tick;
                    ev.duration_sec = ev.duration_ticks as f64 * per_tick;
                    ev
                })
                .collect()
        }
        None => {
            let (from, to) = (start as f64, (start + bars) as f64);
            events
                .iter()
                .filter(|ev| (from..to).contains(&bar.position(ev)))
                .map(|ev| {
                    let mut ev = ev.clone();
                    ev.duration_sec = ev
                        .duration_sec
                        .min((to * bar.seconds - ev.time_sec).max(0.0));
                    ev.time_sec = (ev.time_sec - from * bar.seconds).max(0.0);
                    ev
                })
                .collect()
        }
    }
}

/// Run one cut track through the converter. Gives the expression and the key
/// the converter named, or `None` when it produced nothing.
fn convert(
    track: &TrackInfo,
    midi: &MidiData,
    bars: usize,
    opts: &PartOptions,
) -> Option<(String, Option<String>)> {
    let import = &opts.import;
    let notes_per_bar = if import.auto_resolution {
        suggest_notes_per_bar(
            std::slice::from_ref(track),
            midi.cycle_ticks,
            midi.cycle_len,
        )
        .unwrap_or(import.notes_per_bar)
    } else {
        import.notes_per_bar
    };
    let builder = TrackBuilder::new(
        midi.cycle_len,
        midi.cycle_ticks,
        bars,
        notes_per_bar,
        import.detect_drum_names,
        ChannelMask::default(),
        import.drum_bank,
    );
    let mut tracks: Vec<_> = builder.build_tracks([track.clone()]).collect();
    if tracks.is_empty() {
        return None;
    }
    let formatter = OutputFormatter::new(import.tab_size, true, import.instrument_mode);
    let output = formatter.build_output(&mut tracks, midi.cycle_len);

    // `// Track 1: NAME (C:minor)` sits above the track.
    let key = output
        .lines()
        .find(|l| l.starts_with("// Track"))
        .and_then(|l| l.rsplit_once('(')?.1.strip_suffix(')'))
        .filter(|k| !k.ends_with(":chromatic"))
        .map(str::to_string);
    let code = output.split_once("$:")?.1.trim();
    // A drum track can come out as one `$:` per kit piece group; keep them together.
    let voices: Vec<&str> = code
        .split("\n$:")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    let code = match voices.as_slice() {
        [] => return None,
        [one] => (*one).to_string(),
        many => format!("stack(\n  {}\n)", many.join(",\n  ")),
    };
    if code.len() > MAX_CODE {
        return None;
    }
    // The converter breaks after the opening `<`; a short part reads better on one line.
    let code = if code.matches('\n').count() == 1 {
        code.replacen("<\n", "<", 1).replace("<    ", "<")
    } else {
        code
    };
    Some((code, key))
}

/// Most onsets a bar can average. Past 16ths it is a trill or a drum-roll
/// effect, not a line.
const MAX_ONSETS_PER_BAR: usize = 16;

/// A pitched phrase with something to it. A lead needs three pitches and must
/// not sit on one of them for more than two notes in three; a bass or chord
/// part can.
fn has_shape(events: &[NoteEvent], role: Role, bars: usize, bar: BarClock) -> bool {
    let onsets: HashSet<u64> = events
        .iter()
        .map(|ev| (bar.position(ev) * BAR_STEPS).round() as u64)
        .collect();
    if onsets.len() > MAX_ONSETS_PER_BAR * bars {
        return false;
    }
    if role != Role::Lead {
        return true;
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for ev in events {
        *counts.entry(ev.note.as_str()).or_default() += 1;
    }
    let most = counts.values().copied().max().unwrap_or(0);
    counts.len() >= 3 && most * 3 <= events.len() * 2
}

/// Bass, chords or lead, from the notes themselves.
fn pitched_role(events: &[NoteEvent]) -> Role {
    let mut pitches: Vec<f64> = events
        .iter()
        .filter_map(|ev| parse_note_name(&ev.note))
        .map(f64::from)
        .collect();
    if pitches.is_empty() {
        return Role::Lead;
    }

    let mut onsets: HashMap<u64, usize> = HashMap::new();
    for ev in events {
        *onsets
            .entry((ev.time_sec * 1000.0).round() as u64)
            .or_default() += 1;
    }
    let stacked = onsets.values().filter(|&&n| n >= 3).count();
    if stacked * 3 >= onsets.len() {
        return Role::Chords;
    }

    pitches.sort_by(f64::total_cmp);
    if pitches[pitches.len() / 2] < BASS_CEILING {
        Role::Bass
    } else {
        Role::Lead
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAR: u64 = 1920;

    fn clock() -> BarClock {
        BarClock {
            ticks: Some(BAR),
            seconds: 2.0,
        }
    }

    /// A quarter note on `beat` of `bar`.
    fn note(bar: u64, beat: u64, name: &str) -> NoteEvent {
        let tick = bar * BAR + beat * 480;
        NoteEvent {
            time_tick: tick,
            time_sec: tick as f64 / BAR as f64 * 2.0,
            note: name.to_string(),
            velocity: 90,
            duration_ticks: 480,
            duration_sec: 0.5,
            channel: 0,
        }
    }

    fn bar_of(bar: u64, names: [&str; 4]) -> Vec<NoteEvent> {
        (0..4).map(|b| note(bar, b, names[b as usize])).collect()
    }

    const A: [&str; 4] = ["C2", "C2", "D#2", "G2"];
    const B: [&str; 4] = ["F2", "F2", "G2", "A#2"];

    fn song(bars: &[[&str; 4]]) -> Vec<NoteEvent> {
        bars.iter()
            .enumerate()
            .flat_map(|(i, names)| bar_of(i as u64, *names))
            .collect()
    }

    fn found(events: &[NoteEvent]) -> Vec<(usize, usize, usize)> {
        phrases(events, clock(), 3)
            .iter()
            .map(|p| (p.start, p.bars, p.occurrences))
            .collect()
    }

    #[test]
    fn a_two_bar_loop_is_one_part_not_its_halves() {
        assert_eq!(found(&song(&[A, B, A, B, A, B, A, B])), [(0, 2, 4)]);
    }

    #[test]
    fn a_bar_that_also_repeats_alone_is_kept_too() {
        // A B A B, then A on its own four times.
        assert_eq!(
            found(&song(&[A, B, A, B, A, A, A, A])),
            [(0, 1, 6), (0, 2, 2)]
        );
    }

    #[test]
    fn a_track_that_never_repeats_gives_one_phrase() {
        let c = ["C3", "D3", "E3", "F3"];
        let d = ["G3", "A3", "B3", "C4"];
        assert_eq!(found(&song(&[A, B, c, d])), [(0, 4, 1)]);
    }

    #[test]
    fn a_short_file_is_kept_whole_when_only_its_start_repeats() {
        // An eight-bar progression whose two halves open the same way.
        let c = ["C3", "D3", "E3", "F3"];
        let d = ["G3", "A3", "B3", "C4"];
        let e = ["C4", "B3", "A3", "G3"];
        let f = ["F3", "E3", "D3", "C3"];
        assert_eq!(found(&song(&[A, B, c, d, A, B, e, f])), [(0, 8, 1)]);
    }

    #[test]
    fn a_held_note_is_not_a_part() {
        let events: Vec<_> = (0..8).map(|bar| note(bar, 0, "E2")).collect();
        assert!(phrases(&events, clock(), 3).iter().all(|p| p.bars >= 4));
    }

    #[test]
    fn the_cut_starts_at_zero_and_stays_in_its_bars() {
        let cut = cut_events(&song(&[A, B, A, B]), clock(), 2, 2);
        assert_eq!(cut.len(), 8);
        assert_eq!(cut[0].time_tick, 0);
        assert!(
            cut.iter()
                .all(|e| e.time_tick + e.duration_ticks <= 2 * BAR)
        );
    }

    #[test]
    fn a_lead_needs_more_than_one_repeated_note() {
        let riff = song(&[["C4", "E4", "G4", "E4"]]);
        assert!(has_shape(&riff, Role::Lead, 1, clock()));
        let drone = song(&[["C4", "C4", "C4", "D4"]]);
        assert!(!has_shape(&drone, Role::Lead, 1, clock()));
        assert!(has_shape(&drone, Role::Bass, 1, clock()));
    }

    #[test]
    fn two_hits_on_one_step_are_one() {
        let events = [note(0, 0, "D2"), note(0, 0, "D2"), note(0, 1, "D2")];
        assert_eq!(tidied(&events, true).len(), 2);
    }

    #[test]
    fn roles_come_from_the_notes() {
        assert_eq!(pitched_role(&song(&[A])), Role::Bass);
        assert_eq!(pitched_role(&song(&[["C4", "E4", "G4", "B4"]])), Role::Lead);
        let chord: Vec<_> = ["C4", "E4", "G4"].iter().map(|n| note(0, 0, n)).collect();
        assert_eq!(pitched_role(&chord), Role::Chords);
    }
}
