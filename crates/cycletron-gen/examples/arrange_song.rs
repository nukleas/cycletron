//! Re-Pair → nested cost-aware arrange. Run:
//!   cargo run -p cycletron-gen --example arrange_song -- file.strudel
use cycletron_gen::{factor, repair};
use cycletron_gen::mini::Mini;
use cycletron_gen::verify::{docs_equivalent, validate_doc};

fn backtick_bodies(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = src.char_indices().peekable();
    while let Some((_, ch)) = it.next() {
        if ch == '`' { let mut s = String::new();
            for (_, c) in it.by_ref() { if c == '`' { break } s.push(c); } out.push(s); }
    }
    out
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: arrange_song <file>");
    let src = std::fs::read_to_string(&path).expect("read");
    let wraps: [&dyn Fn(&str)->String; 3] = [
        &|b| format!("s(\"{b}\")"),
        &|b| format!("note(\"{b}\").sound(\"sine\")"),
        &|b| format!("note(\"{b}\").sound(\"supersquare\")"),
    ];
    let (mut ot, mut nt) = (0usize, 0usize);
    for (t, body) in backtick_bodies(&src).into_iter().enumerate() {
        let trimmed = body.trim();
        let inner = trimmed.strip_prefix('<').and_then(|s| s.strip_suffix('>')).unwrap_or(trimmed);
        let bars: Vec<Mini> = factor::split_bars(inner).into_iter().map(Mini::atom).collect();
        if bars.is_empty() { continue; }
        let wrap = wraps.get(t).copied().unwrap_or(&wraps[0]);
        let g = repair::repair(&bars);
        let naive = wrap(&Mini::Alt(bars.clone()).emit());
        // sweep min_span, keep the smallest that is verified lossless
        let mut best: Option<(usize, String)> = Some((naive.len(), naive.clone()));
        for span in 2..=16 {
            let expr = g.to_arrange_nested(wrap, span, "p");
            let cdoc = format!("setbpm(144);\n{expr}");
            let ndoc = format!("setbpm(144);\n{naive}");
            if docs_equivalent(&cdoc, &ndoc, bars.len()).unwrap_or(false)
                && best.as_ref().map_or(true, |(l, _)| expr.len() < *l) {
                best = Some((expr.len(), expr));
            }
        }
        let (len, expr) = best.expect("some lossless encoding");
        let plays = validate_doc(&format!("setbpm(144);\n{expr}")).is_ok();
        ot += naive.len(); nt += len;
        println!("track {}: {} bars | {} → {} chars ({}% smaller) [plays:{}]",
            t+1, bars.len(), naive.len(), len,
            100*naive.len().saturating_sub(len)/naive.len().max(1), plays);
        if t == 0 { println!("--- drums ---\n{expr}\n"); }
    }
    println!("TOTAL: {} → {} chars ({}% smaller)", ot, nt, 100*ot.saturating_sub(nt)/ot.max(1));
}
