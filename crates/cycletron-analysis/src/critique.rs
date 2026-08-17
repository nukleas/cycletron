//! Mix critique: heuristic musical lint (clipping, silent cycles, mono image,
//! semitone clashes, missing low end, static pitch) over a pattern's digest and
//! source. Not correctness — whether it is likely to sound good.

use serde::Serialize;

use crate::inspect::*;

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

/// Critique a pattern over its evaluated window: heuristic checks over the
/// first loop (or the whole window if it doesn't repeat).
pub fn critique(ev: &crate::Evaluated) -> Critique {
    let d = ev.digest();
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
    let span = d
        .period_cycles
        .unwrap_or(d.cycles_queried)
        .min(d.cycles.len());

    // --- Fully silent ------------------------------------------------------
    if d.total_events == 0 {
        findings.push(warn(
            "silent",
            "Pattern emits no events — nothing will sound.".to_string(),
        ));
        return Critique {
            ok: false,
            findings,
        };
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
                silent
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
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
    // Centre-pan is the DEFAULT, so don't nag every sketch: only nudge on a
    // dense (5+ simultaneous voices), pitched mix where stereo width genuinely
    // helps — not a 3-voice drum-and-bass seed.
    if !d.uses_pan && d.max_voices >= 5 && d.note_low.is_some() {
        findings.push(note(
            "mono",
            format!(
                "All {} voices are centre-panned — the mix is mono. Consider .pan() or .jux(rev) for width.",
                d.max_voices
            ),
        ));
    }

    // --- Static one-bar loop (develop it) ---------------------------------
    // A pitched piece whose ENTIRE content repeats every single cycle is a
    // robotic one-bar loop — the thing the form critique never caught because it
    // only runs on pickRestart/arrange. Nudge toward multi-bar development. (A
    // developed piece has a longer period, so it won't trip this.)
    if d.period_cycles == Some(1) && d.note_low.is_some() {
        findings.push(note(
            "loop-development",
            "The whole pattern repeats every bar — a robotic one-bar loop. Develop it across \
             several bars: a `<[bar] [bar] [bar] [bar]>` phrase (motif + variation), `every()`/`off()` \
             variation, or a section arrangement, so the music evolves."
                .to_string(),
        ));
    }

    // --- No low-end anchor ------------------------------------------------
    let has_pitched = d.note_low.is_some();
    let low_pitch = d.note_low.as_ref().is_some_and(|n| n.midi < 48); // below C3
    let low_drum = d.sounds.iter().any(|s| {
        let s = s.to_lowercase();
        s.contains("bd")
            || s.contains("sub")
            || s.contains("bass")
            || s == "sbd"
            || s.contains("808")
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
    if let (Some(lo), Some(hi)) = (&d.note_low, &d.note_high)
        && lo.midi == hi.midi
        && d.total_events > 2
    {
        findings.push(note(
            "static-pitch",
            format!(
                "Every pitched note is {} — the line never moves melodically.",
                lo.name
            ),
        ));
    }

    // --- Spectral masking / balance ---------------------------------------
    // Loudness (above) catches clipping; this catches the *other* way a mix
    // fails — a voice buried in a band another voice owns (the vocal-under-
    // strings case). Estimated symbolically from each voice's sound, register,
    // and filters; advisory notes only, so the gate still passes.
    findings.extend(crate::spectral::spectral_findings(ev, span.max(1)));

    let ok = !findings.iter().any(|f| f.severity == "warn");
    Critique { ok, findings }
}

/// Is this sound a drum/percussion voice (a short transient, not sustained
/// energy)? Matches the default drum names and drum-machine voices like
/// `RolandTR808_bd` (the voice is the suffix after the last `_`).
fn is_percussive(sound: &str) -> bool {
    const DRUMS: [&str; 12] = [
        "bd", "sd", "sn", "hh", "cp", "oh", "ht", "mt", "lt", "cr", "cb", "rs",
    ];
    let voice = sound.rsplit('_').next().unwrap_or(sound);
    DRUMS.contains(&voice)
}

/// Does a string look like a chord symbol the author forgot to `.voicing()`
/// (e.g. `Cm7`, `FM7`, `G#dim`)? An unvoiced chord symbol reaches the sampler
/// as a sound name and plays nothing.
fn looks_like_chord_symbol(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
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

/// Strip `//`-to-end-of-line comments (blanking them, keeping line structure)
/// so source-level token counting ignores prose and `// @track` markers.
fn strip_line_comments(code: &str) -> String {
    code.lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Source-level lints for silent failures the digest can't see. Today: a
/// `chord(...)` with no matching `.voicing()` — the chord symbol never
/// expands to pitches, so the layer is silent even though the sound name on
/// the chain is legal (the digest-level check only catches the
/// symbol-used-AS-sound case).
pub fn lint_source(code: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    // Count only in executable code — a `chord(...)` mentioned in a `//` comment
    // (or a `// @track` marker) must not trip the lint. Mini-notation strings
    // never contain `//`, so a plain line-comment strip is safe here.
    let stripped = strip_line_comments(code);
    let chords = stripped.matches("chord(").count();
    let voicings = stripped.matches(".voicing(").count();
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
    // Informational: a melodic pattern with no instrument assigned plays a bare
    // sine (the default). Audible, but usually not intended — nudge to pick a
    // sound. Coarse whole-document check (a `.s(...)` anywhere suppresses it), so
    // it never false-warns a piece that does assign sounds.
    let melodic = stripped.contains("note(") || stripped.contains(".n(");
    let has_instrument = stripped.contains(".s(")
        || stripped.contains(".sound(")
        || stripped.contains("s(\"")
        || stripped.contains("sound(");
    if melodic && !has_instrument {
        findings.push(Finding {
            severity: "note".to_string(),
            code: "default-synth".to_string(),
            message: "a note(…) layer has no .s()/.sound() — it plays a bare sine (the default). \
                      Add .s(\"…\") to pick an instrument."
                .to_string(),
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
pub fn lint_digest(d: &PatternDigest, known: &crate::sounds::SoundSet) -> Vec<Finding> {
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
        let mut suggestions: Vec<&str> = known
            .iter()
            .filter(|k| k.starts_with(&prefix) || k.contains(s.as_str()) || s.contains(*k))
            .collect();
        suggestions.sort();
        suggestions.truncate(3);
        let hint = if suggestions.is_empty() {
            "Check list_sounds for what exists.".to_string()
        } else {
            format!(
                "Did you mean {}?",
                suggestions
                    .iter()
                    .map(|s| format!("'{s}'"))
                    .collect::<Vec<_>>()
                    .join(" / ")
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
            if let Some(p) = e.pan
                && !(0.0..=1.0).contains(&p)
            {
                bad_pan = Some(p);
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
