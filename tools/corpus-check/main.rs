//! Strict validator for the robostrudel curated corpus.
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
            Ok(code) => units.push(Unit { label: short(&path), code }),
            Err(e) => failures.push((short(&path), format!("io: {e}"))),
        }
    }

    // 2. ```strudel fragments inside `*.md` genre recipes.
    for path in collect_recipe_files(&root) {
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for frag in robostrudel_corpus::recipes::extract_strudel_blocks(&text) {
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

    if failing > 0 {
        println!();
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
        .filter(|p| {
            // Skip directory docs (README.md, _template.md) — only recipes are gated.
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|stem| !(stem.starts_with('_') || stem.eq_ignore_ascii_case("readme")))
                .unwrap_or(true)
        })
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

/// Mirror of `src-tauri/src/strudel.rs::validate_code`, plus a non-emptiness
/// assertion: a pattern that parses but produces no events in cycle 0 is
/// almost certainly a curation mistake.
fn validate(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("empty pattern".to_string());
    }

    if let Ok(file) = strudel_dsl::parse_strudel_file(code) {
        let has_content = !file.tracks.is_empty()
            || !file.directives.is_empty()
            || !file.bindings.is_empty()
            || !file.functions.is_empty();
        if has_content {
            return strudel_dsl::evaluate_file(&file)
                .map_err(|e| e.to_string())
                .and_then(|f| require_haps(&f.pattern));
        }
    }

    if let Ok(out) = strudel_dsl::execute(code) {
        return require_haps(&out.pattern);
    }

    if let Ok(ast) = strudel_mini::parse(code)
        && let Ok(pat) = strudel_mini::evaluate(&ast)
    {
        return require_haps(&pat);
    }

    Err(match strudel_dsl::execute(code) {
        Err(e) => e.to_string(),
        Ok(_) => "pattern did not evaluate".to_string(),
    })
}

fn require_haps(pattern: &strudel_core::Pattern) -> Result<(), String> {
    if pattern.query_arc(0i32, 1i32).is_empty() {
        Err("pattern emits no events in cycle 0 — silent pattern".to_string())
    } else {
        Ok(())
    }
}

fn short(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(idx) = s.find("/corpus/") {
        return s[idx + 1..].to_string();
    }
    s
}
