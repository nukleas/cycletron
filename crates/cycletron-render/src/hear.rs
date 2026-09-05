//! `hear_pattern`: render the mix and its stems offline, measure what actually
//! came out, and put the measurement next to the symbolic estimate the review
//! made without hearing anything. The agent's ears.
//!
//! The comparison is band for band — the same six bands
//! [`cycletron_analysis::spectral::BANDS`] on both sides — so a wrong
//! prediction is a visible number, and the model's tuning can start from data.

use crate::{SampleSetPaths, mix_of, render_pcm, resolve_patterns, resolve_tempo};
use cycletron_analysis::spectral::{BANDS, NB, predicted_bands, sound_names};
use cycletron_analysis::spectrum::{LEVEL_FLOOR_DB, Measured, dominant_band, measure};
use cycletron_analysis::{Evaluated, Finding};
use serde::Serialize;
use std::fmt::Write;
use std::time::Instant;
use strudel_core::Pattern;

/// Hard ceilings: however many cycles are asked for, a hear never renders
/// more than this much audio.
pub const MAX_CYCLES: usize = 32;
pub const MAX_SECONDS: f64 = 60.0;
/// Default window when the pattern does not reveal a loop period.
const DEFAULT_CYCLES: usize = 4;
/// A predicted vs pink-weighted measured gap (absolute share) worth naming.
const DISAGREE: f64 = 0.20;

/// What a balanced mix looks like on the pink-weighted level view, dB relative
/// to the loudest band: music falls ~1.5 dB/octave steeper than pink above the
/// low-mids, and the sub sits a little under the bass. First-pass reference —
/// tune it from `hear_timing` sweeps over real tracks, not from theory.
const REF_DB: [f64; NB] = [-3.0, 0.0, -2.0, -4.0, -7.0, -10.0];
/// A band this far below its reference (dB) has effectively nothing in it.
const MISSING_DB: f64 = 12.0;
/// A band this far above its reference is dominating.
const EXCESS_DB: f64 = 8.0;
/// A render peaking under this is quiet enough to say so.
const QUIET_PEAK_DBFS: f64 = -24.0;

#[derive(Debug, Clone)]
pub struct HearOptions {
    /// Cycles to render. Default: the loop period, clamped to 1..=8.
    pub cycles: Option<usize>,
    /// Also render and measure each stem (`$:` track / top-level stack arg).
    pub stems: bool,
    pub gain: f32,
    /// Tempo when the code sets none (the session's), else [`crate::DEFAULT_BPM`].
    pub bpm: Option<f64>,
}

impl Default for HearOptions {
    fn default() -> Self {
        Self {
            cycles: None,
            stems: true,
            gain: crate::DEFAULT_GAIN,
            bpm: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StemReport {
    pub name: String,
    /// The sounds that fire in this stem, so `gain-2` reads as `bd, sd`.
    pub sounds: Vec<String>,
    pub measured: Measured,
    /// The symbolic estimate for this stem alone; None when none of its
    /// events carries a sound.
    pub predicted: Option<[f64; NB]>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HearReport {
    pub cycles: usize,
    pub seconds: f64,
    pub bpm: f64,
    /// True when the cycle count was cut to stay under [`MAX_SECONDS`].
    pub capped: bool,
    pub mix: Measured,
    pub predicted_mix: Option<[f64; NB]>,
    pub stems: Vec<StemReport>,
    /// Over the mix render.
    pub clipped_samples: u64,
    /// Bands where the estimate and the pink-weighted measurement differ by
    /// more than [`DISAGREE`] — calibration data for the symbolic model.
    pub disagreements: Vec<String>,
    /// What the render itself says: clipping, silence, a quiet master, and
    /// balance against [`REF_DB`] on the pink-weighted level view.
    pub findings: Vec<Finding>,
    /// One line: `clean`, or the problems found.
    pub verdict: String,
    pub render_ms: u64,
}

/// Render and measure `code`.
pub fn hear(code: &str, samples: &SampleSetPaths, opts: HearOptions) -> Result<HearReport, String> {
    if code.trim().is_empty() {
        return Err("nothing to hear — the code is empty".into());
    }
    let started = Instant::now();

    // The analysis evaluation gives the loop period (for the default window)
    // and is the same evaluator the review ran, so a failure here is the
    // review's INVALID, not a render quirk.
    let ev = Evaluated::new(code, 8)?;
    let (stems, file_tempo) = resolve_patterns(code, opts.stems)?;
    let bpm = resolve_tempo(file_tempo, opts.bpm);
    let seconds_per_cycle = 240.0 / bpm;

    let wanted = opts
        .cycles
        .filter(|&c| c > 0)
        .unwrap_or_else(|| {
            ev.digest()
                .period_cycles
                .map_or(DEFAULT_CYCLES, |p| p.clamp(1, 8))
        })
        .min(MAX_CYCLES);
    let fits = ((MAX_SECONDS / seconds_per_cycle).floor() as usize).max(1);
    let cycles = wanted.min(fits);
    let capped = cycles < wanted;
    let seconds = cycles as f64 * seconds_per_cycle;

    let mix_pattern = mix_of(&stems);
    let mix_pcm = render_pcm(&mix_pattern, bpm, opts.gain, seconds, samples)?;
    let mix = measure(&mix_pcm.mono(), mix_pcm.sample_rate);
    let predicted_mix = predict(&mix_pattern, cycles);

    let mut stem_reports = Vec::new();
    if opts.stems && stems.len() > 1 {
        for (name, pattern) in &stems {
            let pcm = render_pcm(pattern, bpm, opts.gain, seconds, samples)?;
            stem_reports.push(StemReport {
                name: name.clone(),
                sounds: sound_names(&pattern.query_arc(0, cycles as i32)),
                measured: measure(&pcm.mono(), pcm.sample_rate),
                predicted: predict(pattern, cycles),
            });
        }
    }

    let disagreements = match (&predicted_mix, mix.silent) {
        (Some(pred), false) => disagreements(pred, &mix.pink),
        _ => Vec::new(),
    };

    let findings = measured_findings(&mix, mix_pcm.clipped);
    let verdict = if findings.is_empty() {
        "clean".to_string()
    } else {
        findings
            .iter()
            .map(|f| f.code.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };

    Ok(HearReport {
        cycles,
        seconds,
        bpm,
        capped,
        mix,
        predicted_mix,
        stems: stem_reports,
        clipped_samples: mix_pcm.clipped,
        disagreements,
        findings,
        verdict,
        render_ms: started.elapsed().as_millis() as u64,
    })
}

/// Verdict from the render alone. Balance is judged on the pink-weighted level
/// view against [`REF_DB`]; raw power share is not judged (it is bass-heavy
/// for every real mix).
pub fn measured_findings(mix: &Measured, clipped: u64) -> Vec<Finding> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<Finding>, severity: &str, code: &str, message: String| {
        out.push(Finding {
            severity: severity.into(),
            code: code.into(),
            message,
        });
    };
    if clipped > 0 {
        push(
            &mut out,
            "warn",
            "clipping",
            format!(
                "{clipped} sample(s) exceeded full scale in the mix render (peak {:+.1} dBFS) — \
                 lower gains or the master.",
                mix.peak_db
            ),
        );
    }
    if mix.silent {
        push(
            &mut out,
            "warn",
            "silent-render",
            format!(
                "The mix rendered as silence (rms {:.0} dBFS) — the sounds may not exist in the \
                 offline sample set, or every layer is muted or gained to zero.",
                mix.rms_db
            ),
        );
        return out;
    }
    if mix.peak_db < QUIET_PEAK_DBFS {
        push(
            &mut out,
            "note",
            "quiet",
            format!(
                "Quiet render: peak {:+.1} dBFS, rms {:+.1} dBFS — plenty of headroom; raise \
                 gains or the master before export.",
                mix.peak_db, mix.rms_db
            ),
        );
    }
    let rel: Vec<f64> = (0..NB).map(|i| mix.level_db[i] - REF_DB[i]).collect();
    let (sub, bass, lowmid, mid, presence, air) = (rel[0], rel[1], rel[2], rel[3], rel[4], rel[5]);
    let db = |i: usize| format!("{:+.0} dB", mix.level_db[i]);

    if presence < -MISSING_DB && air < -MISSING_DB {
        push(
            &mut out,
            "note",
            "dull",
            format!(
                "Almost nothing above ~2.5 kHz (presence {}, air {} vs the loudest band) — dark, \
                 no definition. Add or lift hats/cymbals, or brighten a voice.",
                db(4),
                db(5)
            ),
        );
    } else if presence > EXCESS_DB || air > EXCESS_DB {
        push(
            &mut out,
            "note",
            "top-heavy",
            format!(
                "Top end dominates (presence {}, air {} vs the loudest band) — can read harsh. \
                 Tame hats/cymbals or roll off highs.",
                db(4),
                db(5)
            ),
        );
    }
    if lowmid < -MISSING_DB && mid < -MISSING_DB && (sub > -6.0 || bass > -6.0) {
        push(
            &mut out,
            "note",
            "low-heavy",
            format!(
                "Low end towers over the body (low-mid {}, mid {} vs the loudest band) — only \
                 kick and bass are really there. Bring up the chords/leads or high-pass them \
                 into the mids.",
                db(2),
                db(3)
            ),
        );
    } else if mid < -MISSING_DB + 2.0 && bass > -4.0 && presence > -6.0 {
        push(
            &mut out,
            "note",
            "hollow",
            format!(
                "Scooped mids (mid {} vs the loudest band, with bass and presence both present) \
                 — can sound hollow; give a voice some 800 Hz–2.5 kHz body.",
                db(3)
            ),
        );
    }
    if mix.level_db[0] <= LEVEL_FLOOR_DB + 30.0 {
        push(
            &mut out,
            "note",
            "no-sub",
            format!(
                "No sub content below 60 Hz (sub {}) — fine for lo-fi or ambient, thin on a club \
                 system; a sine bass an octave down or a longer kick tail fills it.",
                db(0)
            ),
        );
    }
    out
}

fn predict(pattern: &Pattern, cycles: usize) -> Option<[f64; NB]> {
    predicted_bands(&pattern.query_arc(0, cycles as i32))
}

fn disagreements(pred: &[f64; NB], pink: &[f64; NB]) -> Vec<String> {
    let mut out = Vec::new();
    for i in 0..NB {
        let gap = pred[i] - pink[i];
        if gap.abs() > DISAGREE {
            out.push(format!(
                "{}: estimate {:.0}%, render {:.0}% — the symbolic model {} this band for \
                 these sounds",
                BANDS[i].0,
                pred[i] * 100.0,
                pink[i] * 100.0,
                if gap > 0.0 {
                    "overstates"
                } else {
                    "understates"
                },
            ));
        }
    }
    out
}

fn pct(x: f64) -> String {
    format!("{:>3.0}%", x * 100.0)
}

fn khz(hz: f64) -> String {
    if hz >= 1000.0 {
        format!("{:.1}k", hz / 1000.0)
    } else {
        format!("{}", hz.round() as i64)
    }
}

/// The tool's prose: header, the mix table (predicted vs measured), one row
/// per stem, disagreements, verdict. Stays under ~40 lines.
pub fn report_to_text(r: &HearReport) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "HEAR — rendered {} cycle(s), {:.1} s at {:.0} bpm{}{}",
        r.cycles,
        r.seconds,
        r.bpm,
        if r.stems.is_empty() {
            String::new()
        } else {
            format!(", mix + {} stem(s)", r.stems.len())
        },
        if r.capped {
            format!(" (cut to stay under {MAX_SECONDS:.0} s)")
        } else {
            String::new()
        },
    );
    let _ = writeln!(
        s,
        "  peak {:+.1} dBFS · rms {:+.1} dBFS · crest {:.1} dB · {} · render {} ms",
        r.mix.peak_db,
        r.mix.rms_db,
        r.mix.crest_db,
        if r.clipped_samples == 0 {
            "no clipping".to_string()
        } else {
            format!("{} clipped sample(s)", r.clipped_samples)
        },
        r.render_ms,
    );

    s.push_str("== mix per band: estimate · render (pink-weighted share) · level vs loudest ==\n");
    s.push_str("  band       estimate  render   level\n");
    for (i, (name, _, _)) in BANDS.iter().enumerate() {
        let p = r
            .predicted_mix
            .map_or_else(|| "   —".to_string(), |b| pct(b[i]));
        let _ = writeln!(
            s,
            "  {name:<10} {p:>8}  {:>6}  {:>+5.0} dB",
            pct(r.mix.pink[i]),
            r.mix.level_db[i]
        );
    }
    if r.mix.silent {
        s.push_str("  (silent render — no spectrum)\n");
    } else {
        let _ = writeln!(
            s,
            "  centroid {} Hz · loudest band {}",
            khz(r.mix.centroid_hz),
            dominant_band(&r.mix.pink)
        );
    }

    if !r.stems.is_empty() {
        s.push_str(
            "== stems: level per band [sub bass low-mid mid presence air] dB · centroid · peak ==\n",
        );
        for st in &r.stems {
            let label = if st.sounds.is_empty() {
                st.name.clone()
            } else {
                format!("{} ({})", st.name, st.sounds.join(", "))
            };
            if st.measured.silent {
                let _ = writeln!(
                    s,
                    "  {label:<24} silent (rms {:.0} dBFS) — inaudible: gained to nothing, or \
                     its sounds are not in the offline sample set",
                    st.measured.rms_db
                );
                continue;
            }
            let levels: Vec<String> = st
                .measured
                .level_db
                .iter()
                .map(|d| format!("{d:>+4.0}"))
                .collect();
            let pred = st.predicted.map_or_else(String::new, |p| {
                format!("  (estimate: {})", dominant_band(&p))
            });
            let _ = writeln!(
                s,
                "  {label:<24} [{}] · {} Hz · {:+.1} dBFS{pred}",
                levels.join(" "),
                khz(st.measured.centroid_hz),
                st.measured.peak_db,
            );
        }
    }

    if !r.disagreements.is_empty() {
        s.push_str("== estimate vs render (calibration of the symbolic model) ==\n");
        for d in &r.disagreements {
            let _ = writeln!(s, "  {d}");
        }
    }

    s.push_str("== verdict (from the render) ==\n");
    if r.findings.is_empty() {
        s.push_str("  clean — balanced against a typical mix tilt; no clipping.\n");
    }
    for f in &r.findings {
        let _ = writeln!(s, "  [{}] {}: {}", f.severity, f.code, f.message);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::cycletron_set;

    fn hear_default(code: &str) -> HearReport {
        hear(
            code,
            &cycletron_set(),
            HearOptions {
                cycles: Some(2),
                bpm: Some(120.0),
                ..HearOptions::default()
            },
        )
        .expect("hear")
    }

    #[test]
    fn kick_is_bass_heavy_and_prediction_agrees() {
        let r = hear_default(r#"s("bd*4")"#);
        assert!(!r.mix.silent);
        assert_eq!(r.cycles, 2);
        assert!((r.seconds - 4.0).abs() < 1e-9);
        let low = r.mix.bands[0] + r.mix.bands[1];
        assert!(low > 0.6, "kick should be low-heavy: {:?}", r.mix.bands);
        let pred = r.predicted_mix.expect("predicted");
        assert!(pred[0] + pred[1] > 0.6, "{pred:?}");
        assert_eq!(r.clipped_samples, 0);
        assert!(r.stems.is_empty(), "single layer has no stems");
        let text = report_to_text(&r);
        assert!(text.starts_with("HEAR — rendered 2 cycle(s)"), "{text}");
        assert!(text.contains("== verdict (from the render) =="), "{text}");
    }

    #[test]
    fn sine_lands_in_its_band_on_both_sides() {
        let r = hear_default(r#"note("c5").s("sine").gain(0.6)"#);
        // c5 = 523 Hz → low-mid on both the estimate and the render.
        assert_eq!(dominant_band(&r.mix.bands), "low-mid", "{:?}", r.mix.bands);
        assert_eq!(dominant_band(&r.predicted_mix.unwrap()), "low-mid");
        assert!(r.disagreements.len() <= 1, "{:?}", r.disagreements);
    }

    #[test]
    fn hats_are_bright() {
        let r = hear_default(r#"s("hh*8")"#);
        assert!(!r.mix.silent);
        assert!(
            r.mix.bands[4] + r.mix.bands[5] > 0.5,
            "hats should sit in presence/air: {:?}",
            r.mix.bands
        );
        assert!(r.mix.centroid_hz > 2500.0, "{}", r.mix.centroid_hz);
    }

    #[test]
    fn stems_are_measured_separately() {
        let r = hear_default("setbpm(120)\n// Kick\n$: s(\"bd*4\")\n// Hats\n$: s(\"hh*8\")\n");
        assert_eq!(r.stems.len(), 2);
        let kick = &r.stems[0];
        let hats = &r.stems[1];
        assert_eq!(kick.name, "Kick");
        assert_eq!(kick.sounds, vec!["bd".to_string()]);
        assert_eq!(hats.sounds, vec!["hh".to_string()]);
        assert!(kick.measured.centroid_hz < hats.measured.centroid_hz);
        assert_eq!(dominant_band(&kick.predicted.unwrap()), "sub");
        let text = report_to_text(&r);
        assert!(text.contains("== stems"), "{text}");
        assert!(text.lines().count() < 40, "{text}");
    }

    #[test]
    fn silent_render_is_reported() {
        let r = hear_default(r#"s("bd*4").gain(0)"#);
        assert!(r.mix.silent);
        assert!(r.findings.iter().any(|f| f.code == "silent-render"));
        assert_eq!(r.verdict, "silent-render");
        assert!(r.disagreements.is_empty());
    }

    /// The measured verdict judges the pink-weighted level view against a
    /// typical mix tilt, not raw power share — a synthetic "balanced" mix
    /// (one sine per band at the reference levels) is clean, a lone
    /// kick-and-bass is low-heavy and dull, a hat-only buffer is top-heavy.
    #[test]
    fn measured_verdict_uses_the_tilt_reference() {
        use cycletron_analysis::spectrum::measure;
        const SR: u32 = 44_100;
        let n = SR as usize;
        let tone = |hz: f32, amp: f32| -> Vec<f32> {
            (0..n)
                .map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin())
                .collect()
        };
        let sum = |parts: &[Vec<f32>]| -> Vec<f32> {
            (0..n).map(|i| parts.iter().map(|p| p[i]).sum()).collect()
        };
        // Single tones: the level view is amplitude in dB up to the per-band
        // octave weighting, so land each tone on REF_DB corrected for that.
        let amp = |i: usize, db: f64| {
            let oct = cycletron_analysis::spectral::octaves(i);
            0.2 * (10f64.powf(db / 20.0) * oct.sqrt()) as f32
        };
        let balanced = sum(&[
            tone(40.0, amp(0, -3.0)),
            tone(120.0, amp(1, 0.0)),
            tone(450.0, amp(2, -2.0)),
            tone(1400.0, amp(3, -4.0)),
            tone(3900.0, amp(4, -7.0)),
            tone(11000.0, amp(5, -10.0)),
        ]);
        let m = measure(&balanced, SR);
        let f = measured_findings(&m, 0);
        assert!(
            f.is_empty(),
            "balanced mix should be clean: {f:?} {:?}",
            m.level_db
        );

        let low_only = sum(&[tone(45.0, 0.3), tone(110.0, 0.3)]);
        let codes: Vec<String> = measured_findings(&measure(&low_only, SR), 0)
            .into_iter()
            .map(|f| f.code)
            .collect();
        assert!(codes.contains(&"dull".to_string()), "{codes:?}");
        assert!(codes.contains(&"low-heavy".to_string()), "{codes:?}");

        let hats_only = tone(9000.0, 0.3);
        let codes: Vec<String> = measured_findings(&measure(&hats_only, SR), 0)
            .into_iter()
            .map(|f| f.code)
            .collect();
        assert!(codes.contains(&"top-heavy".to_string()), "{codes:?}");
        assert!(codes.contains(&"no-sub".to_string()), "{codes:?}");

        let m = measure(&tone(120.0, 0.02), SR);
        assert!(
            measured_findings(&m, 0).iter().any(|f| f.code == "quiet"),
            "{:?}",
            m.peak_db
        );
        assert!(
            measured_findings(&m, 3)
                .iter()
                .any(|f| f.code == "clipping")
        );
    }

    #[test]
    fn window_defaults_to_the_loop_period_and_is_capped() {
        let r = hear(
            r#"s("<bd sd hh>")"#,
            &cycletron_set(),
            HearOptions {
                bpm: Some(120.0),
                ..HearOptions::default()
            },
        )
        .unwrap();
        assert_eq!(r.cycles, 3, "period of a 3-way alternation");

        let r = hear(
            r#"s("bd")"#,
            &cycletron_set(),
            HearOptions {
                cycles: Some(32),
                bpm: Some(60.0), // 4 s per cycle → 32 cycles would be 128 s
                ..HearOptions::default()
            },
        )
        .unwrap();
        assert!(r.capped);
        assert_eq!(r.cycles, 15);
        assert!(r.seconds <= MAX_SECONDS);
    }

    /// Wall-time probe for a real song. Run with:
    ///   CYCLETRON_HEAR_FILE=path.strudel cargo test -p cycletron-render hear_timing -- --ignored --nocapture
    #[test]
    #[ignore = "manual timing — needs CYCLETRON_HEAR_FILE"]
    fn hear_timing() {
        let path = std::env::var("CYCLETRON_HEAR_FILE").expect("CYCLETRON_HEAR_FILE");
        let code = std::fs::read_to_string(&path).expect("read song");
        for stems in [false, true] {
            let t = Instant::now();
            let r = hear(
                &code,
                &cycletron_set(),
                HearOptions {
                    stems,
                    ..HearOptions::default()
                },
            )
            .expect("hear");
            eprintln!(
                "{path}: stems={stems} cycles={} seconds={:.1} stems_rendered={} wall={} ms",
                r.cycles,
                r.seconds,
                r.stems.len(),
                t.elapsed().as_millis()
            );
            eprintln!("{}", report_to_text(&r));
        }
    }

    #[test]
    fn invalid_code_is_the_evaluators_error() {
        let err = hear(
            "s(\"bd*4\").nope(((",
            &cycletron_set(),
            HearOptions::default(),
        )
        .unwrap_err();
        assert!(!err.is_empty());
        assert!(
            hear("   ", &cycletron_set(), HearOptions::default())
                .unwrap_err()
                .contains("empty")
        );
    }
}
