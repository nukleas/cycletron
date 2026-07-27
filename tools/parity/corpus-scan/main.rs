//! Scan the strudel corpus against strudel-rs's DSL/mini evaluators.
//!
//! Walks a corpus directory, runs each pattern through the same
//! validation pipeline `cycletron_app::strudel::validate_code` uses,
//! classifies failures, and emits:
//!   - parity-report.jsonl  — one row per file
//!   - parity-summary.md    — top error categories
//!   - feature-tickets.md   — draft issue list for strudel-rs
//!
//! Usage: corpus-scan <corpus-dir> [<out-dir>]
//! Default corpus-dir = ../../../strudel-corpus (relative to this crate)
//! Default out-dir    = cwd

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Serialize)]
struct Row {
    path: String,
    kind: &'static str, // "strudel" | "js" | "mini"
    ok: bool,
    path_tried: &'static str, // which evaluator entry succeeded or last-tried
    error: Option<String>,
    category: Option<&'static str>,
    bytes: u64,
    ms: u128,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let corpus_dir = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| default_corpus_dir());
    let out_dir = args.get(2).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));

    let corpus_dir = corpus_dir.canonicalize().unwrap_or(corpus_dir);
    eprintln!("scanning {} …", corpus_dir.display());

    let mut rows: Vec<Row> = Vec::new();
    for entry in walkdir::WalkDir::new(&corpus_dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let kind = match ext.as_str() {
            "strudel" => "strudel",
            "js" => "js",
            _ => continue,
        };
        // Skip derived parts (the agent-part excerpts are fragments, not
        // full patterns — they don't parse as standalone code)
        if path
            .components()
            .any(|c| c.as_os_str() == "derived")
        {
            continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let code = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                rows.push(Row {
                    path: path.display().to_string(),
                    kind,
                    ok: false,
                    path_tried: "io",
                    error: Some(e.to_string()),
                    category: Some("io-error"),
                    bytes,
                    ms: 0,
                });
                continue;
            }
        };

        let start = Instant::now();
        let result = try_evaluate(&code);
        let ms = start.elapsed().as_millis();

        let row = match result {
            Ok(path_tried) => Row {
                path: path.display().to_string(),
                kind,
                ok: true,
                path_tried,
                error: None,
                category: None,
                bytes,
                ms,
            },
            Err((last_tried, err)) => {
                let category = classify_error(&err);
                Row {
                    path: path.display().to_string(),
                    kind,
                    ok: false,
                    path_tried: last_tried,
                    error: Some(err),
                    category: Some(category),
                    bytes,
                    ms,
                }
            }
        };
        rows.push(row);
    }

    write_report(&out_dir, &rows);
    print_summary(&rows);
}

fn default_corpus_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.join("strudel-corpus/normalized"))
        .unwrap_or_else(|| PathBuf::from("strudel-corpus/normalized"))
}

/// Mirror the validation pipeline in src-tauri/src/strudel.rs so the
/// scanner measures the same behavior the REPL relies on.
fn try_evaluate(code: &str) -> Result<&'static str, (&'static str, String)> {
    if code.trim().is_empty() {
        return Err(("empty", "empty pattern".to_string()));
    }

    // 1. Multi-track .strudel with directives
    if let Ok(file) = strudel_dsl::parse_strudel_file(code) {
        let has_content = !file.tracks.is_empty()
            || !file.directives.is_empty()
            || !file.bindings.is_empty()
            || !file.functions.is_empty();
        if has_content {
            match strudel_dsl::evaluate_file(&file) {
                Ok(_) => return Ok("strudel-file"),
                Err(e) => return Err(("strudel-file", e.to_string())),
            }
        }
    }

    // 2. DSL with optional tempo (setbpm/setcpm).
    if strudel_dsl::eval_dsl_with_tempo(code).is_ok() {
        return Ok("dsl-with-tempo");
    }

    // 3. Mini notation
    if let Ok(ast) = strudel_mini::parse(code)
        && strudel_mini::evaluate(&ast).is_ok()
    {
        return Ok("mini");
    }

    // 4. Surface the DSL error as the most useful diagnostic.
    let err = match strudel_dsl::eval_dsl_with_tempo(code) {
        Err(e) => e.to_string(),
        Ok(_) => "pattern did not evaluate (all paths exhausted)".to_string(),
    };
    Err(("dsl-bare", err))
}

/// Bucket errors by rough cause so the summary can highlight the biggest
/// gaps. The patterns are intentionally loose — any change in upstream
/// error text only moves entries between buckets, never breaks the scan.
fn classify_error(err: &str) -> &'static str {
    let e = err.to_ascii_lowercase();
    // Very specific before generic — order matters.

    // JS single-quoted strings: the DSL parser only accepts `"`.
    if e.contains("unexpected character") && e.contains(": '") {
        return "single-quote-string";
    }
    // Arrow functions: `x => x.fast(2)` used for sometimes()/every()/etc.
    if e.contains("arrow function") {
        return "arrow-function";
    }
    if e.contains("unexpected character") && e.contains(": =") {
        return "arrow-function"; // leading `=` almost always arrow-fn `=>`
    }
    // Template literals: backtick strings `x ${y}` in JS patterns.
    if e.contains("unexpected character") && e.contains(": `") {
        return "template-literal";
    }
    // Unclosed strings often follow single-quote handling
    if e.contains("unclosed string") {
        return "string-literal";
    }

    if e.contains("unknown function") || e.contains("undefined function") {
        "unknown-function"
    } else if e.contains("unknown method") || e.contains("no method") || e.contains("method not found") {
        "unknown-method"
    } else if e.contains("unknown identifier") || e.contains("undefined variable") || e.contains("not defined") {
        "unknown-identifier"
    } else if e.contains("expected") && (e.contains("argument") || e.contains("arity")) {
        "arity-mismatch"
    } else if e.contains("type") && (e.contains("expected") || e.contains("mismatch")) {
        "type-mismatch"
    } else if e.contains("sample") && e.contains("not found") {
        "sample-not-found"
    } else if e.contains("unsupported") || e.contains("not supported") || e.contains("not implemented") {
        "unsupported"
    } else if e.contains("division by zero") || e.contains("overflow") {
        "numeric"
    } else if e.contains("unexpected token") || e.contains("unexpected character") || e.contains("parse") || e.contains("syntax") {
        "parse-error"
    } else if e.contains("mini") && (e.contains("parse") || e.contains("pattern")) {
        "mini-parse"
    } else {
        "other"
    }
}

fn write_report(out_dir: &Path, rows: &[Row]) {
    fs::create_dir_all(out_dir).ok();
    let jsonl_path = out_dir.join("parity-report.jsonl");
    let mut jsonl = String::new();
    for r in rows {
        jsonl.push_str(&serde_json::to_string(r).unwrap());
        jsonl.push('\n');
    }
    fs::write(&jsonl_path, jsonl).expect("write parity-report.jsonl");

    write_summary(out_dir, rows);
    write_tickets(out_dir, rows);
}

fn write_summary(out_dir: &Path, rows: &[Row]) {
    let total = rows.len();
    let passing = rows.iter().filter(|r| r.ok).count();
    let failing = total - passing;

    // by category
    let mut by_cat: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows.iter().filter(|r| !r.ok) {
        by_cat.entry(r.category.unwrap_or("other")).or_default().push(r);
    }

    // Top missing identifiers / functions — pull from error strings.
    let ident_re = regex::Regex::new(r#"(?:unknown (?:function|method|identifier)|no method|not defined|undefined(?: function| variable)?)[:\s]+['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?"#)
        .unwrap();
    let mut missing_counts: BTreeMap<String, usize> = BTreeMap::new();
    for r in rows.iter().filter(|r| !r.ok) {
        if let Some(err) = &r.error
            && let Some(cap) = ident_re.captures(err)
        {
            *missing_counts.entry(cap[1].to_string()).or_default() += 1;
        }
    }
    let mut missing_vec: Vec<(String, usize)> = missing_counts.into_iter().collect();
    missing_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let mut md = String::new();
    md.push_str("# Strudel-rs Corpus Parity — Summary\n\n");
    md.push_str(&format!(
        "- **Total files scanned:** {total}\n- **Passing:** {passing} ({:.1}%)\n- **Failing:** {failing} ({:.1}%)\n\n",
        100.0 * passing as f64 / total.max(1) as f64,
        100.0 * failing as f64 / total.max(1) as f64,
    ));

    md.push_str("## Failure categories\n\n| Category | Files | Share |\n|---|---:|---:|\n");
    let mut cats: Vec<_> = by_cat.iter().collect();
    cats.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    for (cat, files) in &cats {
        md.push_str(&format!(
            "| `{cat}` | {} | {:.1}% |\n",
            files.len(),
            100.0 * files.len() as f64 / failing.max(1) as f64,
        ));
    }

    md.push_str("\n## Top missing identifiers\n\n| Name | Hits |\n|---|---:|\n");
    for (name, count) in missing_vec.iter().take(40) {
        md.push_str(&format!("| `{name}` | {count} |\n"));
    }

    md.push_str("\n## Samples (first 10 failures per category)\n\n");
    for (cat, files) in cats.iter().take(8) {
        md.push_str(&format!("### `{cat}` ({})\n\n", files.len()));
        for r in files.iter().take(10) {
            let err = r.error.as_deref().unwrap_or("").lines().next().unwrap_or("");
            md.push_str(&format!("- `{}` — {}\n", short_path(&r.path), err));
        }
        md.push_str("\n");
    }

    fs::write(out_dir.join("parity-summary.md"), md).expect("write parity-summary.md");
}

fn write_tickets(out_dir: &Path, rows: &[Row]) {
    let failing: Vec<&Row> = rows.iter().filter(|r| !r.ok).collect();
    let mut by_cat: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in &failing {
        by_cat.entry(r.category.unwrap_or("other")).or_default().push(r);
    }

    let mut md = String::new();
    md.push_str("# Strudel-rs Feature Tickets (Draft)\n\n");
    md.push_str("> Auto-generated from `corpus-scan`. Groups failing corpus patterns by\n");
    md.push_str("> category; each group is a candidate feature ticket for strudel-rs.\n\n");

    let priorities: Vec<(&str, &str)> = vec![
        ("unknown-function", "Add missing combinators / factory functions"),
        ("unknown-method", "Add missing Pattern methods (fluent chain)"),
        ("unknown-identifier", "Expose globals (scales, sounds, named constants)"),
        ("arity-mismatch", "Align function signatures with strudel-js"),
        ("type-mismatch", "Value coercion / overload resolution"),
        ("unsupported", "Implement explicitly-unsupported features"),
        ("parse-error", "DSL parser fixes (syntax the JS REPL accepts)"),
        ("mini-parse", "Mini-notation parser fixes"),
        ("sample-not-found", "Sample registry completeness"),
        ("numeric", "Numeric edge cases"),
        ("other", "Uncategorized"),
    ];

    for (cat, title) in &priorities {
        let Some(files) = by_cat.get(cat) else { continue };
        if files.is_empty() { continue; }
        md.push_str(&format!("## {title} — `{cat}` ({})\n\n", files.len()));
        md.push_str("Representative failures:\n\n");
        for r in files.iter().take(15) {
            let err = r.error.as_deref().unwrap_or("").lines().next().unwrap_or("");
            md.push_str(&format!("- `{}`\n  {}\n", short_path(&r.path), err));
        }
        md.push_str("\nSuggested ticket body:\n");
        md.push_str("```\n");
        md.push_str(&format!(
            "Title: {title} — {} failing corpus files\n\n",
            files.len()
        ));
        md.push_str("Description:\n");
        md.push_str(&format!(
            "`corpus-scan` against ~/Code/strudel-corpus reports {} patterns failing in category `{cat}`.\n",
            files.len()
        ));
        md.push_str("See representative failures above. Target: compile + evaluate these via\n");
        md.push_str("`strudel_dsl::eval_dsl_with_tempo` (or `parse_strudel_file` / `eval_file`).\n");
        md.push_str("```\n\n");
    }

    fs::write(out_dir.join("feature-tickets.md"), md).expect("write feature-tickets.md");
}

fn print_summary(rows: &[Row]) {
    let total = rows.len();
    let passing = rows.iter().filter(|r| r.ok).count();
    let failing = total - passing;
    let mut by_cat: BTreeMap<&str, usize> = BTreeMap::new();
    for r in rows.iter().filter(|r| !r.ok) {
        *by_cat.entry(r.category.unwrap_or("other")).or_default() += 1;
    }
    eprintln!(
        "\n== corpus parity ==\n{passing}/{total} passing ({:.1}%)  |  {failing} failing",
        100.0 * passing as f64 / total.max(1) as f64
    );
    let mut cats: Vec<_> = by_cat.into_iter().collect();
    cats.sort_by(|a, b| b.1.cmp(&a.1));
    for (cat, n) in cats {
        eprintln!("  {cat:>20}  {n}");
    }
    eprintln!(
        "\nReport files:\n  parity-report.jsonl\n  parity-summary.md\n  feature-tickets.md"
    );
}

fn short_path(p: &str) -> String {
    // Trim everything before "normalized/" so paths in the report are compact.
    if let Some(idx) = p.find("normalized/") {
        p[idx..].to_string()
    } else {
        p.to_string()
    }
}
