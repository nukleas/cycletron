//! Search the centralized ingested idiom store (and any `*.index.json` produced
//! by `midi-ingest`) so the `research-genre` skill and the agent can pull real,
//! validated strudel snippets instead of guessing.
//!
//! Metadata filters (artist, BPM) read the index directly; content filters
//! (sound, keyword) read the referenced `.strudel` files. Converted-file paths
//! in an index are resolved relative to that index file's directory.
//!
//! Usage:
//!     strudel-search [--index <path|dir>] [--artist <q>] [--bpm-min N]
//!                    [--bpm-max N] [--sound <name>] [--keyword <q>]
//!                    [--limit N] [--json]
//!
//! Default --index: ../strudel-training/ingested (the ingested store).

use cycletron_midi::index::Index;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Serialize)]
struct Hit {
    dataset: String,
    artist: Option<String>,
    title: String,
    bpm: f64,
    path: String,
}

struct Args {
    index: PathBuf,
    artist: Option<String>,
    bpm_min: Option<f64>,
    bpm_max: Option<f64>,
    sound: Option<String>,
    keyword: Option<String>,
    limit: usize,
    json: bool,
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("strudel-search: {e}");
            eprintln!(
                "usage: strudel-search [--index <path|dir>] [--artist <q>] [--bpm-min N] [--bpm-max N] [--sound <name>] [--keyword <q>] [--limit N] [--json]"
            );
            return ExitCode::from(2);
        }
    };

    let index_files = collect_indexes(&args.index);
    if index_files.is_empty() {
        eprintln!(
            "strudel-search: no *.index.json found at {}",
            args.index.display()
        );
        return ExitCode::from(2);
    }

    let needs_content = args.sound.is_some() || args.keyword.is_some();
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned = 0usize;

    'outer: for idx_path in &index_files {
        let base = idx_path.parent().unwrap_or(Path::new("."));
        let Ok(text) = std::fs::read_to_string(idx_path) else {
            continue;
        };
        let Ok(index) = serde_json::from_str::<Index>(&text) else {
            eprintln!(
                "strudel-search: skipping unreadable index {}",
                idx_path.display()
            );
            continue;
        };

        for e in &index.entries {
            if !e.valid {
                continue;
            }
            scanned += 1;
            if let Some(q) = &args.artist
                && !e
                    .artist
                    .as_deref()
                    .map(|a| contains_ci(a, q))
                    .unwrap_or(false)
            {
                continue;
            }
            if let Some(lo) = args.bpm_min
                && e.bpm < lo
            {
                continue;
            }
            if let Some(hi) = args.bpm_max
                && e.bpm > hi
            {
                continue;
            }

            // Resolve the converted file once if any content filter is active.
            let abs = e.strudel.as_ref().map(|rel| base.join(rel));
            if needs_content {
                let Some(code) = abs.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) else {
                    continue;
                };
                if let Some(snd) = &args.sound
                    && !uses_sound(&code, snd)
                {
                    continue;
                }
                if let Some(kw) = &args.keyword
                    && !contains_ci(&code, kw)
                    && !contains_ci(&e.stem, kw)
                {
                    continue;
                }
            }

            hits.push(Hit {
                dataset: index.dataset.clone(),
                artist: e.artist.clone(),
                title: e.stem.clone(),
                bpm: e.bpm,
                path: abs.map(|p| p.display().to_string()).unwrap_or_default(),
            });
            if hits.len() >= args.limit {
                break 'outer;
            }
        }
    }

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&hits).unwrap_or_else(|_| "[]".into())
        );
    } else {
        for h in &hits {
            let artist = h.artist.as_deref().unwrap_or("?");
            println!("{artist} — {} [{:.0} bpm]\n  {}", h.title, h.bpm, h.path);
        }
        eprintln!("\n{} match(es) ({} entries scanned)", hits.len(), scanned);
    }
    ExitCode::SUCCESS
}

/// Case-insensitive substring.
fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Does the code trigger this sound via `s("…")` / `sound("…")` / `.s("…")`?
/// A loose token check — good enough for "which snippets use a supersaw".
fn uses_sound(code: &str, sound: &str) -> bool {
    let s = sound.to_lowercase();
    let lower = code.to_lowercase();
    // Match the sound name as a quoted token; cheap and avoids most false hits.
    lower.contains(&format!("\"{s}\""))
        || lower.contains(&format!("\"{s}:"))
        || lower.contains(&format!("\"{s} "))
}

fn collect_indexes(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        return vec![path.to_path_buf()];
    }
    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(path)
        .max_depth(2)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| {
            p.to_str()
                .map(|s| s.ends_with(".index.json"))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        index: PathBuf::from("../strudel-training/ingested"),
        artist: None,
        bpm_min: None,
        bpm_max: None,
        sound: None,
        keyword: None,
        limit: 25,
        json: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--index" => a.index = PathBuf::from(val()?),
            "--artist" => a.artist = Some(val()?),
            "--bpm-min" => {
                a.bpm_min = Some(val()?.parse().map_err(|_| "--bpm-min must be a number")?)
            }
            "--bpm-max" => {
                a.bpm_max = Some(val()?.parse().map_err(|_| "--bpm-max must be a number")?)
            }
            "--sound" => a.sound = Some(val()?),
            "--keyword" => a.keyword = Some(val()?),
            "--limit" => a.limit = val()?.parse().map_err(|_| "--limit must be a number")?,
            "--json" => a.json = true,
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(a)
}
