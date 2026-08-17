//! Form critique: read a pattern's section structure (pickRestart labels /
//! density) and flag off-grid sections, weak energy arcs, and other
//! arrangement-shape problems. Shares the [`Critique`]/[`Finding`] vocabulary
//! with the mix critique.

use crate::arrangement::analyze;
use crate::critique::{Critique, Finding};
use crate::inspect::*;

/// Rough energy tier for a section name (`intro`, `drop`, `lift`, …). Used to
/// sanity-check that named sections have the density their name implies.
/// 1 = low (intro/break/outro), 3 = rising (lift/build), 5 = peak (drop/chorus),
/// 2 = mid/default (verse).
pub(crate) fn label_energy(name: &str) -> i32 {
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
pub(crate) fn parse_pickrestart_labels(code: &str) -> Option<Vec<String>> {
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
pub(crate) fn parse_pickrestart_slow(code: &str) -> Option<u32> {
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
pub fn critique_form(ev: &crate::Evaluated) -> Critique {
    let code = ev.code();
    let d = ev.digest();
    let window = ev.window();

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
                return Critique { ok, findings };
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
        let a = analyze(ev);
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
    Critique { ok, findings }
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
