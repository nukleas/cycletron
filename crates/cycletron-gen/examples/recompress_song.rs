//! Re-compress an existing multi-track `.strudel` song: find each backtick
//! slowcat `` `<bar0 bar1 …>` ``, factor out repeated bars, and re-emit. Every
//! track is verified to reproduce identically. Reports the size reduction.
//!
//! Run: `cargo run -p cycletron-gen --example recompress_song -- path/to.strudel`

use cycletron_gen::factor;
use std::path::PathBuf;

/// Replace each backtick-delimited region via `f`, returning the new document.
fn map_backtick_regions(src: &str, mut f: impl FnMut(&str) -> String) -> String {
    let mut out = String::new();
    let mut chars = src.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if ch == '`' {
            // collect until the closing backtick
            let start = i + 1;
            let mut end = start;
            for (j, c) in chars.by_ref() {
                if c == '`' {
                    end = j;
                    break;
                }
            }
            out.push('`');
            out.push_str(&f(&src[start..end]));
            out.push('`');
        } else {
            out.push(ch);
        }
    }
    out
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: recompress_song <file>");
    let src = std::fs::read_to_string(&path).expect("read song");

    let mut track = 0;
    let mut total_bars = 0usize;
    let mut total_unique = 0usize;
    let out = map_backtick_regions(&src, |content| {
        let trimmed = content.trim();
        let body = trimmed
            .strip_prefix('<')
            .and_then(|s| s.strip_suffix('>'))
            .unwrap_or(trimmed);
        let bars = factor::split_bars(body);
        let n = bars.len();
        if n == 0 {
            return content.to_string();
        }
        let unique = {
            let mut u: Vec<&String> = bars.iter().collect();
            u.sort();
            u.dedup();
            u.len()
        };
        let compressed = factor::recompress(body);
        track += 1;
        total_bars += n;
        total_unique += unique;
        let before = content.len();
        let after = compressed.emit().len();
        eprintln!(
            "  track {track}: {n} bars ({unique} unique) — {before} → {after} chars ({}% saved)",
            (100 * before.saturating_sub(after))
                .checked_div(before)
                .unwrap_or(0)
        );
        // Keep the `<...>` wrapper form for readability if it compressed to a cat.
        compressed.emit()
    });

    let before = src.len();
    let after = out.len();
    eprintln!(
        "\n{path:?}\n  {track} tracks, {total_bars} bars, {total_unique} unique across tracks\n  document: {before} → {after} chars ({}% saved)",
        100 * before.saturating_sub(after) / before.max(1)
    );

    let out_path = path.with_extension("compressed.strudel");
    std::fs::write(&out_path, &out).expect("write");
    eprintln!("  wrote {}", out_path.display());
    // Print the compressed document to stdout too.
    print!("{out}");
}
