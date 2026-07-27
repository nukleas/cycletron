//! CLI to evaluate strudel DSL code and output Haps as JSON.
//! Handles both full DSL (note("c4").s("sine").fast(2)) and mini notation (bd sd).
//!
//! Usage: dsl-eval 'note("c4 e4 g4").s("sine")' [--cycles 1]
//!        dsl-eval --file pattern.strudel [--cycles 1]

use serde::Serialize;
use std::env;
use std::fs;

#[derive(Serialize)]
struct HapJson {
    whole: Option<[f64; 2]>,
    part: [f64; 2],
    value: serde_json::Value,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut code = String::new();
    let mut cycles: i32 = 1;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--cycles" => {
                i += 1;
                cycles = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(1);
            }
            "--file" => {
                i += 1;
                if let Some(path) = args.get(i) {
                    code = fs::read_to_string(path).unwrap_or_else(|e| {
                        eprintln!("Error reading {path}: {e}");
                        std::process::exit(1);
                    });
                }
            }
            s if !s.starts_with("--") => {
                code = s.to_string();
            }
            _ => {}
        }
        i += 1;
    }

    if code.is_empty() {
        eprintln!("Usage: dsl-eval 'pattern code' [--cycles N]");
        std::process::exit(1);
    }

    let pattern = eval_code(&code);
    let haps = pattern.query_arc(0i32, cycles);

    let json_haps: Vec<HapJson> = haps
        .iter()
        .map(|h| {
            let whole = h.whole.as_ref().map(|w| {
                [frac_to_f64(&w.begin), frac_to_f64(&w.end)]
            });
            let part = [frac_to_f64(&h.part.begin), frac_to_f64(&h.part.end)];
            let ctx: std::collections::HashMap<_, _> = h.context.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            let value = value_to_json(&h.value, &ctx);
            HapJson { whole, part, value }
        })
        .collect();

    println!("{}", serde_json::to_string_pretty(&json_haps).unwrap());
}

fn eval_code(code: &str) -> strudel_core::Pattern {
    // If code looks like DSL (has quotes, dots, or parens following identifiers),
    // try DSL first. Otherwise try mini notation first.
    let looks_like_dsl = code.contains('"') || code.contains('\'') || code.contains(".(");

    if looks_like_dsl {
        // Try DSL eval (handles method chains, function calls)
        if let Ok(output) = strudel_dsl::eval_dsl_with_tempo(code) {
            return output.pattern;
        }
        // Try strudel file parse (multi-track with directives)
        if let Ok(file) = strudel_dsl::parse_strudel_file(code) {
            if let Ok(evaled) = strudel_dsl::evaluate_file(&file) {
                return evaled.pattern;
            }
        }
    }

    // Try mini notation
    if let Ok(ast) = strudel_mini::parse(code) {
        if let Ok(pat) = strudel_mini::evaluate(&ast) {
            // Check it actually produces events
            let test = pat.query_arc(0i32, 1i32);
            if !test.is_empty() {
                return pat;
            }
        }
    }

    // Fall back to DSL if we haven't tried it yet
    if !looks_like_dsl {
        if let Ok(output) = strudel_dsl::eval_dsl_with_tempo(code) {
            return output.pattern;
        }
        if let Ok(file) = strudel_dsl::parse_strudel_file(code) {
            if let Ok(evaled) = strudel_dsl::evaluate_file(&file) {
                return evaled.pattern;
            }
        }
    }

    let err = match strudel_dsl::eval_dsl_with_tempo(code) {
        Err(e) => e.to_string(),
        Ok(_) => "unknown evaluation error".to_string(),
    };
    eprintln!("Error: {err}");
    std::process::exit(2);
}

fn frac_to_f64(f: &strudel_core::Fraction) -> f64 {
    (f.to_f64() * 1_000_000.0).round() / 1_000_000.0
}

fn value_to_json(
    val: &strudel_core::Value,
    ctx: &std::collections::HashMap<strudel_core::ContextKey, strudel_core::Value>,
) -> serde_json::Value {
    use strudel_core::Value;

    let mut obj = serde_json::Map::new();

    // Extract main value
    match val {
        Value::String(s) => { obj.insert("s".into(), serde_json::Value::String(s.as_str().to_string())); }
        Value::Number(n) => { obj.insert("n".into(), serde_json::json!(round6(*n))); }
        _ => {}
    }

    // Extract controls from context
    for (k, v) in ctx {
        let key = format!("{k:?}").to_lowercase();
        if key == "locations" || key == "tags" { continue; }
        match v {
            Value::Number(n) => { obj.insert(key, serde_json::json!(round6(*n))); }
            Value::String(s) => { obj.insert(key, serde_json::Value::String(s.as_str().to_string())); }
            _ => {}
        }
    }

    serde_json::Value::Object(obj)
}

fn round6(n: f64) -> f64 {
    (n * 1_000_000.0).round() / 1_000_000.0
}
