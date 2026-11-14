//! `cycletron <command>`: the app binary as a command line tool. A command
//! runs before Tauri starts, needs no display, and exits when done. Anything
//! else launches the app as usual: file paths to open, and the transport
//! verbs a running instance picks up (`play`, `pause`, `stop`, `tempo`; see
//! `commands::handle_second_instance`).
//!
//!   cycletron render <show.toml> [flags]
//!   cycletron export <song.strudel> [out-dir] [--passes N] [--seconds N] [--samples manifest.json]
//!   cycletron check <song.strudel>... [--cycles N] [--strict]
//!   cycletron help
//!
//! Exit codes: 0 done, 1 the command failed (for `check`: a file is invalid,
//! or warned under --strict), 2 usage error.

use std::path::{Path, PathBuf};

use cycletron_analysis as analysis;
use cycletron_render::{SampleSetPaths, performance};

const USAGE: &str = "\
usage: cycletron render <show.toml> [--out video.mp4] [--song n] [--section label] [--from s] [--to s]
                        [--size WxH] [--fps n] [--quality q] [--jobs n] [--fresh] [--preview]
                        [--progress json]
       cycletron export <song.strudel> [out-dir] [--passes N] [--seconds N] [--samples manifest.json]
       cycletron check <song.strudel>... [--cycles N] [--strict]
       cycletron help

render   Render a show file to a music video (docs/SHOW_FILES.md). Songs are exported
         first (cached under the user cache dir). On macOS 14+ the render windows stay
         hidden; elsewhere small preview windows show the frames and must stay on screen.
         Needs ffmpeg (on the PATH, a usual install location, or FFMPEG_PATH).
         --song n       only the nth song (from 1); --section label  only that section
         --from/--to s  trim, in seconds of what's rendered
         --size/--fps   override the show's; --out overrides its `out`
         --quality q    standard (default, ~90 MB/min at 1080p60), small (~45) or master (~200)
         --jobs n       windows rendering at once (default: cores less two, up to 8, as memory allows)
         --fresh        re-export the songs even when the cached exports are current
         --preview      show the render windows where they'd otherwise be hidden
         --progress json  one JSON event per line on stdout instead of text on stderr

export   Render the song to <out-dir>/mix.wav and write performance.json beside it
         (its code, sections and every onset on the audio's clock) for the video
         renderer. <out-dir> defaults to <song>.performance next to the song.
         --passes N    times through the pickRestart form (default 1)
         --seconds N   window to render (default: the passes, else 32 cycles)
         --samples P   sample manifest (default: the bundled Cycletron set)
check    Review songs the way the AI's review_pattern does: validate, digest,
         silence lint, mix critique, and the form map for multi-section songs.
         --cycles N    analysis window in cycles (default 64)
         --strict      treat warnings as failures

With no command, cycletron opens the app. A running instance also takes
play, pause, toggle, stop (or hush), tempo <bpm>, tempo-nudge <delta> and files to open.";

pub enum Command {
    Export {
        song: PathBuf,
        out_dir: Option<PathBuf>,
        opts: performance::Options,
        samples: Option<PathBuf>,
    },
    Check {
        files: Vec<PathBuf>,
        cycles: usize,
        strict: bool,
    },
    Help,
    Render(crate::render::Flags),
}

/// `Some` when `args` (the process's, program name first) name a command;
/// `None` means launch the app.
pub fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let verb = args.get(1)?.as_str();
    let rest = &args[2..];
    match verb {
        "export" => Some(parse_export(rest)),
        "check" => Some(parse_check(rest)),
        "help" | "--help" | "-h" => Some(Ok(Command::Help)),
        "render" => Some(crate::render::parse(rest).map(Command::Render)),
        _ => None,
    }
}

fn parse_export(args: &[String]) -> Result<Command, String> {
    let mut opts = performance::Options::default();
    let mut samples = None;
    let mut positional: Vec<PathBuf> = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--passes" => {
                opts.passes = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n: &usize| *n > 0)
                    .ok_or("--passes needs a positive whole number")?;
            }
            "--seconds" => {
                opts.seconds = Some(
                    it.next()
                        .and_then(|v| v.parse().ok())
                        .filter(|s: &f64| *s > 0.0)
                        .ok_or("--seconds needs a positive number")?,
                );
            }
            "--samples" => samples = Some(it.next().ok_or("--samples needs a path")?.into()),
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ => positional.push(arg.into()),
        }
    }
    let mut positional = positional.into_iter();
    let song = positional.next().ok_or("export: which song?")?;
    let out_dir = positional.next();
    if positional.next().is_some() {
        return Err("export takes one song and one output directory".into());
    }
    Ok(Command::Export {
        song,
        out_dir,
        opts,
        samples,
    })
}

fn parse_check(args: &[String]) -> Result<Command, String> {
    let mut cycles = 64;
    let mut strict = false;
    let mut files = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--cycles" => {
                cycles = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n: &usize| *n > 0)
                    .ok_or("--cycles needs a positive whole number")?;
            }
            "--strict" => strict = true,
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ => files.push(arg.into()),
        }
    }
    if files.is_empty() {
        return Err("check: which songs?".into());
    }
    Ok(Command::Check {
        files,
        cycles,
        strict,
    })
}

pub fn run(parsed: Result<Command, String>, context: tauri::Context<tauri::Wry>) -> u8 {
    let package = context.package_info().clone();
    let package = &package;
    let command = match parsed {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cycletron: {e}\n{USAGE}");
            return 2;
        }
    };
    match command {
        Command::Render(flags) => crate::render::run(flags, context),
        Command::Help => {
            println!("cycletron {}\n{USAGE}", package.version);
            0
        }
        Command::Export {
            song,
            out_dir,
            opts,
            samples,
        } => match export(&song, out_dir, &opts, samples, package) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("cycletron export: {e}");
                1
            }
        },
        Command::Check {
            files,
            cycles,
            strict,
        } => check(&files, cycles, strict),
    }
}

fn export(
    song: &Path,
    out_dir: Option<PathBuf>,
    opts: &performance::Options,
    samples: Option<PathBuf>,
    package: &tauri::PackageInfo,
) -> Result<(), String> {
    let out_dir = out_dir.unwrap_or_else(|| {
        let stem = song.file_stem().unwrap_or_default().to_string_lossy();
        song.with_file_name(format!("{stem}.performance"))
    });
    let manifest = match samples {
        Some(path) => path,
        None => bundled_manifest(package)?,
    };
    let samples = SampleSetPaths::Cycletron {
        manifest,
        packs: Vec::new(),
    };
    let s = performance::export(song, &out_dir, opts, &samples)?;
    println!(
        "{}: {:.1}s at {} bpm, {} events, {} sections, {} clipped samples → {}",
        s.title,
        s.seconds,
        s.bpm,
        s.events,
        s.sections,
        s.clipped,
        s.dir.display()
    );
    Ok(())
}

/// The bundled sample manifest: beside the app's resources when installed,
/// else the checkout's copy for a build run from the repo.
pub(crate) fn bundled_manifest(package: &tauri::PackageInfo) -> Result<PathBuf, String> {
    const NAME: &str = "cycletron.strudel.json";
    let installed = tauri::utils::platform::resource_dir(package, &tauri::Env::default())
        .map(|dir| dir.join(NAME));
    if let Ok(path) = &installed
        && path.is_file()
    {
        return Ok(path.clone());
    }
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/public")
        .join(NAME);
    if checkout.is_file() {
        return Ok(checkout);
    }
    Err(format!(
        "bundled sample manifest not found (looked beside the app's resources and at {}); pass --samples",
        checkout.display()
    ))
}

fn check(files: &[PathBuf], cycles: usize, strict: bool) -> u8 {
    // Known sounds are the built-in set only, so a song on a user sample bank
    // may get an unknown-sound warning. Those stay warnings, never errors.
    let known = analysis::sounds::SoundSet::builtin_only();
    let mut invalid = 0usize;
    let mut warned = 0usize;
    for path in files {
        let code = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("cycletron check: read {}: {e}", path.display());
                return 2;
            }
        };
        println!("== {} ==", path.display());
        match analysis::review_report(&code, cycles, &known) {
            analysis::ReviewOutcome::Invalid(e) => {
                invalid += 1;
                println!("INVALID: {e}\n");
            }
            analysis::ReviewOutcome::Report { text, findings } => {
                let warns = findings.iter().filter(|f| f.severity == "warn").count();
                if warns > 0 {
                    warned += 1;
                    println!("{text}\nVERDICT: {warns} warning(s).\n");
                } else {
                    println!("{text}\nVERDICT: ready to play.\n");
                }
            }
        }
    }
    let clean = files.len() - invalid - warned;
    println!(
        "cycletron check: {clean}/{} clean, {warned} with warnings, {invalid} invalid",
        files.len()
    );
    if invalid > 0 || (strict && warned > 0) {
        1
    } else {
        0
    }
}
