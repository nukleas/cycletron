//! Full-song review CLI: the same combined quality gate the in-app agent's
//! `review_pattern` tool runs (validate → inspect digest → silence lint →
//! mix critique → form map + form critique for multi-section songs), on
//! `.strudel` files from the terminal. Complements `corpus-check`, which is
//! the strict parse/emit gate over the corpus; this one reviews whole songs.
//!
//! Usage:
//!     song-check song.strudel [more.strudel ...] [--cycles N] [--strict]
//!
//! --cycles N   analysis window in cycles (default 64 — full songs; the
//!              in-app default of 8 is for fragments)
//! --strict     treat warnings as failures
//!
//! Exit codes: 0 clean, 1 any file invalid (or warned, under --strict),
//! 2 usage/IO error.
//!
//! Known caveat: the known-sound set is `builtin_sound_set()` only — songs
//! using user-loaded sample banks may get spurious `unknown-sound` warns.
//! Those stay severity "warn", never errors.

use cycletron_analysis as analysis;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut cycles: usize = 64;
    let mut strict = false;
    let mut files: Vec<PathBuf> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cycles" => {
                let Some(n) = args.next().and_then(|v| v.parse().ok()) else {
                    eprintln!("song-check: --cycles needs a positive integer");
                    return ExitCode::from(2);
                };
                cycles = n;
            }
            "--strict" => strict = true,
            "--help" | "-h" => {
                eprintln!("usage: song-check <file.strudel> [...] [--cycles N] [--strict]");
                return ExitCode::from(2);
            }
            _ if arg.starts_with("--") => {
                eprintln!("song-check: unknown flag {arg}");
                return ExitCode::from(2);
            }
            _ => files.push(PathBuf::from(arg)),
        }
    }

    if files.is_empty() {
        eprintln!("usage: song-check <file.strudel> [...] [--cycles N] [--strict]");
        return ExitCode::from(2);
    }

    let known = analysis::sounds::SoundSet::builtin_only();
    let mut invalid = 0usize;
    let mut warned = 0usize;

    for path in &files {
        let code = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("song-check: read {}: {e}", path.display());
                return ExitCode::from(2);
            }
        };
        println!("== {} ==", path.display());
        match review(&code, cycles, &known) {
            Review::Invalid(msg) => {
                invalid += 1;
                println!("INVALID: {msg}\n");
            }
            Review::Done { text, warns } => {
                if warns > 0 {
                    warned += 1;
                }
                println!("{text}\n");
            }
        }
    }

    let clean = files.len() - invalid - warned;
    println!(
        "song-check: {clean}/{} clean, {warned} with warnings, {invalid} invalid",
        files.len()
    );

    if invalid > 0 || (strict && warned > 0) {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

enum Review {
    Invalid(String),
    Done { text: String, warns: usize },
}

/// The shared review pipeline (`cycletron_analysis::review_report`) with
/// song-check's plain VERDICT framing.
fn review(code: &str, cycles: usize, known: &analysis::sounds::SoundSet) -> Review {
    match analysis::review_report(code, cycles, known) {
        analysis::ReviewOutcome::Invalid(e) => Review::Invalid(e),
        analysis::ReviewOutcome::Report { mut text, findings } => {
            let warns = findings.iter().filter(|f| f.severity == "warn").count();
            text.push_str(&if warns == 0 {
                "\nVERDICT: ready to play.".to_string()
            } else {
                format!("\nVERDICT: {warns} warning(s).")
            });
            Review::Done { text, warns }
        }
    }
}
