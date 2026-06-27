//! Analyze `agent-telemetry.jsonl` (written by the Tauri agent loop) to surface
//! where the agent struggles: per-tool failure rates, the most common failure
//! messages, and retry loops within a single request.
//!
//! Usage:
//!     agent-stats [<telemetry.jsonl>]   (default: ./agent-telemetry.jsonl)
//!
//! The app writes the file to its data dir — on macOS, typically
//! `~/Library/Application Support/<bundle-id>/agent-telemetry.jsonl`.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::process::ExitCode;

#[derive(Deserialize)]
struct Event {
    #[serde(default)]
    run: u128,
    #[serde(default)]
    turn: usize,
    tool: String,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: String,
}

/// Outcome classification. A tool can return Ok yet report failure in its text
/// (validate_pattern → "INVALID: …"); that's the struggle signal we care about.
fn outcome(e: &Event) -> &'static str {
    if !e.ok {
        return "error";
    }
    let r = e.result.trim_start();
    if r.starts_with("INVALID") {
        "invalid"
    } else if r.starts_with("Could not") || r.starts_with("error") {
        "failed"
    } else {
        "ok"
    }
}

fn is_failure(o: &str) -> bool {
    o != "ok"
}

/// Normalize a failure message so positions/numbers collapse: "at 42..47" and
/// "at 10..15" become the same bucket. Replaces digit runs with `#`.
fn normalize(result: &str) -> String {
    let first = result.lines().next().unwrap_or("").trim();
    let mut out = String::with_capacity(first.len());
    let mut in_digits = false;
    for c in first.chars() {
        if c.is_ascii_digit() {
            if !in_digits {
                out.push('#');
                in_digits = true;
            }
        } else {
            out.push(c);
            in_digits = false;
        }
    }
    out.chars().take(100).collect()
}

#[derive(Default)]
struct ToolAgg {
    calls: usize,
    fails: usize,
}

fn main() -> ExitCode {
    let path = std::env::args().nth(1).unwrap_or_else(|| "agent-telemetry.jsonl".to_string());
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("agent-stats: cannot read {path}: {e}");
            eprintln!("  (the app writes it to its data dir, e.g. ~/Library/Application Support/<bundle-id>/agent-telemetry.jsonl)");
            return ExitCode::from(2);
        }
    };

    let events: Vec<Event> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    if events.is_empty() {
        eprintln!("agent-stats: no events in {path}");
        return ExitCode::from(2);
    }

    let mut per_tool: BTreeMap<String, ToolAgg> = BTreeMap::new();
    let mut error_buckets: BTreeMap<String, usize> = BTreeMap::new();
    // run -> tool -> failure count, for retry-loop detection.
    let mut run_fails: BTreeMap<u128, BTreeMap<String, Vec<usize>>> = BTreeMap::new();

    for e in &events {
        let o = outcome(e);
        let agg = per_tool.entry(e.tool.clone()).or_default();
        agg.calls += 1;
        if is_failure(o) {
            agg.fails += 1;
            *error_buckets.entry(normalize(&e.result)).or_default() += 1;
            run_fails
                .entry(e.run)
                .or_default()
                .entry(e.tool.clone())
                .or_default()
                .push(e.turn);
        }
    }

    let runs = events.iter().map(|e| e.run).collect::<std::collections::BTreeSet<_>>().len();
    println!("agent-stats: {} tool calls across {} run(s)\n", events.len(), runs);

    // Per-tool table, worst failure-rate first.
    println!("Per-tool (calls · fails · fail-rate):");
    let mut tools: Vec<_> = per_tool.iter().collect();
    tools.sort_by(|a, b| {
        let ra = a.1.fails as f64 / a.1.calls as f64;
        let rb = b.1.fails as f64 / b.1.calls as f64;
        rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal).then(b.1.calls.cmp(&a.1.calls))
    });
    for (tool, agg) in tools {
        let rate = 100.0 * agg.fails as f64 / agg.calls as f64;
        println!("  {tool:<22} {:>5} {:>6} {:>6.0}%", agg.calls, agg.fails, rate);
    }

    if !error_buckets.is_empty() {
        println!("\nTop failure messages:");
        let mut errs: Vec<_> = error_buckets.iter().collect();
        errs.sort_by(|a, b| b.1.cmp(a.1));
        for (msg, n) in errs.into_iter().take(15) {
            println!("  {n:>4}×  {msg}");
        }
    }

    // Retry loops: a run that failed the same tool more than once.
    let loops: Vec<(u128, String, usize)> = run_fails
        .iter()
        .flat_map(|(run, tools)| {
            tools
                .iter()
                .filter(|(_, turns)| turns.len() > 1)
                .map(move |(tool, turns)| (*run, tool.clone(), turns.len()))
        })
        .collect();
    if !loops.is_empty() {
        println!("\nStruggle loops (a tool failing repeatedly within one request):");
        let mut loops = loops;
        loops.sort_by(|a, b| b.2.cmp(&a.2));
        for (run, tool, n) in loops.into_iter().take(15) {
            println!("  run {run}: {tool} failed {n}× in one request");
        }
    } else {
        println!("\nNo retry loops — when tools fail, the agent recovers in one shot.");
    }

    ExitCode::SUCCESS
}
