//! Strict validator for the Cycletron curated corpus.
//!
//! Walks `corpus/` and runs every `.strudel` file — and every ```strudel
//! fragment inside `corpus/genres/*.md` recipes — through the same pipeline
//! `src-tauri/src/strudel.rs::validate_code` uses. Exits non-zero if ANY unit
//! fails. This gates CI, the AI corpus-extension loop, and the genre-recipe
//! research pipeline: a recipe can never ship a fragment that doesn't actually
//! run on strudel-rs.
//!
//! Usage:
//!     corpus-check                   # walk ./corpus
//!     corpus-check path/to/corpus    # walk a custom dir
//!     corpus-check file.strudel      # validate a single file

use std::path::{Path, PathBuf};
use std::process::ExitCode;

/// A thing to validate: a display label plus its strudel code.
struct Unit {
    label: String,
    code: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();

    // Batch mode: `corpus-check patterns.jsonl` validates a corpus export.
    // Each line is {"id": "...", "code": "..."} (frontmatter tolerated & stripped).
    // Reuses the exact same `validate()` pipeline the gate uses, so pass ==
    // "runs on strudel-rs". Writes <input>.results.jsonl and prints a summary
    // plus a failure-reason histogram. Never fails the process (it's a survey,
    // not a gate).
    if let Some(arg) = args.get(1)
        && arg.ends_with(".jsonl")
    {
        return batch_validate(Path::new(arg));
    }

    let root = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_corpus_dir);

    if !root.exists() {
        eprintln!("corpus-check: {} does not exist", root.display());
        return ExitCode::from(2);
    }

    let mut units: Vec<Unit> = Vec::new();
    let mut failures: Vec<(String, String)> = Vec::new();

    // 1. Curated `.strudel` files.
    for path in collect_strudel_files(&root) {
        match std::fs::read_to_string(&path) {
            Ok(code) => units.push(Unit {
                label: short(&path),
                code,
            }),
            Err(e) => failures.push((short(&path), format!("io: {e}"))),
        }
    }

    // 1b. On a default full run, also gate the song files under `ui/songs/`.
    if args.get(1).is_none() {
        for path in extra_ungated_files() {
            match std::fs::read_to_string(&path) {
                Ok(code) => units.push(Unit {
                    label: short(&path),
                    code,
                }),
                Err(e) => failures.push((short(&path), format!("io: {e}"))),
            }
        }
    }

    // 2. ```strudel fragments inside `*.md` genre recipes.
    for path in collect_recipe_files(&root) {
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for frag in cycletron_corpus::recipes::extract_strudel_blocks(&text) {
                    units.push(Unit {
                        label: format!("{} [{}]", short(&path), frag.label),
                        code: frag.code,
                    });
                }
            }
            Err(e) => failures.push((short(&path), format!("io: {e}"))),
        }
    }

    if units.is_empty() && failures.is_empty() {
        eprintln!(
            "corpus-check: no .strudel files or recipe fragments under {}",
            root.display()
        );
        return ExitCode::from(2);
    }

    for unit in &units {
        if let Err(e) = validate(&unit.code) {
            failures.push((unit.label.clone(), e));
        }
    }

    let total = units.len();
    let failing = failures.len();
    let passing = total.saturating_sub(failing);
    println!("corpus-check: {passing}/{total} ok");

    // Engine-behavior contract: every documented claim about strudel-rs is
    // re-verified against the pinned engine here, so a rev bump that changes
    // behavior fails the gate instead of silently stale-ing the docs/prompt.
    let contract = cycletron_analysis::engine_contract::check();
    if !contract.is_empty() {
        println!(
            "\nengine-contract: {} documented claim(s) drifted from the engine",
            contract.len()
        );
        for msg in &contract {
            println!("  DRIFT {msg}");
        }
    } else {
        println!("engine-contract: ok (documented behaviors match the pinned engine)");
    }

    if failing > 0 || !contract.is_empty() {
        if failing > 0 {
            println!();
        }
        for (label, err) in &failures {
            println!("FAIL {label}");
            for line in err.lines() {
                println!("     {line}");
            }
        }
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

/// Collect `*.md` recipe files under `root` (skipped when `root` is a single
/// non-markdown file).
fn collect_recipe_files(root: &Path) -> Vec<PathBuf> {
    if root.is_file() {
        return if root.extension().and_then(|s| s.to_str()) == Some("md") {
            vec![root.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
        // Skip directory docs (README.md, _template.md) — only recipes are gated.
        .filter(|p| !cycletron_corpus::layout::is_doc_file(p))
        .collect();
    out.sort();
    out
}

fn default_corpus_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = tools/corpus-check; corpus/ lives two levels up.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("corpus"))
        .unwrap_or_else(|| PathBuf::from("corpus"))
}

/// Song files outside `corpus/`: `ui/songs/**/*.strudel`.
fn extra_ungated_files() -> Vec<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(repo) = manifest.parent().and_then(|p| p.parent()) else {
        return Vec::new();
    };
    collect_strudel_files(&repo.join("ui").join("songs"))
}

fn collect_strudel_files(root: &Path) -> Vec<PathBuf> {
    if root.is_file() {
        return vec![root.to_path_buf()];
    }
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "strudel" {
            out.push(path.to_path_buf());
        }
    }
    out.sort();
    out
}

/// Validate a JSONL corpus export against the strudel-rs pipeline and report a
/// compatibility survey. Input lines: {"id": string, "code": string}.
fn batch_validate(path: &Path) -> ExitCode {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("corpus-check: cannot read {}: {e}", path.display());
            return ExitCode::from(2);
        }
    };

    // Some malformed patterns make the strudel-rs parser panic (e.g. integer
    // overflow) rather than return an Err. Silence the default panic print and
    // catch each one so a single bad pattern can't abort the survey.
    std::panic::set_hook(Box::new(|_| {}));

    let mut total = 0usize;
    let mut passing = 0usize;
    let mut buckets: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut results = String::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("?");
        let raw = v.get("code").and_then(|x| x.as_str()).unwrap_or("");
        let code = strip_frontmatter(raw);
        total += 1;

        let outcome = std::panic::catch_unwind(|| validate(code))
            .unwrap_or_else(|_| Err("parser panicked (strudel-rs bug)".to_string()));
        match outcome {
            Ok(()) => {
                passing += 1;
                results.push_str(&format!("{{\"id\":\"{id}\",\"ok\":true}}\n"));
            }
            Err(e) => {
                let reason = classify_error(&e);
                *buckets.entry(reason.to_string()).or_default() += 1;
                let esc = e
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', " ");
                results.push_str(&format!(
                    "{{\"id\":\"{id}\",\"ok\":false,\"reason\":\"{reason}\",\"error\":\"{esc}\"}}\n"
                ));
            }
        }
    }

    let out_path = path.with_extension("results.jsonl");
    if let Err(e) = std::fs::write(&out_path, &results) {
        eprintln!("corpus-check: cannot write {}: {e}", out_path.display());
    }

    let failing = total - passing;
    let pct = if total > 0 {
        100.0 * passing as f64 / total as f64
    } else {
        0.0
    };
    println!("corpus-check batch: {passing}/{total} pass ({pct:.1}%), {failing} fail");
    println!("results → {}", out_path.display());
    if failing > 0 {
        println!("\nfailure reasons:");
        let mut sorted: Vec<_> = buckets.iter().collect();
        sorted.sort_by(|a, b| b.1.cmp(a.1));
        for (reason, n) in sorted {
            println!("  {n:>5}  {reason}");
        }
    }
    ExitCode::SUCCESS
}

/// Strip a leading `---\n … \n---\n` YAML frontmatter block (bakery exports
/// carry one; strudel-rs does not parse it).
fn strip_frontmatter(code: &str) -> &str {
    cycletron_core::text::frontmatter::split(code).1
}

/// Coarse-bucket a validation error into a comparable reason so the histogram
/// points at which JS-strudel features to port next.
fn classify_error(e: &str) -> &'static str {
    let l = e.to_lowercase();
    if l.contains("panic") {
        "parser panic (bug)"
    } else if l.contains("silent") || l.contains("no events") {
        "silent (no haps)"
    } else if l.contains("unknown") && l.contains("function") {
        "unknown function"
    } else if l.contains("unknown") && (l.contains("method") || l.contains("control")) {
        "unknown method/control"
    } else if l.contains("unexpected") || l.contains("expected") || l.contains("parse") {
        "parse error"
    } else if l.contains("arrow") || l.contains("=>") {
        "arrow/lambda"
    } else if l.contains("scale") {
        "scale/chord"
    } else if l.contains("sample") || l.contains("bank") {
        "sample/bank"
    } else {
        "other"
    }
}

/// The same evaluation pipeline the in-app agent uses, plus a non-emptiness
/// assertion: a pattern that parses but produces no events across the scan
/// window is almost certainly a curation mistake.
fn validate(code: &str) -> Result<(), String> {
    // Scan a small window, not just cycle 0 — full songs legitimately open
    // with a rest/pickup, so a strict cycle-0 check false-fails them. One
    // evaluation serves the emptiness gate AND the silence lint below.
    const WINDOW: usize = 8;
    let ev = cycletron_analysis::Evaluated::new(code, WINDOW)?;
    if !ev.has_any_haps() {
        return Err(format!(
            "pattern emits no events in {WINDOW} cycles — silent pattern"
        ));
    }
    // Silence lint: a pattern can parse + emit haps yet still ship a DEAD layer —
    // an unvoiced `chord(...)` (never expands to pitches) or an invented sound
    // name (falls back to sine). Gate on those two silent-bug classes (same
    // checks song-check runs); clipping/mono/etc. stay advisory-only.
    let mut dead: Vec<String> = Vec::new();
    for f in cycletron_analysis::lint_source(code) {
        if f.code == "unvoiced-chord" {
            dead.push(format!("{}: {}", f.code, f.message));
        }
    }
    let known = cycletron_analysis::sounds::SoundSet::builtin_only();
    for f in cycletron_analysis::lint_digest(ev.digest(), &known) {
        if f.code == "unknown-sound" {
            dead.push(format!("{}: {}", f.code, f.message));
        }
    }
    if dead.is_empty() {
        Ok(())
    } else {
        Err(dead.join("\n"))
    }
}

fn short(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(idx) = s.find("/corpus/") {
        return s[idx + 1..].to_string();
    }
    s
}
