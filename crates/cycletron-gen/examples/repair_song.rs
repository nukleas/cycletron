//! Analyze a multi-track song with Re-Pair: how much recurring phrase structure
//! is there? Run: cargo run -p cycletron-gen --example repair_song -- file.strudel

use cycletron_gen::{factor, repair};
use cycletron_gen::mini::Mini;

fn backtick_bodies(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = src.char_indices().peekable();
    while let Some((_, ch)) = it.next() {
        if ch == '`' {
            let mut s = String::new();
            for (_, c) in it.by_ref() { if c == '`' { break } s.push(c); }
            out.push(s);
        }
    }
    out
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: repair_song <file>");
    let src = std::fs::read_to_string(&path).expect("read");
    for (t, body) in backtick_bodies(&src).into_iter().enumerate() {
        let trimmed = body.trim();
        let inner = trimmed.strip_prefix('<').and_then(|s| s.strip_suffix('>')).unwrap_or(trimmed);
        let bars: Vec<Mini> = factor::split_bars(inner).into_iter().map(Mini::atom).collect();
        if bars.is_empty() { continue; }
        let g = repair::repair(&bars);
        let ok = g.expand() == bars;
        let mut reused = g.reused_rules();
        reused.sort_by_key(|&(_, c, len)| std::cmp::Reverse((len * c, c)));
        println!("track {}: {} bars, {} unique, {} rules → grammar {} symbols  [lossless: {}]",
            t + 1, bars.len(), g.terminals.len(), g.rules.len(), g.size(), ok);
        for (i, count, len) in reused.iter().take(4) {
            println!("    phrase R{i}: {len}-bar block, used {count}×  (covers {} bars)", len * count);
        }
    }
}
