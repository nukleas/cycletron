//! Performance export: a `.strudel` song → `mix.wav` + `performance.json`, the
//! handoff a video renderer (`ui/scripts/render-viz.mjs`) choreographs against.
//! The JSON carries the song's code, every onset on the audio's exact clock,
//! and its named sections, so visuals key to musical events the way
//! narration-driven films key to words. A song without a `pickRestart` form is
//! one section, `song`.
//!
//! Usage:
//!     performance-export song.strudel <out-dir> [--passes N] [--seconds N] [--samples strudel.json]
//!
//! --passes N    times through the pickRestart form (default 1); the sections
//!               list the first pass
//! --seconds N   window to render and digest (default: `--passes` times the
//!               form, else 32 cycles)
//! --samples P   sample manifest (default: the repo's bundled Cycletron set)

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cycletron_analysis::{Evaluated, LabeledSection, MAX_ANALYSIS_CYCLES, pickrestart_sections};
use cycletron_core::text::frontmatter;
use cycletron_render::{SampleSetPaths, mix_of, render_pcm, resolve_patterns, resolve_tempo};
use serde::Serialize;

const DEFAULT_CYCLES: usize = 32;
/// Live playback pins the engine's master gain at unity (`audio-manager.ts`),
/// and the visualizers are tuned against what that analyser hears.
const LIVE_MASTER_GAIN: f32 = 1.0;
const NANOS: f64 = 1e9;

#[derive(Serialize)]
struct Performance {
    title: String,
    /// The song's code, frontmatter stripped: exactly what the mix renders.
    code: String,
    bpm: f64,
    cycle_ns: u64,
    duration_ns: u64,
    /// The mix, relative to this file.
    audio: String,
    sections: Vec<Section>,
    events: Vec<Event>,
}

#[derive(Serialize)]
struct Section {
    label: String,
    start_ns: u64,
    end_ns: u64,
}

#[derive(Serialize)]
struct Event {
    at_ns: u64,
    duration_ns: u64,
    cycle: usize,
    sound: Option<String>,
    note: Option<String>,
    midi: Option<i32>,
    gain: Option<f64>,
    pan: Option<f64>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("performance-export: {e}");
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<(), String> {
    let mut seconds: Option<f64> = None;
    let mut passes: usize = 1;
    let mut samples: Option<PathBuf> = None;
    let mut positional: Vec<PathBuf> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => {
                seconds = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .filter(|s: &f64| *s > 0.0)
                        .ok_or("--seconds needs a positive number")?,
                );
            }
            "--passes" => {
                passes = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n: &usize| *n > 0)
                    .ok_or("--passes needs a positive whole number")?;
            }
            "--samples" => samples = Some(args.next().ok_or("--samples needs a path")?.into()),
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ => positional.push(arg.into()),
        }
    }
    let [song, out_dir] = positional.as_slice() else {
        return Err(
            "usage: performance-export <song.strudel> <out-dir> [--passes N] [--seconds N] [--samples P]"
                .into(),
        );
    };

    let text =
        std::fs::read_to_string(song).map_err(|e| format!("read {}: {e}", song.display()))?;
    let (yaml, code) = frontmatter::split(&text);
    let fm = yaml.map(frontmatter::parse);
    let title = fm
        .as_ref()
        .and_then(|fm| fm.scalar("name"))
        .unwrap_or_else(|| {
            song.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });

    let (patterns, tempo) = resolve_patterns(code, false)?;
    // As the app does: `setbpm` in the code, else the frontmatter's `bpm:`.
    let fm_bpm = fm
        .as_ref()
        .and_then(|fm| fm.scalar("bpm"))
        .and_then(|b| b.parse().ok());
    let bpm = resolve_tempo(tempo, fm_bpm);
    let cycle_secs = 240.0 / bpm;
    let form = pickrestart_sections(code);
    let seconds = seconds.unwrap_or_else(|| {
        let cycles = form
            .as_ref()
            .and_then(|f| f.last())
            .map_or(DEFAULT_CYCLES, |s| (s.end_cycle() + 1) * passes);
        cycles as f64 * cycle_secs
    });
    let cycles = (seconds / cycle_secs).ceil() as usize;
    if cycles > MAX_ANALYSIS_CYCLES {
        return Err(format!(
            "{seconds:.0}s is {cycles} cycles; events are digested for at most {MAX_ANALYSIS_CYCLES} (use --seconds)"
        ));
    }
    let duration_ns = (seconds * NANOS).round() as u64;
    let to_ns = |cycles: f64| (cycles * cycle_secs * NANOS).round() as u64;

    let events: Vec<Event> = Evaluated::new(code, cycles)?
        .into_digest()
        .cycles
        .into_iter()
        .flat_map(|c| {
            c.events.into_iter().map(move |e| Event {
                at_ns: to_ns(c.cycle as f64 + e.begin),
                duration_ns: to_ns(e.duration),
                cycle: c.cycle,
                sound: e.sound,
                note: e.note,
                midi: e.midi,
                gain: e.gain,
                pan: e.pan,
            })
        })
        .filter(|e| e.at_ns < duration_ns)
        .collect();

    let form = form.unwrap_or_else(|| {
        vec![LabeledSection {
            label: "song".into(),
            start_cycle: 0,
            cycles,
        }]
    });
    let sections = form
        .into_iter()
        .map(
            |LabeledSection {
                 label,
                 start_cycle,
                 cycles,
             }| Section {
                label,
                start_ns: to_ns(start_cycle as f64),
                end_ns: to_ns((start_cycle + cycles) as f64).min(duration_ns),
            },
        )
        .filter(|s| s.start_ns < duration_ns)
        .collect();

    let samples = SampleSetPaths::Cycletron {
        manifest: samples.unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/public/cycletron.strudel.json")
        }),
    };
    let pcm = render_pcm(&mix_of(&patterns), bpm, LIVE_MASTER_GAIN, seconds, &samples)?;

    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {}: {e}", out_dir.display()))?;
    pcm.write_wav(&out_dir.join("mix.wav"))?;

    let performance = Performance {
        title,
        code: code.to_string(),
        bpm,
        cycle_ns: to_ns(1.0),
        duration_ns,
        audio: "mix.wav".into(),
        sections,
        events,
    };
    let json = serde_json::to_string_pretty(&performance).map_err(|e| e.to_string())?;
    let json_path = out_dir.join("performance.json");
    std::fs::write(&json_path, json).map_err(|e| format!("write {}: {e}", json_path.display()))?;

    println!(
        "{}: {:.1}s at {bpm} bpm, {} events, {} sections, {} clipped samples → {}",
        performance.title,
        seconds,
        performance.events.len(),
        performance.sections.len(),
        pcm.clipped,
        out_dir.display()
    );
    Ok(())
}
