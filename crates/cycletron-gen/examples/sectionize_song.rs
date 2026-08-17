//! Sectionize a song's voices (fixed-length sections + dedup via pickRestart)
//! and report real character savings. Run:
//!   cargo run -p cycletron-gen --example sectionize_song -- file.strudel [L]

use cycletron_gen::mini::Mini;
use cycletron_gen::verify::validate_doc;
use cycletron_gen::{factor, song};

fn backtick_bodies(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = src.char_indices().peekable();
    while let Some((_, ch)) = it.next() {
        if ch == '`' {
            let mut s = String::new();
            for (_, c) in it.by_ref() {
                if c == '`' {
                    break;
                }
                s.push(c);
            }
            out.push(s);
        }
    }
    out
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: sectionize_song <file> [L]");
    let l: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);
    let src = std::fs::read_to_string(&path).expect("read");
    let wraps = [
        "s(\"{}\").gain(0.38)",
        "note(\"{}\").sound(\"sine\")",
        "note(\"{}\").sound(\"supersquare\")",
    ];

    for (t, body) in backtick_bodies(&src).into_iter().enumerate() {
        let trimmed = body.trim();
        let inner = trimmed
            .strip_prefix('<')
            .and_then(|s| s.strip_suffix('>'))
            .unwrap_or(trimmed);
        let bars: Vec<Mini> = factor::split_bars(inner)
            .into_iter()
            .map(Mini::atom)
            .collect();
        if bars.is_empty() {
            continue;
        }
        let wrap_tpl = wraps.get(t).unwrap_or(&"s(\"{}\")");
        let s = song::sectionize("mm", 144, &bars, l, |b| wrap_tpl.replace("{}", b));
        let doc = s.to_strudel();
        let orig_body = body.len();
        let new_doc = doc.len();
        let unique = s.sections.len();
        let n_sections = bars.len().div_ceil(l);
        let plays = validate_doc(&doc).is_ok();
        println!(
            "track {}: {} bars → {} sections of {l}, {} unique  |  body {} → doc {} chars ({}% smaller)  [plays: {}]",
            t + 1,
            bars.len(),
            n_sections,
            unique,
            orig_body,
            new_doc,
            if orig_body > 0 {
                100 * orig_body.saturating_sub(new_doc) / orig_body
            } else {
                0
            },
            plays
        );
        if t == 0 {
            println!("--- drum track, sectionized ---\n{doc}");
        }
    }
}
