//! Arrangement analysis: detect the loop period, segment a pattern into
//! sections by active instrumentation, and render the song form with
//! wall-clock section lengths.

use serde::Serialize;

use crate::form::{parse_pickrestart_labels, parse_pickrestart_slow};
use crate::inspect::*;

/// The result of arrangement analysis: loop period, sections by
/// instrumentation, and the derived song form.
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
/// Analyze a pattern's arrangement over its evaluated window: detect the loop
/// period and segment it into sections by active instrument.
pub fn analyze(ev: &crate::Evaluated) -> ArrangementAnalysis {
    let window = ev.window();
    let bpm = ev.bpm();
    let spc = ev.seconds_per_cycle();

    // Per cycle: the set of active instruments (including notes sustained from
    // earlier cycles), the onset count, and a content signature for period
    // detection.
    let mut active: Vec<Vec<String>> = Vec::with_capacity(window);
    let mut onset_counts: Vec<usize> = Vec::with_capacity(window);
    let mut sigs: Vec<String> = Vec::with_capacity(window);

    for (c, haps) in ev.cycle_haps().iter().enumerate() {
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut onsets = 0usize;
        let mut sig_parts: Vec<String> = Vec::new();

        for hap in haps {
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
    let labeled = parse_pickrestart_labels(ev.code())
        .map(|labels| (labels, parse_pickrestart_slow(ev.code()).unwrap_or(1) as usize));

    // A pickRestart selector defines the song's loop explicitly: total length =
    // (expanded token count) × the per-token `.slow(n)` factor. This is the
    // authoritative length for section-based / cover songs, where the onset
    // fingerprint (`smallest_period`) often won't find a clean repeat inside the
    // scan window. It wins over fingerprint detection below.
    let pick_total = labeled.as_ref().map(|(labels, n)| labels.len() * n);

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
    // pickRestart total is the authoritative loop length; fall back to the
    // onset-fingerprint period when there's no selector.
    let period_cycles = pick_total.or(period);
    let total_seconds = period_cycles.and_then(|p| spc.map(|s| s * p as f64));

    ArrangementAnalysis {
        bpm,
        seconds_per_cycle: spc,
        window_cycles: window,
        period_cycles,
        repeats: period_cycles.is_some(),
        total_seconds,
        form,
        sections,
    }
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
