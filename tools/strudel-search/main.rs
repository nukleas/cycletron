//! Search the ingested MIDI idiom store *or* the MusicRepo bakery JSONL.
//!
//!     strudel-search --bakery --keyword acid --bpm-min 125 --bpm-max 140
//!     strudel-search --bakery --sound sawtooth --effect lpf --named --limit 15
//!     strudel-search --artist "Daft Punk" --bpm-min 120 --bpm-max 130
//!
//! `--bakery` reads `.corpus-cache/corpus.jsonl` (from `fetch-corpus.sh`).
//! MIDI-index mode is unchanged (`--index`).

use cycletron_midi::index::Index;
use serde::{Deserialize, Serialize};
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
    jsonl: Option<PathBuf>,
    artist: Option<String>,
    bpm_min: Option<f64>,
    bpm_max: Option<f64>,
    sound: Option<String>,
    effect: Option<String>,
    keyword: Option<String>,
    named: bool,
    limit: usize,
    json: bool,
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("strudel-search: {e}");
            eprintln!(
                "usage: strudel-search [--bakery|--jsonl FILE] [--named] [--artist <q>] [--bpm-min N] [--bpm-max N] [--sound <name>] [--effect <name>] [--keyword <q>] [--limit N] [--json]"
            );
            return ExitCode::from(2);
        }
    };

    if let Some(jsonl) = &args.jsonl {
        return search_jsonl(jsonl, &args);
    }

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
        jsonl: None,
        artist: None,
        bpm_min: None,
        bpm_max: None,
        sound: None,
        effect: None,
        keyword: None,
        named: false,
        limit: 25,
        json: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--index" => a.index = PathBuf::from(val()?),
            "--jsonl" => a.jsonl = Some(PathBuf::from(val()?)),
            "--bakery" => {
                a.jsonl = Some(default_bakery_jsonl());
            }
            "--artist" => a.artist = Some(val()?),
            "--bpm-min" => {
                a.bpm_min = Some(val()?.parse().map_err(|_| "--bpm-min must be a number")?)
            }
            "--bpm-max" => {
                a.bpm_max = Some(val()?.parse().map_err(|_| "--bpm-max must be a number")?)
            }
            "--sound" => a.sound = Some(val()?),
            "--effect" => a.effect = Some(val()?),
            "--keyword" => a.keyword = Some(val()?),
            "--named" => a.named = true,
            "--limit" => a.limit = val()?.parse().map_err(|_| "--limit must be a number")?,
            "--json" => a.json = true,
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(a)
}

fn default_bakery_jsonl() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .and_then(|p| p.parent())
        .map(|root| root.join(".corpus-cache/corpus.jsonl"))
        .unwrap_or_else(|| PathBuf::from(".corpus-cache/corpus.jsonl"))
}

#[derive(Deserialize)]
struct BakeryRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    tempo: Option<f64>,
    #[serde(default)]
    sounds: serde_json::Value,
    #[serde(default)]
    effects: serde_json::Value,
    #[serde(default)]
    code: String,
}

#[derive(Serialize)]
struct BakeryHit {
    title: String,
    source: String,
    bpm: Option<f64>,
    sounds: Vec<String>,
    effects: Vec<String>,
    loc: usize,
    id: String,
}

fn search_jsonl(path: &Path, args: &Args) -> ExitCode {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("strudel-search: cannot read {}: {e}", path.display());
            return ExitCode::from(2);
        }
    };

    let mut hits: Vec<BakeryHit> = Vec::new();
    let mut scanned = 0usize;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<BakeryRow>(line) else {
            continue;
        };
        scanned += 1;

        let title = row.title.clone().unwrap_or_default();
        if args.named && !is_named_title(&title) {
            continue;
        }
        if let Some(q) = &args.artist
            && !contains_ci(&title, q)
            && !row.source.as_deref().is_some_and(|s| contains_ci(s, q))
        {
            continue;
        }
        if let Some(lo) = args.bpm_min
            && row.tempo.is_none_or(|t| t < lo)
        {
            continue;
        }
        if let Some(hi) = args.bpm_max
            && row.tempo.is_none_or(|t| t > hi)
        {
            continue;
        }

        let sounds = names_from_value(&row.sounds);
        let effects = names_from_value(&row.effects);
        if let Some(snd) = &args.sound
            && !sounds.iter().any(|s| contains_ci(s, snd))
            && !uses_sound(&row.code, snd)
        {
            continue;
        }
        if let Some(fx) = &args.effect
            && !effects.iter().any(|e| contains_ci(e, fx))
            && !contains_ci(&row.code, fx)
        {
            continue;
        }
        if let Some(kw) = &args.keyword
            && !contains_ci(&title, kw)
            && !contains_ci(&row.code, kw)
            && !sounds.iter().any(|s| contains_ci(s, kw))
        {
            continue;
        }

        hits.push(BakeryHit {
            title,
            source: row.source.unwrap_or_default(),
            bpm: row.tempo,
            sounds: sounds.into_iter().take(8).collect(),
            effects: effects.into_iter().take(8).collect(),
            loc: row.code.lines().count(),
            id: row.id,
        });
        if hits.len() >= args.limit {
            break;
        }
    }

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&hits).unwrap_or_else(|_| "[]".into())
        );
    } else {
        for h in &hits {
            let bpm = h
                .bpm
                .map(|b| format!("{b:.0}"))
                .unwrap_or_else(|| "?".into());
            println!(
                "{} [{bpm} bpm · {} loc · {}]\n  sounds: {}\n  id: {}",
                h.title,
                h.loc,
                h.source,
                h.sounds.join(", "),
                h.id
            );
        }
        eprintln!("\n{} match(es) ({} rows scanned)", hits.len(), scanned);
    }
    ExitCode::SUCCESS
}

fn is_named_title(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() || t.starts_with("bakery-") {
        return false;
    }
    let core = t.rsplit_once('[').map(|(a, _)| a.trim()).unwrap_or(t);
    core.len() >= 4 && !core.starts_with(['.', '?', ':', '-', '\'', '"'])
}

fn names_from_value(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::Array(xs) => xs
            .iter()
            .filter_map(|x| match x {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(m) => {
                    m.get("name").and_then(|n| n.as_str()).map(str::to_string)
                }
                _ => None,
            })
            .take(32)
            .collect(),
        serde_json::Value::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}
