//! One evaluation, shared by every analysis. `Evaluated::new` parses+executes
//! the source once and sweeps the query window once; `critique`, `analyze`,
//! `critique_form`, and the spectral pass all read the same haps instead of
//! re-executing the pattern per analysis (the review pipeline used to pay up
//! to seven parse+execute passes and six query sweeps per call).

use strudel_core::{Hap, Value};

use crate::execute::execute;
use crate::inspect::{
    CycleDigest, EventDigest, NoteRef, PatternDigest, event_from_hap, smallest_period,
};

/// A pattern evaluated once over a fixed cycle window: the raw per-cycle haps
/// (unfiltered — sustained and continuous events included) plus the folded
/// [`PatternDigest`].
pub struct Evaluated {
    code: String,
    bpm: Option<f64>,
    seconds_per_cycle: Option<f64>,
    /// `haps[c]` = raw `query_arc(c, c+1)` output.
    haps: Vec<Vec<Hap<Value>>>,
    digest: PatternDigest,
}

impl Evaluated {
    /// Parse + execute once, query `cycles` cycles once (clamped 1..=64), and
    /// fold the digest.
    pub fn new(code: &str, cycles: usize) -> Result<Self, String> {
        let cycles = cycles.clamp(1, 64);
        let out = execute(code)?;
        let bpm = out.tempo.map(|t| t.to_bpm());
        let seconds_per_cycle = out.tempo.map(|t| 1.0 / t.cps);
        let haps: Vec<Vec<Hap<Value>>> = (0..cycles)
            .map(|c| out.pattern.query_arc(c as i32, c as i32 + 1))
            .collect();
        let digest = fold_digest(&haps, bpm, seconds_per_cycle);
        Ok(Self {
            code: code.to_string(),
            bpm,
            seconds_per_cycle,
            haps,
            digest,
        })
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    /// The number of cycles queried.
    pub fn window(&self) -> usize {
        self.haps.len()
    }

    pub fn bpm(&self) -> Option<f64> {
        self.bpm
    }

    pub fn seconds_per_cycle(&self) -> Option<f64> {
        self.seconds_per_cycle
    }

    pub fn digest(&self) -> &PatternDigest {
        &self.digest
    }

    /// Whether ANY hap (onset, sustained, or continuous) landed in the window.
    /// The emptiness gate corpus-check runs — weaker than "has onsets", so a
    /// pattern of pure continuous signals still counts as emitting.
    pub fn has_any_haps(&self) -> bool {
        self.haps.iter().any(|h| !h.is_empty())
    }

    /// Take the digest without cloning — for inspect-only callers.
    pub fn into_digest(self) -> PatternDigest {
        self.digest
    }

    pub(crate) fn cycle_haps(&self) -> &[Vec<Hap<Value>>] {
        &self.haps
    }
}

/// The emptiness gate shared by corpus tooling and the generators: the code
/// must evaluate AND emit at least one hap within `window` cycles. A pattern
/// that parses but stays silent across the window is a curation/generation
/// bug.
pub fn validate_emits(code: &str, window: usize) -> Result<(), String> {
    let ev = Evaluated::new(code, window)?;
    if ev.has_any_haps() {
        Ok(())
    } else {
        Err(format!(
            "pattern emits no events in {window} cycles — silent pattern"
        ))
    }
}

/// Fold raw per-cycle haps into the serializable digest (onset events only).
fn fold_digest(
    haps: &[Vec<Hap<Value>>],
    bpm: Option<f64>,
    seconds_per_cycle: Option<f64>,
) -> PatternDigest {
    let cycles = haps.len();
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

    for (c, cycle_haps) in haps.iter().enumerate() {
        let mut events: Vec<EventDigest> = Vec::new();

        for hap in cycle_haps {
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
                    note_low = Some(NoteRef {
                        name: name.clone(),
                        midi,
                    });
                }
                if note_high.as_ref().map_or(true, |n| midi > n.midi) {
                    note_high = Some(NoteRef {
                        name: name.clone(),
                        midi,
                    });
                }
            }
            if ev.pan.is_some_and(|p| (p - 0.5).abs() > 1e-6) {
                uses_pan = true;
            }
            events.push(ev);
        }

        events.sort_by(|a, b| {
            a.begin
                .partial_cmp(&b.begin)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        total_events += events.len();
        if events.is_empty() && sounding_until <= c as f64 + 1e-9 {
            silent_cycles.push(c);
        }
        max_voices = max_voices.max(simultaneity(&events));

        cycle_digests.push(CycleDigest { cycle: c, events });
    }

    sounds.sort();
    let period_cycles = detect_period(&cycle_digests);

    PatternDigest {
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
