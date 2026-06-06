//! `gen-pattern` — thin CLI over the `robostrudel-gen` corpus generators.
//!
//! The generative logic lives in the `robostrudel-gen` library so the agent's
//! `generate_pattern` tool and this CLI share one implementation. This binary
//! just parses flags, calls a generator, and writes/prints the `.strudel`
//! document. Gate output with `cargo run -p corpus-check`.
//!
//! Usage:
//!     gen-pattern infinity   [--count 16] [--root 60]
//!     gen-pattern hexbeat    [--hex a4f2]
//!     gen-pattern numerals   [--key C] [--numerals "ii V I vi"]
//!     gen-pattern palindrome [--motif "c4 e4 g4 b4"]
//!     gen-pattern automaton  [--rule 90] [--width 8] [--gens 4]
//!     ... any generator also takes [--out path/to/file.strudel]

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let generator = args.first().map(String::as_str).unwrap_or("");

    let flag = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let out = flag("--out").map(PathBuf::from);

    let result: Result<String, String> = match generator {
        "infinity" => {
            let count = flag("--count").and_then(|s| s.parse().ok()).unwrap_or(16);
            let root = flag("--root").and_then(|s| s.parse().ok()).unwrap_or(60);
            Ok(robostrudel_gen::infinity(count, root))
        }
        "hexbeat" => {
            let hex = flag("--hex").unwrap_or_else(|| "a4f2".to_string());
            robostrudel_gen::hexbeat(&hex)
        }
        "numerals" => {
            let key = flag("--key").unwrap_or_else(|| "C".to_string());
            let numerals = flag("--numerals").unwrap_or_else(|| "ii V I vi".to_string());
            robostrudel_gen::numerals(&key, &numerals)
        }
        "palindrome" => {
            let motif = flag("--motif").unwrap_or_else(|| "c4 e4 g4 b4".to_string());
            Ok(robostrudel_gen::palindrome(&motif))
        }
        "automaton" => {
            let rule = flag("--rule").and_then(|s| s.parse().ok()).unwrap_or(90u8);
            let width = flag("--width").and_then(|s| s.parse().ok()).unwrap_or(8usize);
            let gens = flag("--gens").and_then(|s| s.parse().ok()).unwrap_or(4usize);
            robostrudel_gen::automaton(rule, width, gens)
        }
        other => Err(format!(
            "unknown generator {other:?}; supported: infinity hexbeat numerals palindrome automaton"
        )),
    };

    let file = match result {
        Ok(f) => f,
        Err(e) => {
            eprintln!("gen-pattern: {e}");
            return ExitCode::from(2);
        }
    };

    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, &file) {
                eprintln!("gen-pattern: failed to write {}: {e}", path.display());
                return ExitCode::from(2);
            }
            println!("wrote {}", path.display());
            println!("validate: cargo run -p corpus-check -- {}", path.display());
        }
        None => print!("{file}"),
    }
    ExitCode::SUCCESS
}
