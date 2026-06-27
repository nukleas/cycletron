use serde::Serialize;
use strudel_core::{ContextKey, Hap, Value, ValueTypeTag};

pub fn validate_code(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Ok(());
    }
    // `execute` internally walks the structural-file → standalone-DSL →
    // mini-notation fallback chain, replacing the hand-rolled cascade we
    // used to maintain here.
    strudel_dsl::execute(code).map(|_| ()).map_err(|e| e.to_string())
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
    let out = strudel_dsl::execute(code).map_err(|e| e.to_string())?;
    let pattern = out.pattern;
    let bpm = out.tempo.map(|t| t.to_bpm());
    let seconds_per_cycle = out.tempo.map(|t| 1.0 / t.cps);

    let mut cycle_digests: Vec<CycleDigest> = Vec::with_capacity(cycles);
    let mut total_events = 0usize;
    let mut silent_cycles = Vec::new();
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
        if events.is_empty() {
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
        .or_else(|| context.get(&ContextKey::N))
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
                    | ContextKey::N
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

/// Analyze a pattern's arrangement: scan up to `max_cycles` (clamped 1..=64),
/// detect the loop period, and segment it into sections by active instrument.
pub fn analyze_code(code: &str, max_cycles: usize) -> Result<ArrangementAnalysis, String> {
    let window = max_cycles.clamp(1, 64);
    let out = strudel_dsl::execute(code).map_err(|e| e.to_string())?;
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

    // Segment [0, analyze_len) into runs of identical instrument sets.
    let mut sections: Vec<Section> = Vec::new();
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

            // Gain sum at this instant (unset gain plays at full level).
            let gsum: f64 = group.iter().map(|e| e.gain.unwrap_or(1.0)).sum();
            if gsum > peak_gain {
                peak_gain = gsum;
                peak_at = Some((cd.cycle, group.len()));
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
        let (cyc, voices) = peak_at.unwrap_or((0, 0));
        findings.push(warn(
            "clipping",
            format!(
                "Loudest instant stacks {voices} voices at cycle {cyc} summing to gain ~{peak_gain:.1} \
                 (1.0 = full) — likely to clip/distort. Lower gains, or split to separate orbits.",
            ),
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let c = critique_code(r#"stack(s("bd").gain(1), s("sd").gain(1), s("hh").gain(1))"#, 8).unwrap();
        assert!(has_code(&c, "clipping"), "{:?}", c.findings);
        assert!(!c.ok);
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
}
