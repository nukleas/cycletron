//! Pattern inspection: validate a code string, execute it, and fold the
//! resulting haps into a serializable [`PatternDigest`] (events, sounds, pitch
//! range, loop period, voice count), plus the note/value decoding helpers the
//! rest of the crate builds on.

use serde::Serialize;
use strudel_core::{ContextKey, Hap, Value, ValueTypeTag};

use crate::execute::execute;

pub fn validate_code(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Ok(());
    }
    execute(code).map(|_| ())
}

/// A structured digest of what a pattern actually emits when queried, so the
/// agent (and the UI) can "see" a pattern instead of composing blind. Built by
/// querying the evaluated pattern cycle-by-cycle and summarising the haps.
#[derive(Debug, Clone, Serialize)]
pub struct PatternDigest {
    /// Number of cycles queried (the inspection window).
    pub cycles_queried: usize,
    /// Tempo in BPM if the code set one (`setbpm`/`setcpm`); else None.
    pub bpm: Option<f64>,
    /// Seconds per cycle at that tempo (for length math); None if no tempo.
    pub seconds_per_cycle: Option<f64>,
    /// Total onset events across the whole window.
    pub total_events: usize,
    /// Smallest loop length (in cycles) detected within the window, if the
    /// pattern repeats. None means it didn't repeat within the window
    /// (longer period, or aperiodic — e.g. uses `rand`).
    pub period_cycles: Option<usize>,
    /// Indices of cycles that emitted nothing.
    pub silent_cycles: Vec<usize>,
    /// Maximum simultaneous onsets at any single instant (stack/chord depth).
    pub max_voices: usize,
    /// Distinct sound / sample names that fire, sorted.
    pub sounds: Vec<String>,
    /// Lowest pitched note across the window, if any.
    pub note_low: Option<NoteRef>,
    /// Highest pitched note across the window, if any.
    pub note_high: Option<NoteRef>,
    /// Whether any event sets a non-centre pan (uses the stereo field).
    pub uses_pan: bool,
    /// Per-cycle event breakdown.
    pub cycles: Vec<CycleDigest>,
}

/// A note reference carrying both its name and MIDI number.
#[derive(Debug, Clone, Serialize)]
pub struct NoteRef {
    pub name: String,
    pub midi: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CycleDigest {
    pub cycle: usize,
    pub events: Vec<EventDigest>,
}

/// One onset event, flattened from a hap.
#[derive(Debug, Clone, Serialize)]
pub struct EventDigest {
    /// Onset within the cycle, 0.0..1.0.
    pub begin: f64,
    /// Duration in cycles (whole span length).
    pub duration: f64,
    /// Raw hap value, stringified.
    pub value: String,
    /// Resolved sound / instrument name, if this is an audible voice.
    pub sound: Option<String>,
    /// Note name, if this event is pitched.
    pub note: Option<String>,
    /// MIDI number for `note`, if resolvable.
    pub midi: Option<i32>,
    pub gain: Option<f64>,
    pub pan: Option<f64>,
    /// Any other controls set on the event (key → stringified value), sorted.
    pub controls: Vec<(String, String)>,
}

/// Inspect a pattern: evaluate it and query `cycles` cycles, returning a
/// structured digest. `cycles` is clamped to 1..=64.
pub fn inspect_code(code: &str, cycles: usize) -> Result<PatternDigest, String> {
    let cycles = cycles.clamp(1, 64);
    let out = execute(code)?;
    let pattern = out.pattern;
    let bpm = out.tempo.map(|t| t.to_bpm());
    let seconds_per_cycle = out.tempo.map(|t| 1.0 / t.cps);

    let mut cycle_digests: Vec<CycleDigest> = Vec::with_capacity(cycles);
    let mut total_events = 0usize;
    let mut silent_cycles = Vec::new();
    // Latest absolute time (in cycles) any event so far is still sounding
    // until — a cycle with no onsets is NOT silent while a held note (e.g. a
    // drone under `.slow(4)`) sustains through it.
    let mut sounding_until = 0.0f64;
    let mut max_voices = 0usize;
    let mut sounds: Vec<String> = Vec::new();
    let mut note_low: Option<NoteRef> = None;
    let mut note_high: Option<NoteRef> = None;
    let mut uses_pan = false;

    for c in 0..cycles {
        let haps = pattern.query_arc(c as i32, c as i32 + 1);
        let mut events: Vec<EventDigest> = Vec::new();

        for hap in &haps {
            // Only count events whose onset falls in this cycle — clipped
            // fragments of events that began earlier have no onset here.
            if !hap.has_onset() {
                continue;
            }
            let whole = hap.whole_or_part();
            let begin = (whole.begin.to_f64() - c as f64).clamp(0.0, 1.0);
            let duration = (whole.end.to_f64() - whole.begin.to_f64()).max(0.0);
            sounding_until = sounding_until.max(whole.end.to_f64());

            let ev = event_from_hap(hap, begin, duration);

            if let Some(s) = &ev.sound {
                if !sounds.iter().any(|x| x == s) {
                    sounds.push(s.clone());
                }
            }
            if let (Some(name), Some(midi)) = (&ev.note, ev.midi) {
                if note_low.as_ref().map_or(true, |n| midi < n.midi) {
                    note_low = Some(NoteRef { name: name.clone(), midi });
                }
                if note_high.as_ref().map_or(true, |n| midi > n.midi) {
                    note_high = Some(NoteRef { name: name.clone(), midi });
                }
            }
            if ev.pan.is_some_and(|p| (p - 0.5).abs() > 1e-6) {
                uses_pan = true;
            }
            events.push(ev);
        }

        events.sort_by(|a, b| a.begin.partial_cmp(&b.begin).unwrap_or(std::cmp::Ordering::Equal));
        total_events += events.len();
        if events.is_empty() && sounding_until <= c as f64 + 1e-9 {
            silent_cycles.push(c);
        }
        max_voices = max_voices.max(simultaneity(&events));

        cycle_digests.push(CycleDigest { cycle: c, events });
    }

    sounds.sort();
    let period_cycles = detect_period(&cycle_digests);

    Ok(PatternDigest {
        cycles_queried: cycles,
        bpm,
        seconds_per_cycle,
        total_events,
        period_cycles,
        silent_cycles,
        max_voices,
        sounds,
        note_low,
        note_high,
        uses_pan,
        cycles: cycle_digests,
    })
}

/// Build an `EventDigest` from a hap's value plus its control context.
pub(crate) fn event_from_hap(hap: &Hap<Value>, begin: f64, duration: f64) -> EventDigest {
    let value = &hap.value;
    let context = &hap.context;
    let value_str = value_to_string(value);

    // Chord-typed values (e.g. "Gm7" before `.voicing()`) are symbols, not
    // single pitches — don't let the note heuristic misread "C7" as note C7.
    let is_chord = matches!(
        context.get(&ContextKey::Type),
        Some(Value::TypeTag(ValueTypeTag::Chord))
    );

    // A pitched note may live in the Note/N control or, for a bare `note(...)`,
    // in the value itself. Resolve to a MIDI number if possible.
    let note_candidate = context
        .get(&ContextKey::Note)
        .cloned()
        .or_else(|| (!is_chord).then(|| value.clone()));
    let (note, midi) = note_candidate
        .as_ref()
        .map_or((None, None), resolve_note);

    // The sound is the Sound control if present, otherwise the value when it is
    // a sample/synth name (i.e. it didn't parse as a note).
    let sound = context
        .get(&ContextKey::Sound)
        .map(value_to_string)
        .or_else(|| match value {
            Value::String(_) if note.is_none() => Some(value_str.clone()),
            _ => None,
        });

    let gain = context.get(&ContextKey::Gain).and_then(value_to_f64);
    let pan = context.get(&ContextKey::Pan).and_then(value_to_f64);

    // Surface every other control that's set, so nothing is silently hidden.
    let mut controls: Vec<(String, String)> = context
        .iter()
        .filter(|(k, _)| {
            !matches!(
                k,
                ContextKey::Note
                    | ContextKey::Sound
                    | ContextKey::Gain
                    | ContextKey::Pan
                    | ContextKey::Locations
                    | ContextKey::Type
            )
        })
        .map(|(k, v)| (k.to_string(), value_to_string(v)))
        .collect();
    controls.sort();

    EventDigest {
        begin,
        duration,
        value: value_str,
        sound,
        note,
        midi,
        gain,
        pan,
        controls,
    }
}

/// Maximum number of events sharing the same onset instant (stack/chord depth).
fn simultaneity(events: &[EventDigest]) -> usize {
    let mut max = 0usize;
    let mut i = 0;
    while i < events.len() {
        let mut j = i + 1;
        while j < events.len() && (events[j].begin - events[i].begin).abs() < 1e-6 {
            j += 1;
        }
        max = max.max(j - i);
        i = j;
    }
    max
}

/// Find the smallest period `p` such that every cycle equals the cycle `p`
/// later, across the whole window. Returns None if no repeat is observed.
fn detect_period(cycles: &[CycleDigest]) -> Option<usize> {
    let sigs: Vec<String> = cycles.iter().map(cycle_signature).collect();
    smallest_period(&sigs)
}

/// Smallest `p` (1..=n/2) for which the signature sequence is `p`-periodic
/// across the whole window. None if it never repeats within the window.
pub(crate) fn smallest_period(sigs: &[String]) -> Option<usize> {
    let n = sigs.len();
    if n < 2 {
        return None;
    }
    'periods: for p in 1..=(n / 2) {
        for c in 0..(n - p) {
            if sigs[c] != sigs[c + p] {
                continue 'periods;
            }
        }
        return Some(p);
    }
    None
}

/// A stable string fingerprint of a cycle's onsets, for period comparison.
fn cycle_signature(cd: &CycleDigest) -> String {
    let mut parts: Vec<String> = cd
        .events
        .iter()
        .map(|e| {
            format!(
                "{:.4}:{}:{}:{}",
                e.begin,
                e.sound.as_deref().unwrap_or(""),
                e.midi.map_or_else(String::new, |m| m.to_string()),
                e.value,
            )
        })
        .collect();
    parts.sort();
    parts.join("|")
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Number(n) => {
            if (n.fract()).abs() < 1e-9 {
                format!("{}", *n as i64)
            } else {
                format!("{n:.3}")
            }
        }
        Value::String(s) => s.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Rest => "~".to_string(),
        other => format!("{other:?}"),
    }
}

pub(crate) fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => Some(*n),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Resolve a value to (note name, MIDI) if it is a pitch. Accepts numeric MIDI
/// and note names like `c`, `c#4`, `eb3`, `db5`.
pub(crate) fn resolve_note(v: &Value) -> (Option<String>, Option<i32>) {
    match v {
        Value::Number(n) => {
            let midi = n.round() as i32;
            if (0..=127).contains(&midi) {
                (Some(midi_to_name(midi)), Some(midi))
            } else {
                (None, None)
            }
        }
        Value::String(s) => note_name_to_midi(s).map_or((None, None), |m| (Some(s.to_string()), Some(m))),
        _ => (None, None),
    }
}

/// Parse a strudel note name (`c`, `c#`, `db4`, `e3`, default octave 4) to MIDI.
/// Returns None for anything that isn't a pitch (e.g. `bd`, `hh`).
pub(crate) fn note_name_to_midi(s: &str) -> Option<i32> {
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
    while i < bytes.len() {
        match bytes[i] {
            b'#' | b's' => semitone += 1,
            b'b' => semitone -= 1,
            _ => break,
        }
        i += 1;
    }
    // Remainder, if any, must be the octave (possibly negative).
    let octave = if i < bytes.len() {
        s[i..].parse::<i32>().ok()?
    } else {
        4
    };
    let midi = (octave + 1) * 12 + semitone;
    (0..=127).contains(&midi).then_some(midi)
}

pub(crate) fn midi_to_name(midi: i32) -> String {
    const NAMES: [&str; 12] = [
        "c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b",
    ];
    let octave = midi / 12 - 1;
    let name = NAMES[(midi.rem_euclid(12)) as usize];
    format!("{name}{octave}")
}

/// Render a digest as a compact human/agent-readable report.
pub fn digest_to_text(d: &PatternDigest) -> String {
    use std::fmt::Write;
    let mut s = String::new();

    let _ = writeln!(
        s,
        "Inspected {} cycle(s): {} onset event(s), up to {} simultaneous voice(s).",
        d.cycles_queried, d.total_events, d.max_voices
    );
    if let Some(bpm) = d.bpm {
        let _ = write!(s, "Tempo: {bpm:.0} BPM");
        if let Some(spc) = d.seconds_per_cycle {
            let _ = write!(s, " ({spc:.3}s/cycle)");
        }
        let _ = writeln!(s);
    }
    match d.period_cycles {
        Some(p) => {
            let _ = writeln!(s, "Loop length: repeats every {p} cycle(s).");
        }
        None => {
            let _ = writeln!(
                s,
                "Loop length: no repeat within {} cycles (long period or aperiodic).",
                d.cycles_queried
            );
        }
    }
    if !d.sounds.is_empty() {
        let _ = writeln!(s, "Sounds: {}", d.sounds.join(", "));
    }
    if let (Some(lo), Some(hi)) = (&d.note_low, &d.note_high) {
        let _ = writeln!(
            s,
            "Pitch range: {} ({}) … {} ({}), span {} semitones.",
            lo.name,
            lo.midi,
            hi.name,
            hi.midi,
            hi.midi - lo.midi
        );
    }
    let _ = writeln!(s, "Stereo field: {}.", if d.uses_pan { "uses panning" } else { "centred (mono image)" });
    if !d.silent_cycles.is_empty() {
        let _ = writeln!(
            s,
            "⚠ Silent cycle(s): {}",
            d.silent_cycles
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let _ = writeln!(s, "\nPer-cycle events (begin · voice · note · controls):");
    // Show at most the first `period` cycles when periodic, else all queried.
    let show = d.period_cycles.unwrap_or(d.cycles_queried).min(d.cycles.len());
    for cd in &d.cycles[..show] {
        if cd.events.is_empty() {
            let _ = writeln!(s, "  cycle {}: (silent)", cd.cycle);
            continue;
        }
        let _ = writeln!(s, "  cycle {}:", cd.cycle);
        for e in &cd.events {
            let voice = e.sound.as_deref().unwrap_or("·");
            let pitch = match (&e.note, e.midi) {
                (Some(n), Some(m)) => format!("{n}({m})"),
                // Surface a non-pitch value (e.g. a chord symbol "Gm7") that
                // isn't already shown as the voice/sound name.
                _ if e.value != "~" && Some(e.value.as_str()) != e.sound.as_deref() => {
                    e.value.clone()
                }
                _ => "·".to_string(),
            };
            let mut extras: Vec<String> = Vec::new();
            if let Some(g) = e.gain {
                extras.push(format!("gain {g:.2}"));
            }
            if let Some(p) = e.pan {
                extras.push(format!("pan {p:.2}"));
            }
            for (k, v) in &e.controls {
                extras.push(format!("{k} {v}"));
            }
            let extras = if extras.is_empty() {
                String::new()
            } else {
                format!("  [{}]", extras.join(", "))
            };
            let _ = writeln!(
                s,
                "    {:.3}  {:<10} {:<8}{}",
                e.begin, voice, pitch, extras
            );
        }
    }
    if show < d.cycles_queried {
        let _ = writeln!(s, "  … ({} more cycle(s) repeat the loop)", d.cycles_queried - show);
    }

    s
}

/// A structural / arrangement view of a pattern: how the instrumentation
/// changes over time, segmented into sections, with the song form and
/// wall-clock lengths. Built on the same hap query as the digest.
/// A one-paragraph natural-language summary of a [`PatternDigest`].
pub fn digest_to_summary(d: &PatternDigest) -> String {
    use std::fmt::Write;
    let mut s = String::new();
    let _ = write!(s, "Digest ({} cycles): {} events", d.cycles_queried, d.total_events);
    if let Some(bpm) = d.bpm {
        let _ = write!(s, " at {bpm:.0} BPM");
        if let Some(spc) = d.seconds_per_cycle {
            let _ = write!(s, " ({spc:.2}s/cycle)");
        }
    }
    let _ = writeln!(s, ".");
    let _ = writeln!(
        s,
        "Loop: {}. Max {} simultaneous voices. Pan: {}.",
        d.period_cycles
            .map(|p| format!("{p} cycle(s)"))
            .unwrap_or_else(|| "no repeat within the window".into()),
        d.max_voices,
        if d.uses_pan { "stereo" } else { "all centre" }
    );
    let _ = writeln!(s, "Sounds: {}.", d.sounds.join(", "));
    if let (Some(lo), Some(hi)) = (&d.note_low, &d.note_high) {
        let _ = writeln!(s, "Pitch range: {} – {}.", lo.name, hi.name);
    }
    if !d.silent_cycles.is_empty() {
        let _ = writeln!(
            s,
            "Silent cycle(s): {}.",
            d.silent_cycles.iter().map(usize::to_string).collect::<Vec<_>>().join(", ")
        );
    }
    // Per-cycle event counts, run-length compressed: "c0–c7: 4 ev".
    let _ = writeln!(s, "Events per cycle:");
    let mut i = 0usize;
    while i < d.cycles.len() {
        let n = d.cycles[i].events.len();
        let mut j = i + 1;
        while j < d.cycles.len() && d.cycles[j].events.len() == n {
            j += 1;
        }
        if j - i == 1 {
            let _ = writeln!(s, "  c{i}: {n}");
        } else {
            let _ = writeln!(s, "  c{i}–c{}: {n}", j - 1);
        }
        i = j;
    }
    s
}
