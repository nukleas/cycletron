//! Measured spectrum — the FFT counterpart of the symbolic model in
//! [`crate::spectral`]. Pure DSP over a mono `f32` buffer, no engine: energy
//! share per band (the same six [`BANDS`]), spectral centroid, and loudness
//! (rms / peak / crest). `hear_pattern` runs this over the offline render and
//! prints it next to [`crate::spectral::predicted_bands`].

use crate::spectral::{BANDS, NB, band_of};
use rustfft::{FftPlanner, num_complex::Complex};
use serde::Serialize;

/// Analysis frame (Hann window) and hop — 4096 / 50 % at 44.1 kHz gives ~10 Hz
/// bins, fine enough to place the sub/bass split at 60 Hz.
pub const FRAME: usize = 4096;
pub const HOP: usize = FRAME / 2;

/// Below this the buffer is treated as digital silence (no spectrum reported).
pub const SILENCE_DBFS: f64 = -70.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Measured {
    /// Energy share per band (sums to 1; all zero when silent).
    pub bands: [f64; NB],
    /// Power-weighted mean frequency — brightness. 0 when silent.
    pub centroid_hz: f64,
    pub rms_db: f64,
    pub peak_db: f64,
    /// `peak_db - rms_db`: high for punchy/transient material, low for dense.
    pub crest_db: f64,
    /// rms below [`SILENCE_DBFS`].
    pub silent: bool,
}

/// Measure `mono` at `sample_rate`. Empty input is silent.
pub fn measure(mono: &[f32], sample_rate: u32) -> Measured {
    let (rms, peak) = loudness(mono);
    let rms_db = db(rms);
    let peak_db = db(peak);
    let silent = rms_db < SILENCE_DBFS;
    if silent {
        return Measured {
            bands: [0.0; NB],
            centroid_hz: 0.0,
            rms_db,
            peak_db,
            crest_db: peak_db - rms_db,
            silent,
        };
    }

    let fft = FftPlanner::<f32>::new().plan_fft_forward(FRAME);
    let window: Vec<f32> = (0..FRAME)
        .map(|n| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / (FRAME as f32 - 1.0)).cos()))
        .collect();
    let bin_hz = f64::from(sample_rate) / FRAME as f64;

    let mut bands = [0.0f64; NB];
    let mut weighted_hz = 0.0f64;
    let mut power = 0.0f64;
    let mut buf = vec![Complex::new(0.0f32, 0.0); FRAME];
    let mut scratch = vec![Complex::new(0.0f32, 0.0); fft.get_inplace_scratch_len()];

    // A short buffer is zero-padded to one frame; longer ones slide by HOP.
    let mut start = 0usize;
    loop {
        for (i, slot) in buf.iter_mut().enumerate() {
            let s = mono.get(start + i).copied().unwrap_or(0.0);
            *slot = Complex::new(s * window[i], 0.0);
        }
        fft.process_with_scratch(&mut buf, &mut scratch);
        // Bins 1..N/2: skip DC, ignore the mirrored half.
        for (k, x) in buf.iter().enumerate().take(FRAME / 2).skip(1) {
            let p = f64::from(x.norm_sqr());
            let hz = k as f64 * bin_hz;
            bands[band_of(hz)] += p;
            weighted_hz += hz * p;
            power += p;
        }
        start += HOP;
        if start + HOP >= mono.len() {
            break;
        }
    }

    if power > 0.0 {
        for b in &mut bands {
            *b /= power;
        }
    }
    Measured {
        bands,
        centroid_hz: if power > 0.0 {
            weighted_hz / power
        } else {
            0.0
        },
        rms_db,
        peak_db,
        crest_db: peak_db - rms_db,
        silent,
    }
}

/// `(rms, peak)` as linear amplitudes.
fn loudness(mono: &[f32]) -> (f64, f64) {
    if mono.is_empty() {
        return (0.0, 0.0);
    }
    let mut sq = 0.0f64;
    let mut peak = 0.0f64;
    for &s in mono {
        let s = f64::from(s);
        sq += s * s;
        peak = peak.max(s.abs());
    }
    ((sq / mono.len() as f64).sqrt(), peak)
}

/// Linear amplitude → dBFS; digital silence reads as -inf clamped to -120.
pub fn db(amp: f64) -> f64 {
    if amp <= 0.0 {
        -120.0
    } else {
        (20.0 * amp.log10()).max(-120.0)
    }
}

/// The band name for a share vector's largest entry.
pub fn dominant_band(bands: &[f64; NB]) -> &'static str {
    let i = (0..NB)
        .max_by(|&a, &b| bands[a].total_cmp(&bands[b]))
        .unwrap_or(0);
    BANDS[i].0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    fn sine(hz: f32, secs: f32) -> Vec<f32> {
        let n = (secs * SR as f32) as usize;
        (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * hz * i as f32 / SR as f32).sin())
            .collect()
    }

    #[test]
    fn a_100hz_sine_is_bass() {
        let m = measure(&sine(100.0, 1.0), SR);
        assert!(!m.silent);
        assert_eq!(dominant_band(&m.bands), "bass", "{:?}", m.bands);
        assert!(m.bands[1] > 0.9, "{:?}", m.bands);
        assert!((m.centroid_hz - 100.0).abs() < 15.0, "{}", m.centroid_hz);
        // 0.5 amplitude sine: peak -6 dB, rms -9 dB, crest ~3 dB.
        assert!((m.peak_db + 6.0).abs() < 0.2, "{}", m.peak_db);
        assert!((m.crest_db - 3.0).abs() < 0.2, "{}", m.crest_db);
    }

    #[test]
    fn a_5khz_sine_is_presence() {
        let m = measure(&sine(5000.0, 0.5), SR);
        assert_eq!(dominant_band(&m.bands), "presence", "{:?}", m.bands);
    }

    #[test]
    fn white_noise_energy_follows_bandwidth() {
        // Flat power per Hz: the widest band (air, 6–20 kHz) carries the most.
        let mut x: u32 = 0x9E37_79B9;
        let noise: Vec<f32> = (0..SR as usize)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32) - 0.5
            })
            .collect();
        let m = measure(&noise, SR);
        assert_eq!(dominant_band(&m.bands), "air", "{:?}", m.bands);
        assert!(
            m.bands[4] > m.bands[3] && m.bands[3] > m.bands[2],
            "{:?}",
            m.bands
        );
        assert!(m.centroid_hz > 8000.0, "{}", m.centroid_hz);
    }

    #[test]
    fn silence_is_silent_and_short_buffers_measure() {
        let m = measure(&vec![0.0; 10_000], SR);
        assert!(m.silent);
        assert_eq!(m.bands, [0.0; NB]);
        assert!(measure(&[], SR).silent);
        // Shorter than one frame: zero-padded, still classified.
        let m = measure(&sine(200.0, 0.02), SR);
        assert!(!m.silent);
        assert_eq!(dominant_band(&m.bands), "bass");
    }

    #[test]
    fn measured_and_predicted_agree_on_a_pure_sine() {
        // The symbolic model says a sine at a2 (110 Hz) is all bass; the FFT of
        // the same sine must land in the same band — the two sides of
        // `hear_pattern` are comparable band for band.
        let pred = crate::spectral::predicted_bands(
            &crate::Evaluated::new(r#"note("a2").s("sine")"#, 1)
                .unwrap()
                .cycle_haps()
                .concat(),
        )
        .unwrap();
        let meas = measure(&sine(110.0, 0.5), SR);
        assert_eq!(dominant_band(&pred), "bass", "{pred:?}");
        assert_eq!(dominant_band(&meas.bands), "bass", "{:?}", meas.bands);
    }
}
