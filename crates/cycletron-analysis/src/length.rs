//! Export-oriented pattern length detection.
//!
//! Arrangement analysis only looks for a short loop period inside a 64-cycle
//! window. Full MIDI dumps and long forms need a different answer: **how long
//! is one complete play-through** before the pattern loops or goes quiet.
//!
//! Priority:
//! 1. `pickRestart` selector total (authoritative section form)
//! 2. Onset-fingerprint loop period, scanned up to a large window
//! 3. Content end: last cycle with an onset, when trailing silence is seen

use serde::Serialize;

use crate::execute::execute;
use crate::form::{parse_pickrestart_labels, parse_pickrestart_slow};
use crate::inspect::{event_from_hap, smallest_period};

/// How the length was derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LengthKind {
    /// Sum of `pickRestart` selector weights × `.slow(n)`.
    PickRestart,
    /// Smallest onset-fingerprint period that tiles the scanned window.
    Loop,
    /// Last sounding cycle + 1, after trailing silence (through-composed end).
    ContentEnd,
}

/// Detected one-shot / loop length for offline export (WAV/MIDI).
#[derive(Debug, Clone, Serialize)]
pub struct PatternLength {
    /// Length in cycles (1 cycle ≈ 1 bar at the usual 4-beat mapping).
    pub cycles: usize,
    /// Wall-clock seconds when tempo is known from the code.
    pub seconds: Option<f64>,
    pub bpm: Option<f64>,
    pub kind: LengthKind,
    /// How many cycles were queried to reach this answer.
    pub window_scanned: usize,
}

/// Detect the natural export length of a pattern.
///
/// `max_cycles` is clamped to `1..=4096` (default path uses 1024). Returns
/// `None` when the pattern keeps sounding without a clean period inside the
/// window (e.g. fully aperiodic generative code).
pub fn detect_pattern_length(
    code: &str,
    max_cycles: usize,
) -> Result<Option<PatternLength>, String> {
    let max_cycles = max_cycles.clamp(1, 4096);
    let out = execute(code)?;
    let pattern = out.pattern;
    let bpm = out.tempo.map(|t| t.to_bpm());
    let spc = out.tempo.map(|t| 1.0 / t.cps);

    // --- 1. pickRestart form total ----------------------------------------
    if let Some(labels) = parse_pickrestart_labels(code) {
        let slow = parse_pickrestart_slow(code).unwrap_or(1) as usize;
        let cycles = labels.len().saturating_mul(slow).max(1);
        return Ok(Some(finish(cycles, bpm, spc, LengthKind::PickRestart, 0)));
    }

    // --- 2 & 3. Scan for loop period or content end -----------------------
    // Chunked scan: after each chunk, try period detection. Stop early when
    // we have at least two full periods, or when we see enough trailing silence
    // after some content (through-composed song end).
    const SILENT_TAIL: usize = 4;
    let mut sigs: Vec<String> = Vec::with_capacity(max_cycles.min(512));
    let mut last_onset: Option<usize> = None;
    let mut silent_run = 0usize;

    for c in 0..max_cycles {
        let haps = pattern.query_arc(c as i32, c as i32 + 1);
        let mut parts: Vec<String> = Vec::new();
        let mut has_onset = false;

        for hap in &haps {
            if hap.whole.is_none() {
                continue;
            }
            if !hap.has_onset() {
                continue;
            }
            has_onset = true;
            let ev = event_from_hap(hap, 0.0, 0.0);
            let inst = ev
                .sound
                .clone()
                .or_else(|| ev.note.as_ref().map(|_| "note".to_string()))
                .unwrap_or_default();
            let begin = (hap.whole_or_part().begin.to_f64() - c as f64).clamp(0.0, 1.0);
            parts.push(format!(
                "{:.3}:{}:{}",
                begin,
                inst,
                ev.midi.map_or_else(String::new, |m| m.to_string())
            ));
        }
        parts.sort();
        sigs.push(parts.join("|"));

        if has_onset {
            last_onset = Some(c);
            silent_run = 0;
        } else {
            silent_run += 1;
        }

        // Period check once we have enough history (every 8 cycles, and at end).
        let n = sigs.len();
        if n >= 2
            && (n.is_multiple_of(8) || n == max_cycles)
            && let Some(p) = smallest_period(&sigs)
        {
            // Require seeing the period at least twice so a long unique
            // prefix isn't mistaken for a period.
            if p * 2 <= n {
                return Ok(Some(finish(p, bpm, spc, LengthKind::Loop, n)));
            }
        }

        // Through-composed: content then sustained silence → song ended.
        if silent_run >= SILENT_TAIL
            && let Some(last) = last_onset
        {
            let cycles = last + 1;
            return Ok(Some(finish(cycles, bpm, spc, LengthKind::ContentEnd, n)));
        }
    }

    // Scanned the full window without two clear periods or a silent tail.
    // If we had content, treat the span through the last onset as a best-effort
    // one-shot length (common for long MIDI dumps whose period ≈ window).
    if let Some(last) = last_onset {
        // Only accept when the last onset is well before the window end, so we
        // aren't cutting off a still-sounding long form mid-phrase.
        if last + 1 + SILENT_TAIL <= max_cycles {
            return Ok(Some(finish(
                last + 1,
                bpm,
                spc,
                LengthKind::ContentEnd,
                sigs.len(),
            )));
        }
        // Entire window was active: if period equals half the window (exactly
        // two periods), smallest_period already returned. Otherwise unknown.
        if let Some(p) = smallest_period(&sigs)
            && p * 2 <= sigs.len()
        {
            return Ok(Some(finish(p, bpm, spc, LengthKind::Loop, sigs.len())));
        }
        // Last resort for dense MIDI slowcats: first return of cycle-0 signature
        // after the start is a strong period candidate when verified once.
        if let Some(p) = first_return_period(&sigs) {
            return Ok(Some(finish(p, bpm, spc, LengthKind::Loop, sigs.len())));
        }
    }

    Ok(None)
}

fn finish(
    cycles: usize,
    bpm: Option<f64>,
    spc: Option<f64>,
    kind: LengthKind,
    window_scanned: usize,
) -> PatternLength {
    let cycles = cycles.max(1);
    PatternLength {
        cycles,
        seconds: spc.map(|s| s * cycles as f64),
        bpm,
        kind,
        window_scanned,
    }
}

/// When the full-window periodicity check is too strict (window not an integer
/// multiple of the period), find the first index `p > 0` where `sigs[p] ==
/// sigs[0]` and `sigs[0..p] == sigs[p..2p]` (when enough data exists).
fn first_return_period(sigs: &[String]) -> Option<usize> {
    let n = sigs.len();
    if n < 2 || sigs[0].is_empty() {
        // Empty cycle-0 signature is common for pickup rests; skip this heuristic.
        return None;
    }
    for p in 1..=(n / 2) {
        if sigs[p] != sigs[0] {
            continue;
        }
        // Verify one full period match when we have 2p samples.
        if n >= p * 2 {
            if sigs[..p] == sigs[p..p * 2] {
                return Some(p);
            }
            continue;
        }
        // Only one partial return — require every available sample to align.
        if (0..(n - p)).all(|i| sigs[i] == sigs[i + p]) {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_loop_bd() {
        let len = detect_pattern_length(r#"setbpm(120); s("bd*4")"#, 32)
            .unwrap()
            .expect("should detect");
        assert_eq!(len.cycles, 1);
        assert_eq!(len.kind, LengthKind::Loop);
        assert!(len.seconds.is_some());
    }

    #[test]
    fn two_step_slowcat() {
        let len = detect_pattern_length(r#"setbpm(120); s("<bd sd>")"#, 16)
            .unwrap()
            .expect("should detect");
        assert_eq!(len.cycles, 2);
        assert_eq!(len.kind, LengthKind::Loop);
    }

    #[test]
    fn pickrestart_total() {
        let code = r#"
const sections = {
  intro: s("bd*4"),
  drop: s("bd*4,hh*8"),
};
$: "<intro@4 drop@8>".pickRestart({ intro: sections.intro, drop: sections.drop })
"#;
        let len = detect_pattern_length(code, 64)
            .unwrap()
            .expect("pickRestart total");
        assert_eq!(len.cycles, 12);
        assert_eq!(len.kind, LengthKind::PickRestart);
    }

    #[test]
    fn content_end_after_silence() {
        // 3 cycles of hits then rests: cat via slowcat angles.
        // "<bd bd bd - - - - ->" → onset cycles 0,1,2 then silence.
        let code = r#"setbpm(120); s("<bd bd bd - - - - ->")"#;
        let len = detect_pattern_length(code, 32)
            .unwrap()
            .expect("content end");
        // Either loop of 8 (full slowcat) or content_end of 3 — both valid;
        // full slowcat period is preferred when 2 periods fit.
        assert!(
            len.cycles == 8 || len.cycles == 3,
            "unexpected cycles={} kind={:?}",
            len.cycles,
            len.kind
        );
    }
}
