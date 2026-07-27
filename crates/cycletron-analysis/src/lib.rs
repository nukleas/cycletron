//! Pattern analysis for Cycletron: validation, event inspection, mix
//! critique, and arrangement/form analysis. Extracted from the Tauri app
//! (`src-tauri/src/strudel.rs`, which now re-exports this crate) so the same
//! review pipeline the in-app agent uses can run from CLI tools like
//! `tools/song-check`. Plain Rust: code strings in, serializable digests out.

pub mod execute;
pub mod sounds;

pub use execute::execute;

use serde::Serialize;
use strudel_core::{ContextKey, Hap, Value, ValueTypeTag};

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
fn event_from_hap(hap: &Hap<Value>, begin: f64, duration: f64) -> EventDigest {
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
fn smallest_period(sigs: &[String]) -> Option<usize> {
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

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => Some(*n),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Resolve a value to (note name, MIDI) if it is a pitch. Accepts numeric MIDI
/// and note names like `c`, `c#4`, `eb3`, `db5`.
fn resolve_note(v: &Value) -> (Option<String>, Option<i32>) {
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
fn note_name_to_midi(s: &str) -> Option<i32> {
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

fn midi_to_name(midi: i32) -> String {
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
#[derive(Debug, Clone, Serialize)]
pub struct ArrangementAnalysis {
    pub bpm: Option<f64>,
    pub seconds_per_cycle: Option<f64>,
    /// How many cycles were scanned.
    pub window_cycles: usize,
    /// Detected loop length in cycles, if it repeats within the window.
    pub period_cycles: Option<usize>,
    /// Whether a repeat was found (false → form longer than window or evolving).
    pub repeats: bool,
    /// Loop duration in seconds (period × seconds_per_cycle), if both known.
    pub total_seconds: Option<f64>,
    /// Compact form string, e.g. "A A B A" (one letter per section).
    pub form: String,
    /// The sections, in order.
    pub sections: Vec<Section>,
}

/// One arrangement section: a run of consecutive cycles sharing the same set
/// of active instruments.
#[derive(Debug, Clone, Serialize)]
pub struct Section {
    /// Form letter (A, B, …); repeated instrument-sets reuse the same letter.
    pub label: String,
    pub start_cycle: usize,
    /// Inclusive last cycle of the section.
    pub end_cycle: usize,
    pub cycles: usize,
    pub start_seconds: Option<f64>,
    pub end_seconds: Option<f64>,
    /// Instruments sounding in this section (sorted).
    pub instruments: Vec<String>,
    /// Average onset events per cycle (density), rounded to 0.1.
    pub avg_events_per_cycle: f64,
}

/// Render a digest WITHOUT the per-event log: the high-level facts (tempo,
/// events, period, voices, sounds, pitch range) plus per-cycle event counts
/// compressed into runs. The answer to "does the drop enter at cycle 16?"
/// without scrolling through every onset.
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

/// Analyze a pattern's arrangement: scan up to `max_cycles` (clamped 1..=64),
/// detect the loop period, and segment it into sections by active instrument.
pub fn analyze_code(code: &str, max_cycles: usize) -> Result<ArrangementAnalysis, String> {
    let window = max_cycles.clamp(1, 64);
    let out = execute(code)?;
    let pattern = out.pattern;
    let bpm = out.tempo.map(|t| t.to_bpm());
    let spc = out.tempo.map(|t| 1.0 / t.cps);

    // Per cycle: the set of active instruments (including notes sustained from
    // earlier cycles), the onset count, and a content signature for period
    // detection.
    let mut active: Vec<Vec<String>> = Vec::with_capacity(window);
    let mut onset_counts: Vec<usize> = Vec::with_capacity(window);
    let mut sigs: Vec<String> = Vec::with_capacity(window);

    for c in 0..window {
        let haps = pattern.query_arc(c as i32, c as i32 + 1);
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut onsets = 0usize;
        let mut sig_parts: Vec<String> = Vec::new();

        for hap in &haps {
            // Skip continuous signals (LFOs etc.) — only discrete voices count
            // toward instrumentation.
            if hap.whole.is_none() {
                continue;
            }
            let ev = event_from_hap(hap, 0.0, 0.0);
            let inst = ev
                .sound
                .clone()
                .or_else(|| ev.note.as_ref().map(|_| "note".to_string()));
            if let Some(i) = &inst {
                set.insert(i.clone());
            }
            if hap.has_onset() {
                onsets += 1;
                let begin = (hap.whole_or_part().begin.to_f64() - c as f64).clamp(0.0, 1.0);
                sig_parts.push(format!(
                    "{:.3}:{}:{}",
                    begin,
                    inst.unwrap_or_default(),
                    ev.midi.map_or_else(String::new, |m| m.to_string())
                ));
            }
        }
        sig_parts.sort();
        sigs.push(sig_parts.join("|"));
        onset_counts.push(onsets);
        active.push(set.into_iter().collect());
    }

    let period = smallest_period(&sigs);
    let analyze_len = period.unwrap_or(window);

    let mut sections: Vec<Section> = Vec::new();

    // pickRestart labels are the ground truth for sections: each selector
    // token spans `.slow(n)` cycles (no .slow → 1), consecutive repeats merge.
    // Density flicker inside a labelled section (an intentional 2-on/2-off
    // pad) can no longer shred one section into micro-fragments.
    let labeled = parse_pickrestart_labels(code)
        .map(|labels| (labels, parse_pickrestart_slow(code).unwrap_or(1) as usize));

    if let Some((labels, n)) = labeled {
        let mut start = 0usize;
        let mut i = 0usize;
        while i < labels.len() && start < window {
            let mut j = i + 1;
            while j < labels.len() && labels[j] == labels[i] {
                j += 1;
            }
            let cycles = (j - i) * n;
            let end = start + cycles - 1;
            let last = end.min(window - 1);
            let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for c in start..=last {
                set.extend(active[c].iter().cloned());
            }
            let span = last - start + 1;
            let avg = onset_counts[start..=last].iter().sum::<usize>() as f64 / span as f64;
            sections.push(Section {
                label: labels[i].clone(),
                start_cycle: start,
                end_cycle: end,
                cycles,
                start_seconds: spc.map(|s| s * start as f64),
                end_seconds: spc.map(|s| s * (end + 1) as f64),
                instruments: set.into_iter().collect(),
                avg_events_per_cycle: (avg * 10.0).round() / 10.0,
            });
            start += cycles;
            i = j;
        }
    } else {
        // Fallback: segment [0, analyze_len) into runs of identical
        // instrument sets, lettered A, B, C…
        let mut distinct: Vec<Vec<String>> = Vec::new();
        let mut i = 0;
        while i < analyze_len {
            let set = &active[i];
            let mut j = i + 1;
            while j < analyze_len && &active[j] == set {
                j += 1;
            }
            let label = match distinct.iter().position(|s| s == set) {
                Some(idx) => letter_for(idx),
                None => {
                    distinct.push(set.clone());
                    letter_for(distinct.len() - 1)
                }
            };
            let cycles = j - i;
            let avg = onset_counts[i..j].iter().sum::<usize>() as f64 / cycles as f64;
            sections.push(Section {
                label,
                start_cycle: i,
                end_cycle: j - 1,
                cycles,
                start_seconds: spc.map(|s| s * i as f64),
                end_seconds: spc.map(|s| s * j as f64),
                instruments: set.clone(),
                avg_events_per_cycle: (avg * 10.0).round() / 10.0,
            });
            i = j;
        }
    }

    let form = sections
        .iter()
        .map(|s| s.label.clone())
        .collect::<Vec<_>>()
        .join(" ");
    let total_seconds = period.and_then(|p| spc.map(|s| s * p as f64));

    Ok(ArrangementAnalysis {
        bpm,
        seconds_per_cycle: spc,
        window_cycles: window,
        period_cycles: period,
        repeats: period.is_some(),
        total_seconds,
        form,
        sections,
    })
}

/// Map a section index to a form letter: A..Z, then S26, S27, … as a fallback.
fn letter_for(idx: usize) -> String {
    if idx < 26 {
        ((b'A' + idx as u8) as char).to_string()
    } else {
        format!("S{idx}")
    }
}

/// Render an arrangement analysis as a compact human/agent-readable report.
pub fn analyze_to_text(a: &ArrangementAnalysis) -> String {
    use std::fmt::Write;
    let mut s = String::new();

    let len = match a.period_cycles {
        Some(p) => format!("{p}-cycle loop"),
        None => format!("no repeat within {} cycles (evolving or longer form)", a.window_cycles),
    };
    let _ = write!(s, "Arrangement: {len}");
    if let Some(secs) = a.total_seconds {
        let _ = write!(s, " ({})", fmt_dur(secs));
    }
    if let Some(bpm) = a.bpm {
        let _ = write!(s, " at {bpm:.0} BPM");
    }
    let _ = writeln!(s, ".");
    if !a.form.is_empty() {
        let _ = writeln!(s, "Form: {}", a.form);
    }

    let _ = writeln!(s, "\nSections (label · cycles · time · instruments · density):");
    for sec in &a.sections {
        let span = if sec.cycles == 1 {
            format!("cyc {}", sec.start_cycle)
        } else {
            format!("cyc {}–{}", sec.start_cycle, sec.end_cycle)
        };
        let time = match (sec.start_seconds, sec.end_seconds) {
            (Some(a), Some(b)) => format!("{}–{}", fmt_dur(a), fmt_dur(b)),
            _ => "—".to_string(),
        };
        let insts = if sec.instruments.is_empty() {
            "(silent)".to_string()
        } else {
            sec.instruments.join(" ")
        };
        let _ = writeln!(
            s,
            "  {}  {:<10} {:<13} {:<28} ~{} ev/cyc",
            sec.label, span, time, insts, sec.avg_events_per_cycle
        );
    }

    s
}

/// Format seconds as `m:ss` when ≥60s, else `N.Ns`.
fn fmt_dur(secs: f64) -> String {
    if secs >= 60.0 {
        let m = (secs / 60.0).floor() as u64;
        let r = secs - (m as f64) * 60.0;
        format!("{m}:{r:04.1}")
    } else {
        format!("{secs:.1}s")
    }
}

/// A musical lint result: heuristic findings about a pattern's balance, built
/// over the inspect digest. Not about correctness — `validate_pattern` covers
/// that — but about whether the pattern is likely to sound good.
#[derive(Debug, Clone, Serialize)]
pub struct Critique {
    /// True when nothing rose to a warning (info-only or empty).
    pub ok: bool,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    /// "warn" (likely a problem) or "note" (stylistic observation).
    pub severity: String,
    /// Machine-stable id, e.g. "clipping", "silent-cycles".
    pub code: String,
    pub message: String,
}

/// Critique a pattern: evaluate it, then run heuristic checks over the first
/// loop (or `cycles` if it doesn't repeat). `cycles` clamps to 1..=64.
pub fn critique_code(code: &str, cycles: usize) -> Result<Critique, String> {
    let d = inspect_code(code, cycles.max(4))?;
    let mut findings: Vec<Finding> = Vec::new();
    let warn = |c: &str, m: String| Finding {
        severity: "warn".to_string(),
        code: c.to_string(),
        message: m,
    };
    let note = |c: &str, m: String| Finding {
        severity: "note".to_string(),
        code: c.to_string(),
        message: m,
    };

    // Critique over the loop period when known, else the whole window.
    let span = d.period_cycles.unwrap_or(d.cycles_queried).min(d.cycles.len());

    // --- Fully silent ------------------------------------------------------
    if d.total_events == 0 {
        findings.push(warn(
            "silent",
            "Pattern emits no events — nothing will sound.".to_string(),
        ));
        return Ok(Critique { ok: false, findings });
    }

    // --- Silent cycles within the loop ------------------------------------
    let silent: Vec<usize> = d
        .silent_cycles
        .iter()
        .copied()
        .filter(|c| *c < span)
        .collect();
    if !silent.is_empty() {
        findings.push(warn(
            "silent-cycles",
            format!(
                "Cycle(s) {} are silent — intentional rest, or a gap in the loop?",
                silent.iter().map(usize::to_string).collect::<Vec<_>>().join(", ")
            ),
        ));
    }

    // --- Per-instant analysis: clipping risk + semitone clashes -----------
    let mut peak_gain = 0.0f64;
    let mut peak_at: Option<(usize, usize)> = None; // (cycle, voices)
    let mut clash_example: Option<(usize, String, String)> = None;
    let mut clash_count = 0usize;

    for cd in &d.cycles[..span] {
        let mut i = 0;
        while i < cd.events.len() {
            let mut j = i + 1;
            while j < cd.events.len() && (cd.events[j].begin - cd.events[i].begin).abs() < 1e-6 {
                j += 1;
            }
            let group = &cd.events[i..j];

            // Loudness estimate at this instant, two corrections over a raw
            // gain-sum: (1) chord tones from ONE source (same sound + gain,
            // e.g. `note("[a3,c4,e4,g4]")`) are uncorrelated voices — they
            // sum in power (~g·√n), not amplitude (g·n); (2) drum hits are
            // millisecond transients, not sustained energy — weight them 0.5×
            // so a kick+clap+hat backbeat doesn't read like three held saws.
            let mut sources: std::collections::HashMap<(String, u64), usize> =
                std::collections::HashMap::new();
            for e in group {
                let key = (
                    e.sound.clone().unwrap_or_default(),
                    e.gain.unwrap_or(1.0).to_bits(),
                );
                *sources.entry(key).or_insert(0) += 1;
            }
            let gsum: f64 = sources
                .iter()
                .map(|((sound, gbits), n)| {
                    let weight = if is_percussive(sound) { 0.5 } else { 1.0 };
                    f64::from_bits(*gbits) * (*n as f64).sqrt() * weight
                })
                .sum();
            if gsum > peak_gain {
                peak_gain = gsum;
                peak_at = Some((cd.cycle, sources.len()));
            }

            // Semitone clashes (minor 2nd) between simultaneous pitches.
            let midis: Vec<(i32, &str)> = group
                .iter()
                .filter_map(|e| e.midi.map(|m| (m, e.note.as_deref().unwrap_or(""))))
                .collect();
            for a in 0..midis.len() {
                for b in (a + 1)..midis.len() {
                    if (midis[a].0 - midis[b].0).abs() % 12 == 1 {
                        clash_count += 1;
                        if clash_example.is_none() {
                            clash_example =
                                Some((cd.cycle, midis[a].1.to_string(), midis[b].1.to_string()));
                        }
                    }
                }
            }
            i = j;
        }
    }

    if peak_gain > 2.0 {
        let (cyc, srcs) = peak_at.unwrap_or((0, 0));
        let msg = format!(
            "Loudest instant: {srcs} independent source(s) at cycle {cyc} summing to \
             ~{peak_gain:.1} (1.0 = full; chords count once at g·√notes, drum transients \
             weighted 0.5×). Lower gains or split to separate orbits.",
        );
        // Hard clipping territory is a warn (blocks the gate); a hot-but-
        // plausible mix is a note so pad stacks don't make the gate unpassable.
        findings.push(if peak_gain > 3.0 {
            warn("clipping", msg)
        } else {
            note("hot-mix", msg)
        });
    }

    if let Some((cyc, a, b)) = clash_example {
        findings.push(note(
            "semitone-clash",
            format!(
                "{clash_count} simultaneous minor-2nd clash(es) (e.g. {a} vs {b} at cycle {cyc}). \
                 Harsh unless intentional — check the voicing.",
            ),
        ));
    }

    // --- Mono image -------------------------------------------------------
    if !d.uses_pan && d.max_voices >= 3 {
        findings.push(note(
            "mono",
            format!(
                "All {} voices are centre-panned — the mix is mono. Consider .pan() or .jux(rev) for width.",
                d.max_voices
            ),
        ));
    }

    // --- No low-end anchor ------------------------------------------------
    let has_pitched = d.note_low.is_some();
    let low_pitch = d.note_low.as_ref().is_some_and(|n| n.midi < 48); // below C3
    let low_drum = d.sounds.iter().any(|s| {
        let s = s.to_lowercase();
        s.contains("bd") || s.contains("sub") || s.contains("bass") || s == "sbd" || s.contains("808")
    });
    if has_pitched && !low_pitch && !low_drum {
        findings.push(note(
            "no-low-end",
            "No low-frequency anchor: no kick/sub and the lowest pitch sits above C3. \
             Add a bass or kick for foundation."
                .to_string(),
        ));
    }

    // --- Static single-pitch melody ---------------------------------------
    if let (Some(lo), Some(hi)) = (&d.note_low, &d.note_high) {
        if lo.midi == hi.midi && d.total_events > 2 {
            findings.push(note(
                "static-pitch",
                format!("Every pitched note is {} — the line never moves melodically.", lo.name),
            ));
        }
    }

    let ok = !findings.iter().any(|f| f.severity == "warn");
    Ok(Critique { ok, findings })
}

/// Is this sound a drum/percussion voice (a short transient, not sustained
/// energy)? Matches the default drum names and drum-machine voices like
/// `RolandTR808_bd` (the voice is the suffix after the last `_`).
fn is_percussive(sound: &str) -> bool {
    const DRUMS: [&str; 12] = ["bd", "sd", "sn", "hh", "cp", "oh", "ht", "mt", "lt", "cr", "cb", "rs"];
    let voice = sound.rsplit('_').next().unwrap_or(sound);
    DRUMS.contains(&voice)
}

/// Does a string look like a chord symbol the author forgot to `.voicing()`
/// (e.g. `Cm7`, `FM7`, `G#dim`)? An unvoiced chord symbol reaches the sampler
/// as a sound name and plays nothing.
fn looks_like_chord_symbol(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else { return false };
    if !('A'..='G').contains(&first) {
        return false;
    }
    let rest: String = chars.collect();
    let tail = rest.trim_start_matches(['#', 'b']);
    tail.is_empty()
        || ["m", "M", "maj", "min", "dim", "aug", "sus"]
            .iter()
            .any(|q| tail.starts_with(q))
        || tail.chars().all(|c| c.is_ascii_digit())
}

/// Source-level lints for silent failures the digest can't see. Today: a
/// `chord(...)` with no matching `.voicing()` — the chord symbol never
/// expands to pitches, so the layer is silent even though the sound name on
/// the chain is legal (the digest-level check only catches the
/// symbol-used-AS-sound case).
pub fn lint_source(code: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    let chords = code.matches("chord(").count();
    let voicings = code.matches(".voicing(").count();
    if chords > voicings {
        findings.push(Finding {
            severity: "warn".to_string(),
            code: "unvoiced-chord".to_string(),
            message: format!(
                "{chords} chord(…) call(s) but only {voicings} .voicing() — an unvoiced chord \
                 symbol never expands to pitches, so that layer is SILENT. Write \
                 chord(\"<Cm7 FM7>\").voicing().s(…)."
            ),
        });
    }
    findings
}

/// Lint a digest for events that evaluate fine but will be SILENT (or broken)
/// at audio time — the failure class `validate` alone can't see: invented
/// sound names, unvoiced chord symbols, out-of-range pan (negative pan is NaN
/// in the panner), and gm_* streaming making cycle 0 empty. `known` is the
/// resolvable sound set (see `sounds::known_sound_set`); any `gm_*` name is
/// accepted since GM instruments stream on demand.
pub fn lint_digest(d: &PatternDigest, known: &std::collections::HashSet<String>) -> Vec<Finding> {
    let mut findings = Vec::new();
    let warn = |c: &str, m: String| Finding {
        severity: "warn".to_string(),
        code: c.to_string(),
        message: m,
    };
    let note = |c: &str, m: String| Finding {
        severity: "note".to_string(),
        code: c.to_string(),
        message: m,
    };

    // --- Unknown sound names → silent layers -------------------------------
    for s in &d.sounds {
        if known.contains(s) || s.starts_with("gm_") {
            continue;
        }
        if looks_like_chord_symbol(s) {
            findings.push(warn(
                "unvoiced-chord",
                format!(
                    "'{s}' reaches the sampler as a sound name — this layer is SILENT. \
                     It looks like a chord symbol: chord(\"…\") needs .voicing() before .s(…)."
                ),
            ));
            continue;
        }
        let prefix: String = s.chars().take(3).collect();
        let mut suggestions: Vec<&String> = known
            .iter()
            .filter(|k| k.starts_with(&prefix) || k.contains(s.as_str()) || s.contains(k.as_str()))
            .collect();
        suggestions.sort();
        suggestions.truncate(3);
        let hint = if suggestions.is_empty() {
            "Check list_sounds for what exists.".to_string()
        } else {
            format!(
                "Did you mean {}?",
                suggestions.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(" / ")
            )
        };
        findings.push(warn(
            "unknown-sound",
            format!("'{s}' is not a loaded sound — this layer is SILENT. {hint}"),
        ));
    }

    // --- Pan out of range → NaN / broken image ------------------------------
    let mut bad_pan: Option<f64> = None;
    for cd in &d.cycles {
        for e in &cd.events {
            if let Some(p) = e.pan {
                if !(0.0..=1.0).contains(&p) {
                    bad_pan = Some(p);
                }
            }
        }
    }
    if let Some(p) = bad_pan {
        let detail = if p < 0.0 {
            "negative pan is sqrt(-x) = NaN in the panner — the event is completely silent"
        } else {
            "pan is 0..1 (0=left, 0.5=centre, 1=right)"
        };
        findings.push(warn(
            "pan-range",
            format!("pan {p:.2} is outside 0..1 — {detail}. Use e.g. .pan(sine.range(0.2, 0.8))."),
        ));
    }

    // --- GM streaming: cycle 0 silence is expected, not a bug ---------------
    if d.silent_cycles.contains(&0) && d.sounds.iter().any(|s| s.starts_with("gm_")) {
        findings.push(note(
            "gm-first-cycle",
            "Cycle 0 is silent and the pattern uses gm_* instruments — soundfonts stream in \
             on first use, so an empty first cycle is expected. Judge from cycle 1 onward."
                .to_string(),
        ));
    }

    findings
}

/// Render a critique as a compact human/agent-readable report.
pub fn critique_to_text(c: &Critique) -> String {
    use std::fmt::Write;
    if c.findings.is_empty() {
        return "Critique: nothing flagged — the pattern looks balanced.".to_string();
    }
    let warns = c.findings.iter().filter(|f| f.severity == "warn").count();
    let notes = c.findings.len() - warns;
    let mut s = String::new();
    let _ = writeln!(s, "Critique: {warns} warning(s), {notes} note(s).");
    for f in &c.findings {
        let mark = if f.severity == "warn" { "⚠" } else { "•" };
        let _ = writeln!(s, "  {mark} [{}] {}", f.code, f.message);
    }
    s
}

// ---------------------------------------------------------------------------
// Form critique
// ---------------------------------------------------------------------------

/// Rough energy tier for a section name (`intro`, `drop`, `lift`, …). Used to
/// sanity-check that named sections have the density their name implies.
/// 1 = low (intro/break/outro), 3 = rising (lift/build), 5 = peak (drop/chorus),
/// 2 = mid/default (verse).
fn label_energy(name: &str) -> i32 {
    let n = name.to_lowercase();
    let has = |k: &str| n.contains(k);
    if has("drop") || has("chorus") || has("climax") || has("hook") || has("peak") {
        5
    } else if has("lift") || has("build") || has("riser") || has("pre") {
        3
    } else if has("intro") || has("break") || has("outro") || has("ambient") || has("bridge") {
        1
    } else {
        2
    }
}

/// Best-effort extraction of the ordered section labels from a `pickRestart`
/// selector like `"<intro verse drop break>"`. `label!N` (replicate: N slots,
/// section restarts each slot) and `label@N` (weight: one N-cycle continuous
/// slot) both expand to N copies — either way the label occupies N × slow(n)
/// cycles of the form. Other modifiers (`*`, `(`, `:`) are stripped. Returns
/// `None` unless it finds ≥2 name-like tokens (so numeric note selectors like
/// `<0 2 4>` don't get treated as form).
fn parse_pickrestart_labels(code: &str) -> Option<Vec<String>> {
    let pr = code.find(".pickRestart(")?;
    let before = &code[..pr];
    let open = before.rfind('<')?;
    let close_rel = before[open..].find('>')?;
    let inner = &before[open + 1..open + close_rel];
    let labels: Vec<String> = inner
        .split_whitespace()
        .flat_map(|t| {
            let base = t
                .split(|c| "@*!(:".contains(c))
                .next()
                .unwrap_or(t)
                .trim()
                .to_string();
            // `label!3` → 3 restarting slots; `label@3` → one 3-cycle slot;
            // bare `label!` → mini-notation default 2.
            let reps = match t.find(|c| c == '!' || c == '@') {
                Some(i) => t[i + 1..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<usize>()
                    .unwrap_or(if t.as_bytes()[i] == b'!' { 2 } else { 1 }),
                None => 1,
            };
            let keep = !base.is_empty() && base.chars().any(|c| c.is_ascii_alphabetic());
            std::iter::repeat_n(base, if keep { reps } else { 0 })
        })
        .collect();
    (labels.len() >= 2).then_some(labels)
}

/// The `.slow(n)` factor applied to the pickRestart selector, if present
/// between the selector's `<...>` and `.pickRestart(`. This is the per-token
/// section length in cycles.
fn parse_pickrestart_slow(code: &str) -> Option<u32> {
    let pr = code.find(".pickRestart(")?;
    let before = &code[..pr];
    let close = before.rfind('>')?;
    let tail = &before[close..];
    let s = tail.find(".slow(")?;
    let rest = &tail[s + ".slow(".len()..];
    let end = rest.find(')')?;
    let n = rest[..end].trim().parse::<f64>().ok()?;
    (n >= 1.0).then_some(n.round() as u32)
}

/// One section of the song form, from either pickRestart labels (ground
/// truth) or density segmentation (fallback).
struct FormSection {
    label: String,
    start_cycle: usize,
    end_cycle: usize,
    cycles: usize,
    /// Mean events/cycle over the part of the section inside the scanned
    /// window; `None` when the section lies entirely beyond it.
    density: Option<f64>,
}

/// Critique a pattern's FORM: whether it's arranged like a song rather than one
/// looping bar. When a `pickRestart` selector parses, its **labels are the
/// ground truth**: sections are `label run × .slow(n)` cycles (consecutive
/// repeats of a label merge into one section) and density segmentation is not
/// consulted — instrumentation flicker inside a section can no longer invent
/// phantom sections. A selector with no `.slow(n)` gets a first-class warn
/// (every section lasts one cycle) instead of a wall of off-grid spam.
/// Without pickRestart, falls back to density segmentation as before.
/// `cycles` clamps to 8..=64.
pub fn critique_form_code(code: &str, cycles: usize) -> Result<Critique, String> {
    let window = cycles.clamp(8, 64);
    let d = inspect_code(code, window)?;

    let mut findings: Vec<Finding> = Vec::new();
    let warn = |c: &str, m: String| Finding {
        severity: "warn".to_string(),
        code: c.to_string(),
        message: m,
    };
    let note = |c: &str, m: String| Finding {
        severity: "note".to_string(),
        code: c.to_string(),
        message: m,
    };

    let density_over = |start: usize, end: usize| -> Option<f64> {
        let last = end.min(d.cycles.len().saturating_sub(1));
        if start > last {
            return None;
        }
        let n = last - start + 1;
        let events: usize = d.cycles[start..=last].iter().map(|c| c.events.len()).sum();
        Some(events as f64 / n as f64)
    };

    let labels = parse_pickrestart_labels(code);
    let mut sections: Vec<FormSection> = Vec::new();
    let mut labels_known = false;

    if let Some(labels) = &labels {
        match parse_pickrestart_slow(code) {
            None => {
                // The #1 pickRestart footgun: without .slow(n) every selector
                // token lasts ONE cycle. Flag it once, clearly, and skip the
                // per-section checks (they'd all be noise until this is fixed).
                let secs = d
                    .seconds_per_cycle
                    .map(|s| format!(" (~{s:.1}s each at this tempo)"))
                    .unwrap_or_default();
                findings.push(warn(
                    "missing-slow",
                    format!(
                        "pickRestart selector has no .slow(n) — each of the {} section tokens \
                         lasts ONE cycle{secs}. Add .slow(bars) to the selector, e.g. \
                         \"<intro drop>\".slow(8) for 8-cycle sections.",
                        labels.len()
                    ),
                ));
                let ok = false;
                return Ok(Critique { ok, findings });
            }
            Some(n) => {
                labels_known = true;
                if n % 4 != 0 {
                    findings.push(warn(
                        "off-grid",
                        format!(
                            ".slow({n}) makes each section token {n} cycle(s) — not a whole \
                             number of 4-bar phrases. Use a multiple of 4 (e.g. .slow({})).",
                            ((n + 2) / 4).max(1) * 4
                        ),
                    ));
                }
                // Merge consecutive repeats: <a a b> = section a × 2n, b × n.
                let mut start = 0usize;
                let mut i = 0usize;
                while i < labels.len() {
                    let mut j = i + 1;
                    while j < labels.len() && labels[j] == labels[i] {
                        j += 1;
                    }
                    let cyc = (j - i) * n as usize;
                    sections.push(FormSection {
                        label: labels[i].clone(),
                        start_cycle: start,
                        end_cycle: start + cyc - 1,
                        cycles: cyc,
                        density: density_over(start, start + cyc - 1),
                    });
                    start += cyc;
                    i = j;
                }
                if start > window {
                    findings.push(note(
                        "window-short",
                        format!(
                            "The form spans {start} cycles but only {window} were scanned — \
                             density checks skip the tail. Re-run with cycles={start} to cover \
                             the whole song.",
                        ),
                    ));
                }
            }
        }
    }

    if !labels_known {
        // Fallback: density segmentation (no pickRestart to trust).
        let a = analyze_code(code, window)?;
        if a.sections.len() <= 1 && a.window_cycles >= 8 {
            let span = a.period_cycles.unwrap_or(a.window_cycles);
            findings.push(note(
                "no-form",
                format!(
                    "One continuous texture over {span} cycles — no sections. For a full song, \
                     plan a FORM and split it with a pickRestart selector."
                ),
            ));
        }
        if a.sections.len() >= 2 {
            for s in &a.sections {
                if s.cycles % 4 != 0 {
                    let nearest = ((s.cycles + 2) / 4).max(1) * 4;
                    findings.push(warn(
                        "off-grid",
                        format!(
                            "Section {} is {} cycle(s) — not a whole number of 4-bar phrases. \
                             Snap it to {} bars.",
                            s.label, s.cycles, nearest
                        ),
                    ));
                }
            }
        }
        sections = a
            .sections
            .iter()
            .map(|s| FormSection {
                label: s.label.clone(),
                start_cycle: s.start_cycle,
                end_cycle: s.end_cycle,
                cycles: s.cycles,
                density: Some(s.avg_events_per_cycle),
            })
            .collect();
    }

    // --- Energy contrast + front-loading (density-known sections) ---------
    let dens: Vec<(usize, f64)> = sections
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.density.map(|d| (i, d)))
        .collect();
    if dens.len() >= 3 {
        let maxd = dens.iter().map(|(_, d)| *d).fold(0.0_f64, f64::max);
        let mind = dens.iter().map(|(_, d)| *d).fold(f64::MAX, f64::min);
        if maxd > 0.0 && (maxd - mind) / maxd < 0.20 {
            findings.push(warn(
                "flat-energy",
                format!(
                    "All {} sections sit near {maxd:.1} events/cycle — no build or drop. \
                     Add/remove layers so the peak is clearly denser than the intro/break.",
                    dens.len()
                ),
            ));
        }
        let peak = dens
            .iter()
            .max_by(|x, y| x.1.partial_cmp(&y.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| *i)
            .unwrap_or(0);
        if peak == 0 {
            findings.push(note(
                "front-loaded",
                "The busiest section is the very first one — the arrangement thins out instead \
                 of building toward a peak (drop/climax)."
                    .to_string(),
            ));
        }
    }

    // --- Robotic melodic loop under a long section -------------------------
    // Flags any melodic phrase whose intrinsic period repeats ≥4× within a
    // section (1-bar loop over 4+ cycles, 4-bar phrase under a merged
    // 16-cycle drop, …). Two clean repeats is normal music; four is a robot.
    for s in &sections {
        if s.cycles < 4 || s.start_cycle >= d.cycles.len() {
            continue;
        }
        let last = s.end_cycle.min(d.cycles.len() - 1);
        let mut pitched_cycles = 0usize;
        let cycle_sigs: Vec<String> = (s.start_cycle..=last)
            .map(|c| {
                let mut notes: Vec<String> = d.cycles[c]
                    .events
                    .iter()
                    .filter_map(|e| e.midi.map(|m| format!("{:.2}:{m}", e.begin)))
                    .collect();
                if !notes.is_empty() {
                    pitched_cycles += 1;
                }
                notes.sort();
                notes.join(",")
            })
            .collect();
        if pitched_cycles < 4 {
            continue;
        }
        if let Some(p) = smallest_period(&cycle_sigs) {
            let scanned = cycle_sigs.len();
            if p * 4 <= scanned {
                findings.push(warn(
                    "robotic-loop",
                    format!(
                        "The melodic material under section {} is a {p}-cycle phrase looped \
                         {}× — it never develops. Write a longer line (e.g. more bars inside \
                         `<…>`) or vary it with every()/off()/rev.",
                        s.label,
                        scanned / p
                    ),
                ));
            }
        }
    }

    // --- Name-aware energy priors (labels are ground truth here) ----------
    if labels_known && sections.len() >= 2 {
        let sec_dens: Vec<Option<f64>> = sections.iter().map(|s| s.density).collect();
        let energies: Vec<i32> = sections.iter().map(|s| label_energy(&s.label)).collect();
        let drop_dens = energies
            .iter()
            .zip(&sec_dens)
            .filter_map(|(e, d)| (*e >= 5).then_some(*d).flatten())
            .fold(0.0_f64, f64::max);
        if drop_dens > 0.0 {
            for (s, e) in sections.iter().zip(&energies) {
                if let Some(dd) = s.density {
                    if *e <= 1 && dd >= drop_dens {
                        findings.push(warn(
                            "energy-inversion",
                            format!(
                                "'{}' ({dd:.1} ev/cyc) is as busy as the drop ({drop_dens:.1}) — \
                                 a low-energy section should be sparser. Thin it out.",
                                s.label
                            ),
                        ));
                    }
                }
            }
        }
        for i in 1..sections.len() {
            if let (Some(cur), Some(prev)) = (sections[i].density, sections[i - 1].density) {
                if energies[i] >= 5 && cur <= prev {
                    findings.push(note(
                        "no-drop-lift",
                        format!(
                            "'{}' isn't denser than '{}' before it — the drop doesn't land. Add \
                             a layer (hook/hats/octave lead) so energy steps up.",
                            sections[i].label,
                            sections[i - 1].label
                        ),
                    ));
                }
            }
        }
    }

    // --- Dedupe: one unique problem = one line -----------------------------
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    findings.retain(|f| seen.insert((f.code.clone(), f.message.clone())));

    let ok = !findings.iter().any(|f| f.severity == "warn");
    Ok(Critique { ok, findings })
}

/// Render a form critique as a compact human/agent-readable report.
pub fn form_critique_to_text(c: &Critique) -> String {
    use std::fmt::Write;
    if c.findings.is_empty() {
        return "Form critique: nothing flagged — sections, lengths, and energy look coherent."
            .to_string();
    }
    let warns = c.findings.iter().filter(|f| f.severity == "warn").count();
    let notes = c.findings.len() - warns;
    let mut s = String::new();
    let _ = writeln!(s, "Form critique: {warns} warning(s), {notes} note(s).");
    for f in &c.findings {
        let mark = if f.severity == "warn" { "⚠" } else { "•" };
        let _ = writeln!(s, "  {mark} [{}] {}", f.code, f.message);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> std::collections::HashSet<String> {
        ["bd", "hh", "sd", "sawtooth", "sine", "supersaw", "wt_pluck"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn lint_flags_unknown_sound_as_silent_layer() {
        let d = inspect_code("s(\"bd kicck bd kicck\")", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().any(|f| f.code == "unknown-sound" && f.severity == "warn"),
            "got: {f:?}"
        );
    }

    #[test]
    fn lint_hints_voicing_for_bare_chord_symbols() {
        // chord("Cm7") without .voicing() reaches the sampler as sound "Cm7".
        let d = inspect_code("s(\"Cm7 FM7\")", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(f.iter().any(|f| f.code == "unvoiced-chord"), "got: {f:?}");
    }

    #[test]
    fn lint_flags_negative_pan() {
        let d = inspect_code("s(\"bd*4\").pan(-0.3)", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().any(|f| f.code == "pan-range" && f.message.contains("NaN")),
            "got: {f:?}"
        );
    }

    #[test]
    fn lint_accepts_clean_patterns_and_gm_names() {
        let d = inspect_code("stack(s(\"bd*4\"), note(\"c3\").s(\"gm_epiano1\")).pan(0.4)", 2).unwrap();
        let f = lint_digest(&d, &known());
        assert!(
            f.iter().all(|f| f.severity != "warn"),
            "clean pattern warned: {f:?}"
        );
    }

    #[test]
    fn note_name_parsing() {
        assert_eq!(note_name_to_midi("c4"), Some(60));
        assert_eq!(note_name_to_midi("c"), Some(60)); // default octave 4
        assert_eq!(note_name_to_midi("c#4"), Some(61));
        assert_eq!(note_name_to_midi("db4"), Some(61));
        assert_eq!(note_name_to_midi("a4"), Some(69));
        assert_eq!(note_name_to_midi("eb3"), Some(51));
        // Drum/sample names are not pitches.
        assert_eq!(note_name_to_midi("bd"), None);
        assert_eq!(note_name_to_midi("hh"), None);
        assert_eq!(midi_to_name(60), "c4");
    }

    #[test]
    fn drum_pattern_sounds() {
        let d = inspect_code(r#"s("bd ~ sd ~")"#, 1).unwrap();
        assert_eq!(d.total_events, 2);
        assert_eq!(d.sounds, vec!["bd".to_string(), "sd".to_string()]);
        assert!(d.note_low.is_none(), "drums are not pitched");
        assert!(d.silent_cycles.is_empty());
    }

    #[test]
    fn melody_pitch_range() {
        let d = inspect_code(r#"note("c4 e4 g4 c5")"#, 1).unwrap();
        assert_eq!(d.total_events, 4);
        assert_eq!(d.note_low.as_ref().unwrap().midi, 60);
        assert_eq!(d.note_high.as_ref().unwrap().midi, 72);
    }

    #[test]
    fn synth_voice_keeps_note_and_sound_distinct() {
        let d = inspect_code(r#"note("c3").s("sawtooth")"#, 1).unwrap();
        let ev = &d.cycles[0].events[0];
        assert_eq!(ev.sound.as_deref(), Some("sawtooth"));
        assert_eq!(ev.midi, Some(48));
    }

    #[test]
    fn slowcat_period_detection() {
        // Alternates each cycle → period of 2.
        let d = inspect_code(r#"s("<bd sd>")"#, 8).unwrap();
        assert_eq!(d.period_cycles, Some(2));
    }

    #[test]
    fn stable_pattern_has_period_one() {
        let d = inspect_code(r#"s("bd*4")"#, 4).unwrap();
        assert_eq!(d.period_cycles, Some(1));
        assert_eq!(d.max_voices, 1);
    }

    #[test]
    fn tempo_surfaces_seconds_per_cycle() {
        let d = inspect_code("setbpm(120);\ns(\"bd*4\")", 1).unwrap();
        assert_eq!(d.bpm, Some(120.0));
        // 120 bpm, 4 beats/cycle → 0.5 cps → 2s/cycle.
        assert!((d.seconds_per_cycle.unwrap() - 2.0).abs() < 1e-6);
    }

    #[test]
    fn chord_symbol_not_misread_as_note() {
        // "C7" is a chord symbol here, not the note C octave 7.
        let d = inspect_code(r#"chord("<Gm7 C7 FM7>").s("triangle")"#, 3).unwrap();
        assert!(
            d.note_low.is_none(),
            "unvoiced chord symbols should not register as pitches, got {:?}",
            d.note_low
        );
        // The chord symbol is still surfaced as the event value.
        assert!(d.cycles[0].events.iter().any(|e| e.value == "Gm7"));
    }

    #[test]
    fn arrangement_constant_instrumentation_is_one_section() {
        let a = analyze_code(r#"stack(s("bd*4"), s("hh*8"))"#, 16).unwrap();
        assert_eq!(a.period_cycles, Some(1));
        assert_eq!(a.sections.len(), 1);
        assert_eq!(a.sections[0].instruments, vec!["bd".to_string(), "hh".to_string()]);
        assert_eq!(a.form, "A");
    }

    #[test]
    fn arrangement_detects_entering_instrument() {
        // hh only present on alternating cycles → two sections, ABAB… form,
        // period 2.
        let a = analyze_code(r#"stack(s("bd*4"), s("<hh*4 ~>"))"#, 16).unwrap();
        assert_eq!(a.period_cycles, Some(2));
        assert_eq!(a.form, "A B");
        assert_eq!(a.sections.len(), 2);
        assert!(a.sections[0].instruments.contains(&"hh".to_string()));
        assert!(!a.sections[1].instruments.contains(&"hh".to_string()));
    }

    #[test]
    fn arrangement_total_length_from_tempo() {
        let a = analyze_code("setbpm(120);\ns(\"<bd sd>\")", 8).unwrap();
        assert_eq!(a.period_cycles, Some(2));
        // 120bpm → 0.5cps → 2s/cycle → 2 cycles = 4s.
        assert!((a.total_seconds.unwrap() - 4.0).abs() < 1e-6);
    }

    fn has_code(c: &Critique, code: &str) -> bool {
        c.findings.iter().any(|f| f.code == code)
    }

    #[test]
    fn critique_flags_clipping() {
        // Four independent SUSTAINED full-level sources: 4.0 after grouping →
        // warn. (Drum transients are weighted 0.5×, so they need synths.)
        let c = critique_code(
            r#"stack(note("c2").s("sawtooth").gain(1), note("e3").s("sine").gain(1), note("g3").s("supersaw").gain(1), note("c4").s("triangle").gain(1))"#,
            8,
        )
        .unwrap();
        assert!(has_code(&c, "clipping"), "{:?}", c.findings);
        assert!(!c.ok);
    }

    #[test]
    fn critique_groups_chord_tones_as_one_source() {
        // A 4-note pad at 0.22 + a kick at 0.4: raw sum would be 1.28 → with
        // the OLD per-voice counting a bigger pad would false-positive. After
        // g·√n grouping this is ~0.84 — must be clean (the tool-test report's
        // exact complaint).
        let c = critique_code(
            r#"stack(s("bd*4").gain(0.4), note("[a3,c4,e4,g4]").s("supersaw").gain(0.22))"#,
            8,
        )
        .unwrap();
        assert!(
            !has_code(&c, "clipping") && !has_code(&c, "hot-mix"),
            "chord pad false-positived: {:?}",
            c.findings
        );
    }

    #[test]
    fn critique_hot_but_plausible_mix_is_a_note_not_warn() {
        // ~2.4 sustained after grouping: surfaced as hot-mix note, gate passes.
        let c = critique_code(
            r#"stack(note("c2").s("sawtooth").gain(0.8), note("e3").s("sine").gain(0.8), note("g3").s("supersaw").gain(0.8))"#,
            8,
        )
        .unwrap();
        assert!(has_code(&c, "hot-mix"), "{:?}", c.findings);
        assert!(!has_code(&c, "clipping"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_silent_cycle() {
        let c = critique_code(r#"s("<bd*4 ~>")"#, 8).unwrap();
        assert!(has_code(&c, "silent-cycles"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_static_pitch() {
        let c = critique_code(r#"note("c4 c4 c4 c4").s("triangle")"#, 4).unwrap();
        assert!(has_code(&c, "static-pitch"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_no_low_end() {
        let c = critique_code(r#"note("c5 e5 g5 b5").s("triangle")"#, 4).unwrap();
        assert!(has_code(&c, "no-low-end"), "{:?}", c.findings);
    }

    #[test]
    fn critique_flags_semitone_clash() {
        let c = critique_code(r#"stack(note("c4").s("sine"), note("c#4").s("sine"))"#, 4).unwrap();
        assert!(has_code(&c, "semitone-clash"), "{:?}", c.findings);
    }

    #[test]
    fn critique_clean_pattern_has_no_warnings() {
        let c = critique_code(
            r#"stack(s("bd*4"), note("c2 e2 g2 a2").s("sawtooth").pan("0.2 0.8"))"#,
            8,
        )
        .unwrap();
        assert!(c.ok, "expected no warnings, got {:?}", c.findings);
    }

    #[test]
    fn invalid_code_errors() {
        assert!(inspect_code("s(\"bd\".gain(", 1).is_err());
    }

    #[test]
    fn lint_source_catches_the_unvoiced_chord_trap() {
        // Trap (b) from the tool-test report — sailed through as "safe".
        let f = lint_source(r#"chord("<Cm7 FM7>").s("supersaw").gain(0.6)"#);
        assert!(
            f.iter().any(|f| f.code == "unvoiced-chord" && f.severity == "warn"),
            "got: {f:?}"
        );
        // Voiced chord: clean.
        assert!(lint_source(r#"chord("<Cm7 FM7>").voicing().s("supersaw")"#).is_empty());
    }

    /// The tool-test song shape: 8 labeled tokens × .slow(8). Labels are
    /// ground truth — density flicker inside a section must NOT produce
    /// off-grid warns (the report's bug 2: 18 spurious lines).
    #[test]
    fn form_critique_trusts_pickrestart_labels() {
        let code = r#"setbpm(130);
$: "<intro build drop drop break drop2 drop2 outro>".slow(8).pickRestart({
    intro: s("hh ~ ~ ~"),
    build: s("bd ~ hh ~, ~ ~ ~ hh"),
    drop: s("bd*4, hh*8, ~ cp ~ cp"),
    break: s("<[hh ~ ~ ~] [~ ~ hh ~]>"),
    drop2: s("bd*4, hh*8, cp*2, oh ~ oh ~"),
    outro: s("hh ~ ~ ~")
})"#;
        let c = critique_form_code(code, 64).unwrap();
        assert!(!has_code(&c, "off-grid"), "phantom sections: {:?}", c.findings);
        assert!(!has_code(&c, "missing-slow"), "{:?}", c.findings);
        assert!(c.ok, "expected clean form, got {:?}", c.findings);
    }

    #[test]
    fn form_critique_flags_missing_slow_once() {
        let code = r#"setbpm(130);
$: "<intro drop outro>".pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8"),
    outro: s("hh ~ ~ ~")
})"#;
        let c = critique_form_code(code, 16).unwrap();
        assert!(has_code(&c, "missing-slow"), "{:?}", c.findings);
        // ONE clear warn, not a wall of off-grid spam.
        assert_eq!(c.findings.len(), 1, "{:?}", c.findings);
    }

    #[test]
    fn form_critique_flags_off_grid_slow_factor() {
        let code = r#"setbpm(130);
$: "<intro drop>".slow(3).pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8")
})"#;
        let c = critique_form_code(code, 16).unwrap();
        assert!(has_code(&c, "off-grid"), "{:?}", c.findings);
    }

    /// Round-3 report H2: `.s(…)` applied BEFORE `.struct(…)` must survive into
    /// the digest (the engine used to drop hap context in with_structure, so
    /// every struct'd chord lost its sound — in the digest AND at playback).
    ///
    /// Ignored while the sibling strudel-rs build does not preserve hap context
    /// through `with_structure` — re-enable when that engine fix is present.
    #[test]
    #[ignore = "depends on strudel-rs with_structure hap-context preservation"]
    fn struct_keeps_pre_applied_sound_in_digest() {
        let d = inspect_code(r#"note("[a3,c4,e4]").s("supersaw").struct("~ 1 ~ 1").gain(0.5)"#, 1)
            .unwrap();
        assert!(
            d.sounds.iter().any(|s| s == "supersaw"),
            "struct dropped the sound: {:?}",
            d.sounds
        );
        assert!(
            d.cycles[0].events.iter().all(|e| e.sound.as_deref() == Some("supersaw")),
            "chord events lost sound: {:?}",
            d.cycles[0].events
        );
    }

    /// Generator↔critic contract: pieces from the genre map must not trip the
    /// clipping gate on their own review (the tool-test report caught amapiano
    /// "7 voices ~3.2" and gabber "6 voices ~2.6" under the old per-voice
    /// counting).
    #[test]
    fn generated_pieces_pass_their_own_clipping_gate() {
        for genre in ["amapiano", "gabber", "uplifting-trance", "house"] {
            let code = cycletron_gen::compose::by_name(genre, 7).unwrap().to_strudel();
            let c = critique_code(&code, 8).unwrap();
            assert!(
                !has_code(&c, "clipping"),
                "{genre} trips its own gate: {:?}",
                c.findings
            );
        }
    }

    /// Round-3 report H1: analyze_arrangement must use pickRestart labels as
    /// section ground truth — an intentional 2-on/2-off pad inside one 8-cycle
    /// outro must NOT shred it into 2-cycle micro-sections.
    #[test]
    fn arrangement_reads_pickrestart_labels() {
        let code = r#"setbpm(130);
$: "<intro drop drop outro>".slow(8).pickRestart({
    intro: s("hh ~ ~ ~"),
    drop: s("bd*4, hh*8"),
    outro: stack(s("bd ~ ~ ~"), note("<[a3,c4,e4] [f3,a3,c4] ~ ~>").s("wt_pad"))
})"#;
        let a = analyze_code(code, 32).unwrap();
        assert_eq!(a.form, "intro drop outro", "form: {}", a.form);
        let outro = a.sections.last().unwrap();
        assert_eq!((outro.start_cycle, outro.end_cycle), (24, 31));
        assert_eq!(outro.cycles, 8, "outro shredded: {:?}", a.sections);
        // drop drop merges into one 16-cycle section.
        assert_eq!(a.sections[1].cycles, 16);
    }

    /// Report bug 4 repro attempt: a sound introduced by a LATER pickRestart
    /// section must appear in the digest's sound list.
    #[test]
    fn digest_sees_sounds_from_later_sections() {
        let code = r#"$: "<a b>".slow(2).pickRestart({
    a: s("bd*4"),
    b: note("c3 e3").s("sawtooth")
})"#;
        let d = inspect_code(code, 8).unwrap();
        assert!(
            d.sounds.iter().any(|s| s == "bd") && d.sounds.iter().any(|s| s == "sawtooth"),
            "sounds: {:?}",
            d.sounds
        );
    }

    #[test]
    fn pickrestart_labels_parse() {
        assert_eq!(
            parse_pickrestart_labels(r#""<intro verse drop>".slow(4).pickRestart({})"#),
            Some(vec!["intro".into(), "verse".into(), "drop".into()])
        );
        // `@N` (weight: one continuous N-cycle slot) and `!N` (replicate: N
        // restarting slots) both mean the label spans N selector cycles —
        // expand so section lengths come out right (engine-verified via
        // dsl-eval: `b@2` plays 4 bars through, `b!2` restarts at bar 3).
        assert_eq!(
            parse_pickrestart_labels(r#""<intro@2 drop!3>".pickRestart({})"#),
            Some(vec![
                "intro".into(),
                "intro".into(),
                "drop".into(),
                "drop".into(),
                "drop".into()
            ])
        );
        // Numeric note selectors are not section labels.
        assert_eq!(parse_pickrestart_labels(r#""<0 2 4>".pickRestart({})"#), None);
        // Not a pickRestart at all.
        assert_eq!(parse_pickrestart_labels(r#"note("c e g")"#), None);
    }

    #[test]
    fn label_energy_tiers() {
        assert_eq!(label_energy("drop"), 5);
        assert_eq!(label_energy("final-chorus"), 5);
        assert_eq!(label_energy("lift"), 3);
        assert_eq!(label_energy("intro"), 1);
        assert_eq!(label_energy("break"), 1);
        assert_eq!(label_energy("verse"), 2); // default/mid
    }

    #[test]
    fn form_critique_flags_single_texture() {
        // One looping bar over the window → "no arrangement" note, no warnings.
        let c = critique_form_code(r#"s("bd sd")"#, 8).unwrap();
        assert!(c.ok, "single loop is a note, not a warning");
        assert!(
            c.findings.iter().any(|f| f.code == "no-form"),
            "expected a no-form note, got {:?}",
            c.findings
        );
    }
}
