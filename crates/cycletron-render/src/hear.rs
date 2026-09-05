//! `hear_pattern`: render the mix and its stems offline, measure what actually
//! came out, and put the measurement next to the symbolic estimate the review
//! made without hearing anything. The agent's ears.
//!
//! The comparison is band for band — the same six bands
//! [`cycletron_analysis::spectral::BANDS`] on both sides — so a wrong
//! prediction is a visible number, and the model's tuning can start from data.

use crate::{SampleSetPaths, mix_of, render_pcm, resolve_patterns, resolve_tempo};
use cycletron_analysis::spectral::{BANDS, NB, balance_findings, predicted_bands};
use cycletron_analysis::spectrum::{Measured, dominant_band, measure};
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
/// A predicted vs measured gap (absolute energy share) worth naming.
const DISAGREE: f64 = 0.15;

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
    /// Bands where the estimate and the measurement differ by more than
    /// [`DISAGREE`], in the mixer's language.
    pub disagreements: Vec<String>,
    /// Balance findings from the *measured* mix spectrum (the same thresholds
    /// the review applies to the estimate) plus clipping.
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
                measured: measure(&pcm.mono(), pcm.sample_rate),
                predicted: predict(pattern, cycles),
            });
        }
    }

    let disagreements = match (&predicted_mix, mix.silent) {
        (Some(pred), false) => disagreements(pred, &mix.bands),
        _ => Vec::new(),
    };

    let mut findings = Vec::new();
    if mix_pcm.clipped > 0 {
        findings.push(Finding {
            severity: "warn".into(),
            code: "clipping".into(),
            message: format!(
                "{} sample(s) exceeded full scale in the mix render (peak {:+.1} dBFS) — lower \
                 gains or the master.",
                mix_pcm.clipped, mix.peak_db
            ),
        });
    }
    if mix.silent {
        findings.push(Finding {
            severity: "warn".into(),
            code: "silent-render".into(),
            message: "The mix rendered as silence — the sounds may not exist in the offline \
                      sample set, or every layer is muted/gained to zero."
                .into(),
        });
    } else {
        findings.extend(balance_findings(&mix.bands, stems.len().max(1)));
    }
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

fn predict(pattern: &Pattern, cycles: usize) -> Option<[f64; NB]> {
    predicted_bands(&pattern.query_arc(0, cycles as i32))
}

fn disagreements(pred: &[f64; NB], meas: &[f64; NB]) -> Vec<String> {
    let mut out = Vec::new();
    for i in 0..NB {
        let gap = pred[i] - meas[i];
        if gap.abs() > DISAGREE {
            out.push(format!(
                "{}: predicted {:.0}%, measured {:.0}% — the estimate {} this band; trust the \
                 measurement",
                BANDS[i].0,
                pred[i] * 100.0,
                meas[i] * 100.0,
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

    s.push_str("== mix: energy share per band (predicted vs measured) ==\n");
    s.push_str("  band       predicted  measured\n");
    for (i, (name, _, _)) in BANDS.iter().enumerate() {
        let p = r
            .predicted_mix
            .map_or_else(|| "   —".to_string(), |b| pct(b[i]));
        let _ = writeln!(s, "  {name:<10} {p:>9}  {}", pct(r.mix.bands[i]));
    }
    if r.mix.silent {
        s.push_str("  (silent render — no spectrum)\n");
    } else {
        let _ = writeln!(
            s,
            "  centroid {} Hz · dominant {}",
            khz(r.mix.centroid_hz),
            dominant_band(&r.mix.bands)
        );
    }

    if !r.stems.is_empty() {
        s.push_str("== stems: measured [sub bass low-mid mid presence air] · centroid · peak ==\n");
        for st in &r.stems {
            if st.measured.silent {
                let _ = writeln!(
                    s,
                    "  {:<12} silent — its sounds may not be in the offline sample set",
                    st.name
                );
                continue;
            }
            let bands: Vec<String> = st.measured.bands.iter().map(|b| pct(*b)).collect();
            let pred = st.predicted.map_or_else(String::new, |p| {
                format!("  (predicted dominant {})", dominant_band(&p))
            });
            let _ = writeln!(
                s,
                "  {:<12} [{}] · {} Hz · {:+.1} dBFS{pred}",
                st.name,
                bands.join(" "),
                khz(st.measured.centroid_hz),
                st.measured.peak_db,
            );
        }
    }

    if !r.disagreements.is_empty() {
        s.push_str("== estimate vs render ==\n");
        for d in &r.disagreements {
            let _ = writeln!(s, "  {d}");
        }
    }

    s.push_str("== verdict ==\n");
    if r.findings.is_empty() {
        s.push_str("  clean — the render matches a balanced mix; no clipping.\n");
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
        assert!(text.contains("== verdict =="), "{text}");
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
