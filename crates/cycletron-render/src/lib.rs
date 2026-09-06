//! Offline rendering of strudel patterns through the engine's
//! `OfflineRenderer` — the one path that turns code into samples without a
//! sound card. `export_audio` (WAV / MP3 / stems) and the agent's
//! `hear_pattern` (render, then measure) both build on it.
//!
//! - [`SampleSetPaths`] — which sample manifests a render resolves sounds from.
//! - [`resolve_patterns`] — code → the mix and, optionally, its stems.
//! - [`render_pcm`] — one pattern → stereo `f32` PCM.
//! - [`hear`] — render the mix and stems, measure them, compare with the
//!   symbolic spectral estimate.

pub mod hear;

use rustc_hash::FxHashMap;
use std::path::PathBuf;
use strudel_audio::OfflineRenderer;
use strudel_core::Pattern;
use strudel_dsl::{
    Directive, EvalContext, Expr, Tempo, evaluate_in_context, evaluate_in_context_with_tempo,
    execute, parse as parse_expr, parse_strudel_file,
};

pub use hear::{HearOptions, HearReport, StemReport, hear, report_to_text};

pub const SAMPLE_RATE: u32 = 44_100;
pub const DEFAULT_BPM: f64 = 120.0;
pub const DEFAULT_GAIN: f32 = 0.7;

/// Which sample set an offline render resolves sounds from.
///
/// Mirrors the user's sample-set mode: live playback and offline renders must
/// consume the same manifests for the active mode, or the two drift audibly
/// apart (the original bug: live played the bundled TR-808 `bd` while export
/// fetched uzu-drumkit's).
#[derive(Debug, Clone)]
pub enum SampleSetPaths {
    /// The bundled Cycletron set: one manifest (`cycletron.strudel.json`,
    /// generated from `ui/sample-tables.ts`) describing the shipped files.
    Cycletron { manifest: PathBuf },
    /// The downloaded strudel-rs set: localized manifests registered in
    /// strudio order (piano, uzu-drumkit, uzu-wavetables, dirt-samples) so
    /// first-manifest-wins resolves identically to `strudio render`.
    Strudel { manifests: Vec<PathBuf> },
}

/// Rendered stereo audio.
#[derive(Debug, Clone)]
pub struct Pcm {
    pub sample_rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Samples whose magnitude exceeded 1.0 (either channel).
    pub clipped: u64,
}

impl Pcm {
    /// `(l + r) / 2` — what the spectrum is measured on.
    pub fn mono(&self) -> Vec<f32> {
        self.left
            .iter()
            .zip(&self.right)
            .map(|(l, r)| (l + r) * 0.5)
            .collect()
    }
}

/// Render `duration_secs` of `pattern` at `bpm`. One `OfflineRenderer` per
/// call: the renderer is single-use (it never rewinds its frame counter).
pub fn render_pcm(
    pattern: &Pattern,
    bpm: f64,
    gain: f32,
    duration_secs: f64,
    samples: &SampleSetPaths,
) -> Result<Pcm, String> {
    let mut renderer = OfflineRenderer::new(bpm, SAMPLE_RATE, gain);
    register_sample_manifests(&mut renderer, samples);
    renderer.set_pattern(pattern.clone());

    let frames = (duration_secs * f64::from(SAMPLE_RATE)).round() as usize;
    let mut pcm = Pcm {
        sample_rate: SAMPLE_RATE,
        left: Vec::with_capacity(frames),
        right: Vec::with_capacity(frames),
        clipped: 0,
    };
    renderer
        .render(duration_secs, |left, right| {
            for (&l, &r) in left.iter().zip(right.iter()) {
                if l.abs() > 1.0 || r.abs() > 1.0 {
                    pcm.clipped += 1;
                }
                pcm.left.push(l);
                pcm.right.push(r);
            }
        })
        .map_err(|e| format!("Render failed: {e}"))?;
    Ok(pcm)
}

/// The file's own tempo, else the caller's, else [`DEFAULT_BPM`].
pub fn resolve_tempo(file_tempo: Option<Tempo>, bpm: Option<f64>) -> f64 {
    file_tempo
        .map(|t| t.to_bpm())
        .or(bpm)
        .filter(|b| b.is_finite() && *b > 0.0)
        .unwrap_or(DEFAULT_BPM)
}

pub fn resolve_gain(gain: Option<f32>) -> f32 {
    gain.filter(|g| g.is_finite() && *g > 0.0)
        .unwrap_or(DEFAULT_GAIN)
        .clamp(0.01, 2.0)
}

/// Named patterns plus the tempo the file set, if any.
pub type NamedPatterns = (Vec<(String, Pattern)>, Option<Tempo>);

/// Resolve the mix and optional stem patterns from source code.
///
/// Stem split priority:
/// 1. Multiple `$:` tracks (named by id, comment, or index)
/// 2. Top-level `stack(a, b, …)` arguments
/// 3. Single layer (full mix)
pub fn resolve_patterns(code: &str, want_stems: bool) -> Result<NamedPatterns, String> {
    // Multi-track file path
    if let Ok(file) = parse_strudel_file(code)
        && !file.is_empty()
    {
        let mut tempo: Option<Tempo> = None;
        for directive in file.directives.iter() {
            match *directive {
                Directive::SetCpm(cpm) => tempo = Some(Tempo::from_cpm(cpm)),
                Directive::SetBpm(bpm) => tempo = Some(Tempo::from_bpm(bpm)),
            }
        }

        let mut context = EvalContext::new();
        for func in &file.functions {
            context.define_function(func.clone());
        }
        for binding in &file.bindings {
            // Binding parse-error offsets are relative to the binding text.
            let expr = parse_expr(binding.expr_str)
                .map_err(|e| format!("Parse error in binding '{}': {e}", binding.name))?;
            // Mirror evaluate_file: object literals become object bindings.
            if let Expr::Object {
                entries, spreads, ..
            } = &expr
            {
                let mut obj = FxHashMap::default();
                for spread in spreads {
                    if let Expr::Call { name, args, .. } = spread
                        && args.is_empty()
                    {
                        let Some(spread_obj) = context.get_object(name) else {
                            return Err(format!(
                                "Spread variable '{name}' not found or is not an object"
                            ));
                        };
                        for (key, value) in spread_obj {
                            obj.insert(*key, value.clone());
                        }
                    } else {
                        return Err("Object spreads must be bare object identifiers".into());
                    }
                }
                for (key, value_expr) in entries {
                    let value_pattern = evaluate_in_context(value_expr, &context)
                        .map_err(|e| format!("Eval error in object field '{key}': {e}"))?;
                    obj.insert(*key, value_pattern);
                }
                context.bind_object(binding.name, obj);
            } else {
                let pattern = evaluate_in_context(&expr, &context)
                    .map_err(|e| format!("Eval error in binding '{}': {e}", binding.name))?;
                context.bind(binding.name, pattern);
            }
        }

        let mut stems = Vec::new();
        for (i, track) in file.tracks.iter().enumerate() {
            let result = evaluate_in_context_with_tempo(&track.expression, &context)
                .map_err(|e| format!("Eval error in track {}: {e}", i + 1))?;
            if let Some(t) = result.tempo {
                tempo = Some(t);
            }
            let name = track_stem_name(track.id, track.comment, i);
            stems.push((name, result.pattern));
        }

        if stems.is_empty() {
            return Err("File contains no tracks".into());
        }

        // Single track: try to peel top-level stack for stem split.
        if want_stems
            && stems.len() == 1
            && let Some(split) = try_split_stack_expr(&file.tracks[0].expression, &context)
        {
            return Ok((split, tempo));
        }

        return Ok((stems, tempo));
    }

    // Single expression / mini
    let evaluated = execute(code).map_err(|e| format!("Could not parse pattern: {e}"))?;

    if want_stems
        && let Ok(expr) = parse_expr(code.trim())
        && let Some(split) = try_split_stack_expr(&expr, &EvalContext::new())
    {
        return Ok((split, evaluated.tempo));
    }

    Ok((vec![("mix".into(), evaluated.pattern)], evaluated.tempo))
}

/// The mixdown of a stem set: the single pattern, or all of them stacked.
pub fn mix_of(stems: &[(String, Pattern)]) -> Pattern {
    if stems.len() == 1 {
        stems[0].1.clone()
    } else {
        strudel_core::stack(stems.iter().map(|(_, p)| p.clone()).collect())
    }
}

fn track_stem_name(id: &str, comment: Option<&str>, index: usize) -> String {
    if !id.is_empty() {
        return id.to_string();
    }
    if let Some(c) = comment {
        let cleaned = c
            .trim()
            .trim_start_matches('/')
            .trim()
            .trim_start_matches("Track")
            .trim_start_matches(char::is_numeric)
            .trim_start_matches([':', '-', ' '])
            .trim();
        if !cleaned.is_empty() {
            return cleaned.to_string();
        }
    }
    format!("stem-{}", index + 1)
}

/// If `expr` is `stack(a, b, …)`, evaluate each arg as its own stem.
fn try_split_stack_expr(expr: &Expr, ctx: &EvalContext<'_>) -> Option<Vec<(String, Pattern)>> {
    let Expr::Call { name, args, .. } = expr else {
        return None;
    };
    if *name != "stack" || args.len() < 2 {
        return None;
    }
    let mut out = Vec::with_capacity(args.len());
    for (i, arg) in args.iter().enumerate() {
        let pattern = evaluate_in_context(arg, ctx).ok()?;
        let label = stack_arg_label(arg, i);
        out.push((label, pattern));
    }
    Some(out)
}

fn stack_arg_label(expr: &Expr, index: usize) -> String {
    match expr {
        Expr::Call { name, .. } if !name.is_empty() => format!("{name}-{}", index + 1),
        Expr::MethodCall { method, .. } if !method.is_empty() => {
            format!("{method}-{}", index + 1)
        }
        _ => format!("layer-{}", index + 1),
    }
}

/// Register the set's manifests on a renderer, in precedence order.
fn register_sample_manifests(renderer: &mut OfflineRenderer, samples: &SampleSetPaths) {
    let mut urls: Vec<String> = Vec::new();
    // Explicit dev/test override: a strudel.json (or a dir containing one)
    // registered ahead of the mode's manifests, so it wins name collisions.
    if let Some(over) = env_override_manifest() {
        urls.push(over.to_string_lossy().into_owned());
    }
    match samples {
        SampleSetPaths::Cycletron { manifest } => {
            urls.push(manifest.to_string_lossy().into_owned());
        }
        SampleSetPaths::Strudel { manifests } => {
            urls.extend(manifests.iter().map(|m| m.to_string_lossy().into_owned()));
        }
    }

    for url in &urls {
        if let Err(e) = renderer.register_manifest_url(url) {
            tracing::warn!(
                target: "cycletron::render",
                url,
                error = %e,
                "sample manifest skipped"
            );
        }
    }
}

/// `CYCLETRON_SAMPLES`: a strudel.json (or a directory holding one) that wins
/// over the set's manifests — for dev and tests.
fn env_override_manifest() -> Option<PathBuf> {
    let env = std::env::var("CYCLETRON_SAMPLES").ok()?;
    let p = PathBuf::from(env);
    if p.is_file() {
        return Some(p);
    }
    let joined = p.join("strudel.json");
    joined.is_file().then_some(joined)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::SampleSetPaths;
    use std::path::Path;

    /// The repo's generated bundled-set manifest (what the packaged app
    /// resolves from its resource dir); resolves to local files under
    /// `ui/public/`, so these tests run offline.
    pub fn cycletron_set() -> SampleSetPaths {
        SampleSetPaths::Cycletron {
            manifest: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../ui/public/cycletron.strudel.json"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_pcm_bd_from_bundled_manifest_is_audible() {
        let (stems, tempo) = resolve_patterns(r#"s("bd*4")"#, false).unwrap();
        let pcm = render_pcm(
            &mix_of(&stems),
            resolve_tempo(tempo, Some(120.0)),
            0.7,
            1.0,
            &test_support::cycletron_set(),
        )
        .expect("render");
        assert_eq!(pcm.left.len(), SAMPLE_RATE as usize);
        assert_eq!(pcm.left.len(), pcm.right.len());
        let peak = pcm.mono().iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.03, "expected audible bd, peak={peak}");
        assert_eq!(pcm.clipped, 0);
    }

    #[test]
    fn stems_split_tracks_and_stacks() {
        let (stems, tempo) = resolve_patterns(
            "setbpm(140)\n// Kick\n$: s(\"bd*4\")\n// Hats\n$: s(\"hh*8\")\n",
            true,
        )
        .unwrap();
        assert_eq!(stems.len(), 2);
        assert_eq!(stems[0].0, "Kick");
        assert_eq!(stems[1].0, "Hats");
        assert!((resolve_tempo(tempo, None) - 140.0).abs() < 1e-9);

        let (stems, _) =
            resolve_patterns(r#"stack(s("bd*4"), note("c3").s("sine"))"#, true).unwrap();
        assert_eq!(stems.len(), 2);
        let (stems, _) =
            resolve_patterns(r#"stack(s("bd*4"), note("c3").s("sine"))"#, false).unwrap();
        assert_eq!(stems.len(), 1, "no split when stems are not wanted");
    }
}
