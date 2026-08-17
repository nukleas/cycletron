//! Symbolic spectral / masking analysis — "calculate the song" without hearing it.
//!
//! The mix critique next door computes *loudness* (a peak gain sum), which catches
//! clipping but is deaf to *masking*: two voices sharing a frequency band where the
//! quieter one gets buried. That's what hides a vocal behind strings even when the
//! mix isn't clipping. Masking is spectral, so we need a spectral picture.
//!
//! We don't do an FFT. Instead we estimate each voice's energy-per-band from data
//! the engine already hands us per event: the sound name (→ a base spectrum), the
//! note (→ a fundamental frequency), and the filter controls (`lpf`/`cutoff`,
//! `hpf`). A sawtooth is harmonically rich, a sine is a lone fundamental, a kick is
//! a low thump, a hat is high noise; an LPF caps the top, an HPF cuts the bottom.
//! Coarse, but directionally right — enough to warn "the vocal lives in the mid and
//! three louder voices are on top of it" *before* the pattern ships.
//!
//! The model is deliberately falsifiable: the same `export_audio` render path can
//! produce a real FFT to calibrate these estimates against (see the crate docs).

use crate::Finding;
use strudel_core::ContextKey;

/// Perceptual bands (name, low Hz, high Hz), low→high. Coarse octave-ish split
/// in the language mixers use, not critical-band precision.
const BANDS: [(&str, f64, f64); 6] = [
    ("sub", 20.0, 60.0),
    ("bass", 60.0, 250.0),
    ("low-mid", 250.0, 800.0),
    ("mid", 800.0, 2500.0),
    ("presence", 2500.0, 6000.0),
    ("air", 6000.0, 20000.0),
];
const NB: usize = BANDS.len();

/// Geometric-mean centre of a band — the representative frequency for filter math.
fn band_center(i: usize) -> f64 {
    (BANDS[i].1 * BANDS[i].2).sqrt()
}

/// Which band a frequency falls in (clamped to the ends).
fn band_of(hz: f64) -> usize {
    for (i, (_, _, hi)) in BANDS.iter().enumerate() {
        if hz < *hi {
            return i;
        }
    }
    NB - 1
}

/// Coarse timbre class → drives the base spectrum. Perc classes carry a fixed
/// band shape (their pitch is incidental); tonal/noise are parameterised.
enum Class {
    Kick,
    Snare,
    Hat,
    Tom,
    Metal,
    /// Broadband; `tilt` 0 = flat (white), 1 = low-heavy (brown).
    Noise(f64),
    /// Harmonic; `brightness` 0 = pure fundamental (sine), 1 = very rich (supersaw).
    Tonal(f64),
}

/// Map a sound name to a timbre class. Unknown names default to a mid tonal voice.
fn classify(sound: &str) -> Class {
    // Machine-kit voices carry a `Bank_voice` name; judge by the voice tail.
    let s = sound
        .rsplit('_')
        .next()
        .unwrap_or(sound)
        .to_ascii_lowercase();
    match s.as_str() {
        "bd" | "sbd" => Class::Kick,
        "sd" | "sn" | "cp" | "perc" | "hand" | "tabla" | "east" => Class::Snare,
        "hh" | "oh" | "cr" => Class::Hat,
        "lt" | "mt" | "ht" => Class::Tom,
        "cb" | "rs" | "rim" | "rd" | "click" | "metal" | "industrial" => Class::Metal,
        "amencutup" | "breaks165" | "breaks125" | "breaks152" => Class::Noise(0.2),
        "white" | "crackle" => Class::Noise(0.1),
        "pink" => Class::Noise(0.5),
        "brown" => Class::Noise(0.8),
        "sine" | "wt_sine" | "sub" => Class::Tonal(0.05),
        "triangle" | "wt_tri" => Class::Tonal(0.25),
        "sawtooth" | "wt_saw" | "superzow" => Class::Tonal(0.9),
        "square" | "pulse" | "superpwm" | "wt_square" => Class::Tonal(0.7),
        "supersaw" | "supersquare" => Class::Tonal(0.95),
        "fm" => Class::Tonal(0.6),
        "wt_bell" => Class::Tonal(0.85),
        "wt_pad" | "wt_choir" | "wt_strings" | "wt_organ" | "space" => Class::Tonal(0.55),
        other if other.starts_with("gm_") => {
            if other.contains("pad") || other.contains("string") || other.contains("choir") {
                Class::Tonal(0.55)
            } else if other.contains("bell") || other.contains("glock") || other.contains("xylo") {
                Class::Tonal(0.85)
            } else if other.contains("bass") {
                Class::Tonal(0.4)
            } else {
                Class::Tonal(0.5)
            }
        }
        _ => Class::Tonal(0.5),
    }
}

/// Fixed perc band shapes (energy per band, un-normalised).
fn perc_shape(class: &Class) -> [f64; NB] {
    match class {
        //             sub   bass  lowmid mid  presence air
        Class::Kick => [0.55, 0.40, 0.05, 0.00, 0.00, 0.00],
        Class::Snare => [0.00, 0.05, 0.20, 0.45, 0.35, 0.15],
        Class::Hat => [0.00, 0.00, 0.00, 0.08, 0.35, 0.75],
        Class::Tom => [0.05, 0.45, 0.40, 0.10, 0.00, 0.00],
        Class::Metal => [0.00, 0.00, 0.10, 0.45, 0.55, 0.35],
        _ => [0.0; NB],
    }
}

/// Harmonic-series energy for a tonal voice at fundamental `f0`. Higher
/// `brightness` = slower rolloff = more energy in upper harmonics/bands.
fn tonal_shape(f0: f64, brightness: f64) -> [f64; NB] {
    let mut b = [0.0f64; NB];
    // Amplitude of the k-th harmonic ~ 1/k^p; bright timbres have a smaller p.
    let p = 1.9 - 1.3 * brightness.clamp(0.0, 1.0);
    for k in 1..=20 {
        let f = f0 * k as f64;
        if f > 20_000.0 {
            break;
        }
        let amp = 1.0 / (k as f64).powf(p);
        b[band_of(f)] += amp * amp; // power
    }
    b
}

/// Noise energy across bands; `tilt` pulls weight toward the low end.
fn noise_shape(tilt: f64) -> [f64; NB] {
    let mut b = [0.0f64; NB];
    for (i, slot) in b.iter_mut().enumerate() {
        // i/(NB-1): 0 at sub, 1 at air. tilt 0 → flat, tilt 1 → fades to the top.
        *slot = 1.0 - tilt * (i as f64 / (NB - 1) as f64);
    }
    b
}

/// Apply LPF/HPF as 12 dB/oct power rolloffs (power ∝ (f/fc)^±2 past the corner).
fn apply_filters(mut b: [f64; NB], cutoff: Option<f64>, hpf: Option<f64>) -> [f64; NB] {
    for (i, slot) in b.iter_mut().enumerate() {
        let c = band_center(i);
        if let Some(lp) = cutoff {
            if lp > 0.0 && c > lp {
                *slot *= (lp / c).powi(2);
            }
        }
        if let Some(hp) = hpf {
            if hp > 0.0 && c < hp {
                *slot *= (c / hp).powi(2);
            }
        }
    }
    b
}

/// Normalise a vector to unit sum (so gain, not raw shape magnitude, sets level).
fn normalize(mut b: [f64; NB]) -> [f64; NB] {
    let s: f64 = b.iter().sum();
    if s > 0.0 {
        for x in &mut b {
            *x /= s;
        }
    }
    b
}

/// One accumulated voice: an identity, its summed per-band energy over the loop,
/// its representative gain, and how it should read to a human.
struct Voice {
    label: String,
    energy: [f64; NB],
    hits: usize,
}

/// The per-band energy shape for a single event.
fn event_energy(sound: &str, f0: Option<f64>, cutoff: Option<f64>, hpf: Option<f64>) -> [f64; NB] {
    let class = classify(sound);
    let base = match class {
        Class::Noise(tilt) => noise_shape(tilt),
        Class::Tonal(bright) => tonal_shape(f0.unwrap_or(220.0), bright),
        ref perc => perc_shape(perc),
    };
    apply_filters(normalize(base), cutoff, hpf)
}

fn getf(h: &strudel_core::Hap, k: ContextKey) -> Option<f64> {
    h.context.get(&k).and_then(crate::inspect::value_to_f64)
}

/// Read the sound name from a hap (context first, then the bare value).
fn hap_sound(h: &strudel_core::Hap) -> Option<String> {
    h.context
        .get(&ContextKey::Sound)
        .map(|v| format!("{v:?}"))
        .and_then(extract_str)
        .or_else(|| extract_str(format!("{:?}", h.value)))
}

/// Pull the inner string out of a `String("bd")`-style debug rendering.
fn extract_str(dbg: String) -> Option<String> {
    let start = dbg.find('"')? + 1;
    let end = dbg[start..].find('"')? + start;
    Some(dbg[start..end].to_string())
}

/// midi → Hz (A4 = 69 = 440).
fn midi_hz(m: f64) -> f64 {
    440.0 * 2f64.powf((m - 69.0) / 12.0)
}

/// A voice's fundamental, preferring an explicit `frequency`, then the pitch —
/// which lives in the `Note` control or, for a bare `note(...)`, in the hap value
/// itself (same resolution the digest uses).
fn hap_fundamental(h: &strudel_core::Hap) -> Option<f64> {
    if let Some(f) = getf(h, ContextKey::Frequency) {
        if f > 0.0 {
            return Some(f);
        }
    }
    let cand = h
        .context
        .get(&ContextKey::Note)
        .cloned()
        .unwrap_or_else(|| h.value.clone());
    let (_, midi) = crate::inspect::resolve_note(&cand);
    midi.map(|m| midi_hz(m as f64))
}

/// Analyse masking + spectral balance over the loop. Returns findings to fold
/// into the mix critique (severity "note" — advisory, never blocks the gate).
pub(crate) fn spectral_findings(ev: &crate::Evaluated, cycles: usize) -> Vec<Finding> {
    let cycles = cycles.clamp(1, 16).min(ev.window());

    // Accumulate energy per voice identity across the loop.
    use std::collections::BTreeMap;
    let mut voices: BTreeMap<String, Voice> = BTreeMap::new();

    for cycle_haps in &ev.cycle_haps()[..cycles] {
        for h in cycle_haps {
            if !h.has_onset() {
                continue;
            }
            let Some(sound) = hap_sound(h) else { continue };
            let cutoff = getf(h, ContextKey::Cutoff);
            let hpf = getf(h, ContextKey::Hpf);
            let f0 = hap_fundamental(h);
            let gain = getf(h, ContextKey::Gain).unwrap_or(1.0);

            let e = event_energy(&sound, f0, cutoff, hpf);
            let g2 = gain * gain; // power

            // Identity groups a part: sound + filter regime (register varies note
            // to note, so it's not part of identity — energy already reflects it).
            let id = format!(
                "{sound}|{}|{}",
                cutoff.map(|c| (c / 100.0).round() as i64).unwrap_or(-1),
                hpf.map(|c| (c / 100.0).round() as i64).unwrap_or(-1),
            );
            let v = voices.entry(id).or_insert_with(|| Voice {
                label: voice_label(&sound, cutoff, hpf),
                energy: [0.0; NB],
                hits: 0,
            });
            for i in 0..NB {
                v.energy[i] += e[i] * g2;
            }
            v.hits += 1;
        }
    }

    if voices.len() < 2 {
        return Vec::new(); // masking needs at least two voices
    }

    // Use MEAN per-hit energy, not the accumulated sum: masking is about how loud
    // a voice is *when it plays*, so a sparse-but-loud lead (a vocal on 2 notes a
    // bar) must not look quiet next to a busy pad. This treats the loop as if the
    // parts overlap — the worst case for masking, which is what we want to warn on.
    let mut voices: Vec<Voice> = voices.into_values().filter(|v| v.hits > 0).collect();
    for v in &mut voices {
        for i in 0..NB {
            v.energy[i] /= v.hits as f64;
        }
    }
    let mut band_total = [0.0f64; NB];
    for v in &voices {
        for i in 0..NB {
            band_total[i] += v.energy[i];
        }
    }
    let grand: f64 = band_total.iter().sum();
    if grand <= 0.0 {
        return Vec::new();
    }

    let mut findings = Vec::new();
    findings.extend(masking_findings(&voices, &band_total));
    findings.extend(balance_findings(&band_total, grand, voices.len()));
    findings
}

/// Human label for a voice: sound + where it sits + its filtering.
fn voice_label(sound: &str, cutoff: Option<f64>, hpf: Option<f64>) -> String {
    let mut parts = vec![sound.to_string()];
    if let Some(c) = cutoff {
        parts.push(format!("LPF {}", fmt_hz(c)));
    }
    if let Some(h) = hpf {
        parts.push(format!("HPF {}", fmt_hz(h)));
    }
    parts.join(", ")
}

fn fmt_hz(hz: f64) -> String {
    if hz >= 1000.0 {
        format!("{:.1}k", hz / 1000.0)
    } else {
        format!("{}", hz.round() as i64)
    }
}

/// Flag voices whose home band is dominated by louder voices (they'll be buried).
fn masking_findings(voices: &[Voice], band_total: &[f64; NB]) -> Vec<Finding> {
    /// A voice is masked when competitors in its home band outweigh it by this much.
    const MASK_RATIO: f64 = 2.5;
    let grand: f64 = band_total.iter().sum();

    let mut hits: Vec<(f64, String)> = Vec::new();
    for v in voices {
        let total: f64 = v.energy.iter().sum();
        // Ignore incidental textures — a voice must be a real presence to "want"
        // to be heard (≥6% of total mix energy).
        if total < 0.06 * grand {
            continue;
        }
        let home = (0..NB)
            .max_by(|&a, &b| v.energy[a].total_cmp(&v.energy[b]))
            .unwrap();
        let mine = v.energy[home];
        let competing = band_total[home] - mine;
        if mine > 0.0 && competing > mine * MASK_RATIO {
            // Name the top competitors sharing that band.
            let mut others: Vec<(f64, &str)> = voices
                .iter()
                .filter(|o| o.label != v.label && o.energy[home] > 0.0)
                .map(|o| (o.energy[home], o.label.as_str()))
                .collect();
            others.sort_by(|a, b| b.0.total_cmp(&a.0));
            let names: Vec<String> = others
                .iter()
                .take(2)
                .map(|(_, n)| (*n).to_string())
                .collect();
            let ratio = competing / mine;
            hits.push((
                ratio,
                format!(
                    "{} sits in the {} band but is masked there by {} (~{:.1}× louder combined) — \
                     it will be hard to hear. Lift its gain, carve that band on the louder voices \
                     (an LPF/notch), or move it to a clearer register/octave.",
                    v.label,
                    BANDS[home].0,
                    names.join(" + "),
                    ratio,
                ),
            ));
        }
    }
    // Worst first, cap at two so the critique stays actionable.
    hits.sort_by(|a, b| b.0.total_cmp(&a.0));
    hits.into_iter()
        .take(2)
        .map(|(_, message)| Finding {
            severity: "note".to_string(),
            code: "masking".to_string(),
            message,
        })
        .collect()
}

/// Flag a lopsided overall spectrum. Two independent axes that can co-occur (a
/// mix can be both muddy AND dark), so this returns a Vec:
///  - `spectral-balance`: the dominant tilt (mud / harsh / scooped);
///  - `dull`: a near-empty top end (no air/definition).
fn balance_findings(band_total: &[f64; NB], grand: f64, nvoices: usize) -> Vec<Finding> {
    let f = |i: usize| band_total[i] / grand;
    let (bass, lowmid, mid, presence, air) = (f(1), f(2), f(3), f(4), f(5));
    let note = |code: &str, message: String| Finding {
        severity: "note".to_string(),
        code: code.to_string(),
        message,
    };
    let mut out = Vec::new();

    if bass + lowmid > 0.62 {
        out.push(note(
            "spectral-balance",
            format!(
                "Mix is low-heavy (bass+low-mid = {:.0}% of energy) — likely muddy where the \
                 bass, pads and low notes pile up around 60–800 Hz. Thin some low-mids or \
                 high-pass the non-bass parts.",
                (bass + lowmid) * 100.0
            ),
        ));
    } else if presence + air > 0.55 {
        out.push(note(
            "spectral-balance",
            format!(
                "Mix is top-heavy (presence+air = {:.0}%) — can read harsh/brittle. Tame \
                 hats/cymbals or roll off some highs.",
                (presence + air) * 100.0
            ),
        ));
    } else if mid < 0.08 && (bass + lowmid) > 0.2 && (presence + air) > 0.2 {
        out.push(note(
            "spectral-balance",
            "Scooped mids (little 800 Hz–2.5 kHz energy) — the mix may sound hollow and lack \
             body/vocal presence."
                .to_string(),
        ));
    }

    // Dark/dull: almost nothing above ~2.5 kHz. Only for a real arrangement (≥3
    // voices) so a lone sub-bass sketch isn't nagged. Co-fires with low-heavy on
    // a muddy, hat-less mix — which is exactly the pile-up we want to name twice.
    if nvoices >= 3 && air < 0.03 && presence < 0.10 {
        out.push(note(
            "dull",
            format!(
                "Almost no energy above ~2.5 kHz (presence+air = {:.0}%) — the mix is dark and \
                 lacks air/definition: no hats, cymbals, or bright voices to open the top end. \
                 Add a hi-hat/cymbal layer or brighten a voice for sparkle.",
                (presence + air) * 100.0
            ),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(fs: &[Finding], code: &str) -> usize {
        fs.iter().filter(|f| f.code == code).count()
    }

    #[test]
    fn buried_vocal_is_flagged() {
        // The session case: a moderate mid vocal (choir) under strings + trumpet
        // crowding the same mid band. The low end is filtered down so the ONLY
        // contested band is the mid — the vocal is the clear masking victim.
        let doc = r#"stack(
          note("a1*4").s("sine").gain(0.7),
          note("a2 e2").s("sawtooth").lpf(300).gain(0.6),
          note("<[c4,e4,g4]>").s("wt_strings").gain(0.8),
          note("a4 c5 e5").s("wt_trumpet").gain(0.78),
          note("<e4 g4>").s("wt_choir").lpf(4200).gain(0.5)
        )"#;
        let fs = spectral_findings(&crate::Evaluated::new(doc, 2).unwrap(), 2);
        assert!(
            codes(&fs, "masking") >= 1,
            "expected a masking note, got: {fs:?}"
        );
        assert!(
            fs.iter()
                .any(|f| f.code == "masking" && f.message.contains("wt_choir")),
            "the masked voice should be the choir/vocal: {fs:?}"
        );
    }

    #[test]
    fn well_separated_mix_is_clean() {
        // Kick in sub/bass, bass in bass, lead up high, hats in air — each voice
        // owns its band, no masking.
        let doc = r#"stack(
          s("bd*4").gain(0.9),
          note("a1 a1 e1 a1").s("sine").gain(0.6),
          s("hh*8").gain(0.3),
          note("a5 c6 e6 c6").s("triangle").gain(0.4)
        )"#;
        let fs = spectral_findings(&crate::Evaluated::new(doc, 2).unwrap(), 2);
        assert_eq!(
            codes(&fs, "masking"),
            0,
            "clean mix should not flag masking: {fs:?}"
        );
    }

    #[test]
    fn single_voice_has_no_masking() {
        let fs = spectral_findings(
            &crate::Evaluated::new(r#"s("bd*4").gain(0.9)"#, 2).unwrap(),
            2,
        );
        assert_eq!(codes(&fs, "masking"), 0);
    }

    #[test]
    fn dark_mix_with_no_top_end_is_flagged_dull() {
        // Kick + low pads/bass, no hats or bright voices — nothing above ~2.5 kHz.
        let doc = r#"stack(
          s("bd*4").gain(0.8),
          note("c2 eb2 g2").s("sawtooth").lpf(500).gain(0.7),
          note("<[c3,eb3,g3]>").s("wt_pad").lpf(600).gain(0.6)
        )"#;
        let fs = spectral_findings(&crate::Evaluated::new(doc, 2).unwrap(), 2);
        assert_eq!(
            codes(&fs, "dull"),
            1,
            "dark hat-less mix should be dull: {fs:?}"
        );
    }

    #[test]
    fn mix_with_hats_is_not_dull() {
        // Same low end, but with hats providing air — must NOT flag dull.
        let doc = r#"stack(
          s("bd*4").gain(0.8),
          note("c2 eb2 g2").s("sawtooth").lpf(500).gain(0.7),
          s("hh*8").gain(0.3)
        )"#;
        let fs = spectral_findings(&crate::Evaluated::new(doc, 2).unwrap(), 2);
        assert_eq!(
            codes(&fs, "dull"),
            0,
            "a mix with hats has air, not dull: {fs:?}"
        );
    }
}
