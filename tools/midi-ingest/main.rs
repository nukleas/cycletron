//! Pull a MIDI dataset into the Cycletron knowledge base.
//!
//! Walks a folder of `.mid`/`.midi` files, converts each to strudel-rs via the
//! `midi-to-strudel` pipeline, validates the result through the same gate as
//! `corpus-check` (parse + emit), and writes:
//!   - one `.strudel` file per *valid* conversion under `<out>/<dataset>/`
//!   - a `<dataset>.index.json` manifest of every file (valid or not) with
//!     metadata + a pointer to the source MIDI and the converted file.
//!
//! This is the "index in place, promote the best" half of the data-centralizing
//! plan: the index is the searchable centralized store; promotion into the
//! curated corpus is a separate, reviewed step (and must re-pass corpus-check).
//!
//! Usage:
//!     midi-ingest <midi-dir> [--genre <tag>] [--out <dir>] [--limit <n>] [--bars <n>]
//!
//! Defaults: --out corpus/ingested, --bars 4 (short, idiom-sized snippets),
//! --limit 0 (no cap).

use cycletron_midi::index::{Entry, Index};
use cycletron_midi::{ImportOptions, convert_bytes};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

struct Args {
    dir: PathBuf,
    genre: Option<String>,
    out: PathBuf,
    limit: usize,
    bars: usize,
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("midi-ingest: {e}");
            eprintln!(
                "usage: midi-ingest <midi-dir> [--genre <tag>] [--out <dir>] [--limit <n>] [--bars <n>]"
            );
            return ExitCode::from(2);
        }
    };

    if !args.dir.is_dir() {
        eprintln!("midi-ingest: {} is not a directory", args.dir.display());
        return ExitCode::from(2);
    }

    let dataset = args
        .dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("dataset")
        .to_string();
    let converted_dir = args.out.join(&dataset);

    let mut midis = collect_midis(&args.dir);
    midis.sort();
    if args.limit > 0 && midis.len() > args.limit {
        midis.truncate(args.limit);
    }
    if midis.is_empty() {
        eprintln!(
            "midi-ingest: no .mid/.midi files under {}",
            args.dir.display()
        );
        return ExitCode::from(2);
    }

    let mut entries: Vec<Entry> = Vec::with_capacity(midis.len());
    let mut valid_count = 0usize;

    for path in &midis {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("midi")
            .to_string();
        let artist = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .filter(|a| *a != dataset) // don't treat the dataset root as an artist
            .map(String::from);
        let (mut bpm, mut code_len, mut valid, mut error, mut rel) = (0.0, 0, false, None, None);

        match std::fs::read(path)
            .map_err(|e| e.to_string())
            .and_then(|d| convert(&d, args.bars).map_err(|e| e.to_string()))
        {
            Ok((code, b)) => {
                bpm = b;
                code_len = code.len();
                match validate(&code, args.bars.max(4)) {
                    Ok(()) => {
                        valid = true;
                        valid_count += 1;
                        // Prefix with artist so same-titled songs don't collide.
                        let safe = match &artist {
                            Some(a) => format!("{}__{}", sanitize(a), sanitize(&stem)),
                            None => sanitize(&stem),
                        };
                        let file = converted_dir.join(format!("{safe}.strudel"));
                        let header = format!(
                            "// ingested: {}\n// dataset: {dataset}{}  bpm: {bpm:.1}\n",
                            path.display(),
                            args.genre
                                .as_deref()
                                .map(|g| format!("  genre: {g}"))
                                .unwrap_or_default(),
                        );
                        if let Err(e) = write_file(&file, &format!("{header}\n{code}")) {
                            error = Some(format!("write: {e}"));
                            valid = false;
                            valid_count -= 1;
                        } else {
                            rel = Some(format!("{dataset}/{safe}.strudel"));
                        }
                    }
                    Err(e) => error = Some(e),
                }
            }
            Err(e) => error = Some(format!("convert: {e}")),
        }

        entries.push(Entry {
            source: path.display().to_string(),
            stem,
            artist,
            bpm,
            valid,
            error,
            code_len,
            strudel: rel,
        });
    }

    let total = entries.len();
    let index = Index {
        dataset: dataset.clone(),
        source_dir: args.dir.display().to_string(),
        genre: args.genre.clone(),
        bars: args.bars,
        total,
        valid: valid_count,
        entries,
    };

    let index_path = args.out.join(format!("{dataset}.index.json"));
    let json = match serde_json::to_string_pretty(&index) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("midi-ingest: serialize index: {e}");
            return ExitCode::FAILURE;
        }
    };
    if let Err(e) = write_file(&index_path, &json) {
        eprintln!("midi-ingest: write index: {e}");
        return ExitCode::FAILURE;
    }

    println!(
        "midi-ingest: {valid_count}/{total} converted & validated ({} failed)",
        total - valid_count
    );
    println!("  index:     {}", index_path.display());
    if valid_count > 0 {
        println!("  converted: {}/", converted_dir.display());
    }
    ExitCode::SUCCESS
}

/// Ingest conversion: the app's `convert_bytes` with auto-resolution, a bar
/// cap, and a 16-notes/bar fallback (denser default than the app's 64 — short
/// idiom-sized snippets, not full songs).
fn convert(data: &[u8], bar_limit: usize) -> anyhow::Result<(String, f64)> {
    let opts = ImportOptions {
        bar_limit,
        notes_per_bar: 16,
        ..ImportOptions::default()
    };
    let result = convert_bytes(data, &opts)?;
    Ok((result.code, result.bpm))
}

/// Like the `corpus-check` gate (parse + emit), but scans the first `window`
/// cycles instead of just cycle 0. Real songs often open on a pickup or rest in
/// bar 1; for *ingested* data we accept a snippet that sounds anywhere in its
/// loop. (Promotion into the curated corpus still faces the strict cycle-0
/// gate, plus human cleanup.)
fn validate(code: &str, window: usize) -> Result<(), String> {
    cycletron_analysis::validate_emits(code, window.max(1))
}

fn collect_midis(root: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| {
            matches!(
                p.extension()
                    .and_then(|s| s.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("mid") | Some("midi")
            )
        })
        .collect()
}

fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
}

/// Make a filesystem-safe stem (the source names have spaces, parens, etc.),
/// capped so `artist__title` stays well under the 255-byte filename limit.
fn sanitize(stem: &str) -> String {
    cycletron_core::text::slug::filename(stem, "midi", Some(100))
}

fn parse_args() -> Result<Args, String> {
    let mut dir: Option<PathBuf> = None;
    let mut genre = None;
    let mut out = PathBuf::from("corpus/ingested");
    let mut limit = 0usize;
    let mut bars = 4usize;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--genre" => genre = Some(it.next().ok_or("--genre needs a value")?),
            "--out" => out = PathBuf::from(it.next().ok_or("--out needs a value")?),
            "--limit" => {
                limit = it
                    .next()
                    .ok_or("--limit needs a value")?
                    .parse()
                    .map_err(|_| "--limit must be a number")?
            }
            "--bars" => {
                bars = it
                    .next()
                    .ok_or("--bars needs a value")?
                    .parse()
                    .map_err(|_| "--bars must be a number")?
            }
            other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
            other => {
                if dir.is_some() {
                    return Err(format!("unexpected argument {other}"));
                }
                dir = Some(PathBuf::from(other));
            }
        }
    }
    Ok(Args {
        dir: dir.ok_or("missing <midi-dir>")?,
        genre,
        out,
        limit,
        bars: bars.max(1),
    })
}
