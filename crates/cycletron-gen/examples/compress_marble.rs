//! Produce a fully compressed, playable copy of a multi-track song and verify
//! it plays identically to the original.
//!   cargo run -p cycletron-gen --example compress_marble -- in.strudel out.strudel

use cycletron_gen::mini::Mini;
use cycletron_gen::verify::docs_equivalent;
use cycletron_gen::{factor, repair};

struct Track {
    comment: String,
    kind: String, // "s" or "note"
    body: String, // slowcat body between < >
    suffix: String, // ".sound(...).gain(...)..."
}

/// Parse `setcpm(...)` header + `$:` tracks, each `KIND(`<body>`)SUFFIX`.
fn parse(src: &str) -> (String, Vec<Track>) {
    let header_end = src.find("$:").unwrap_or(src.len());
    let setcpm = src[..header_end]
        .lines()
        .find(|l| l.trim_start().starts_with("setcpm") || l.trim_start().starts_with("setbpm") || l.trim_start().starts_with("setcps"))
        .unwrap_or("setcpm(36)")
        .trim()
        .to_string();

    let mut tracks = Vec::new();
    for chunk in src.split("$:").skip(1) {
        let kind = if chunk.trim_start().starts_with("note") { "note" } else { "s" };
        let Some(open) = chunk.find('`') else { continue };
        let Some(close_rel) = chunk[open + 1..].find('`') else { continue };
        let close = open + 1 + close_rel;
        let raw_body = chunk[open + 1..close].trim();
        let body = raw_body.strip_prefix('<').and_then(|s| s.strip_suffix('>')).unwrap_or(raw_body).to_string();
        // suffix: after the closing backtick + ")" up to end of that line
        let after = &chunk[close + 1..];
        let suffix_line = after.lines().next().unwrap_or("");
        let suffix = suffix_line.trim_start().strip_prefix(')').unwrap_or(suffix_line).trim().to_string();
        // trailing comment (belongs to the NEXT track) → keep for it
        let comment = after
            .lines()
            .find(|l| l.trim_start().starts_with("// Track"))
            .unwrap_or("")
            .trim()
            .to_string();
        tracks.push(Track { comment, kind: kind.into(), body, suffix });
    }
    (setcpm, tracks)
}

/// Depth-aware split of an `arrange(...)` body into its top-level `[n, x]`
/// sections (commas at bracket/paren/quote depth 0).
fn split_sections(inner: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (mut depth, mut in_str) = (0i32, false);
    let mut cur = String::new();
    let mut prev = ' ';
    for ch in inner.chars() {
        match ch {
            '"' | '`' if prev != '\\' => in_str = !in_str,
            '[' | '(' | '<' if !in_str => depth += 1,
            ']' | ')' | '>' if !in_str => depth -= 1,
            ',' if depth == 0 && !in_str => {
                out.push(cur.trim().to_string());
                cur.clear();
                prev = ch;
                continue;
            }
            _ => {}
        }
        cur.push(ch);
        prev = ch;
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Reflow `arrange(...)SUFFIX` into a multi-line song map with cycle-range
/// comments. Pure formatting — no semantic change.
fn pretty_arrange(expr: &str) -> String {
    let Some(open) = expr.find("arrange(") else { return expr.to_string() };
    // find matching close paren for this arrange(
    let bytes = expr.as_bytes();
    let mut depth = 0i32;
    let mut close = expr.len();
    for (i, &b) in bytes.iter().enumerate().skip(open + 7) {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    close = i;
                    break;
                }
            }
            _ => {}
        }
    }
    let inner = &expr[open + 8..close];
    let suffix = &expr[close + 1..]; // e.g. .gain(0.38)
    let sections = split_sections(inner);
    let body = sections
        .iter()
        .map(|s| format!("  {s}"))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("arrange(\n{body}\n){suffix}")
}

fn main() {
    let inp = std::env::args().nth(1).expect("input path");
    let outp = std::env::args().nth(2).expect("output path");
    let src = std::fs::read_to_string(&inp).expect("read");
    let (setcpm, tracks) = parse(&src);

    let prefixes = ["d", "b", "m", "n", "o"];
    let mut bindings = String::new();
    let mut track_exprs = Vec::new();
    let mut comments = vec!["// Track 1: Drum Kit".to_string()];
    let mut total_bars = 0;

    for (t, tr) in tracks.iter().enumerate() {
        if !tr.comment.is_empty() {
            comments.push(tr.comment.clone());
        }
        let bars: Vec<Mini> = factor::split_bars(&tr.body).into_iter().map(Mini::atom).collect();
        total_bars += bars.len();
        let kind = tr.kind.clone();
        let wrap = move |b: &str| format!("{kind}(\"{b}\")");
        let g = repair::repair(&bars);
        let naive = wrap(&Mini::Alt(bars.clone()).emit());

        // sweep min_span; keep smallest lossless (vs the whole original doc is
        // expensive, so verify each voice against its own naive slowcat).
        let ndoc = format!("{setcpm}\n{naive}");
        let mut best = (naive.len(), naive.clone(), 0usize);
        for span in 2..=16 {
            let expr = g.to_arrange_nested(&wrap, span, prefixes[t.min(4)]);
            let cdoc = format!("{setcpm}\n{expr}");
            if docs_equivalent(&cdoc, &ndoc, bars.len()).unwrap_or(false) && expr.len() < best.0 {
                let n_defs = expr.matches("let ").count();
                best = (expr.len(), expr, n_defs);
            }
        }
        // split bindings (let …) from the final arrange(...) expression
        let (defs, arr) = best.1.rsplit_once("\narrange(").map(|(d, a)| (d.to_string(), format!("arrange({a}"))).unwrap_or((String::new(), best.1.clone()));
        if !defs.is_empty() {
            bindings.push_str(&defs);
            bindings.push('\n');
        }
        let suffixed = format!("{}{}", arr, if tr.suffix.is_empty() { String::new() } else { format!(".{}", tr.suffix.trim_start_matches('.')) });
        track_exprs.push(format!("$: {}", pretty_arrange(&suffixed)));
        eprintln!("track {}: {} bars, {} phrase defs, {} chars", t + 1, bars.len(), best.2, best.0);
    }

    // Assemble the compressed document.
    let mut doc = String::new();
    doc.push_str(&format!("{setcpm}\n\n"));
    if !bindings.is_empty() {
        doc.push_str("// recurring phrases, defined once\n");
        doc.push_str(&bindings);
        doc.push('\n');
    }
    for (i, expr) in track_exprs.iter().enumerate() {
        if let Some(c) = comments.get(i) {
            doc.push_str(&format!("{c}\n"));
        }
        doc.push_str(expr);
        doc.push_str("\n\n");
    }

    // Whole-song lossless check + size report.
    let equal = docs_equivalent(&src, &doc, 128).unwrap_or(false);
    std::fs::write(&outp, &doc).expect("write");
    eprintln!(
        "\n{} bars total | {} → {} chars ({}% smaller) | lossless vs original: {}",
        total_bars,
        src.len(),
        doc.len(),
        100 * src.len().saturating_sub(doc.len()) / src.len().max(1),
        equal
    );
    eprintln!("wrote {outp}");
}
