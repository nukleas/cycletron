//! Grammar-style compression: turn a per-cycle **bar sequence** into minimal
//! mini-notation by factoring out repeats.
//!
//! A voice in a song is a list of bars, one per cycle: `[a, a, b, a, a, b, …]`.
//! Written naively that is a long `<a a b a a b …>`. This module finds the
//! structure — the smallest repeating period, then run-length runs inside it —
//! and emits the compact form (`<a!2 b>`), but only the compact form that
//! *provably reproduces the original* (checked against the real evaluator, so a
//! `!`-in-slowcat quirk can never silently corrupt the result).

use crate::mini::Mini;
use crate::verify::reproduces;

/// The smallest period `p` such that `bars[i] == bars[i-p]` for all `i ≥ p`.
/// A slowcat of the first `p` bars loops to reproduce the whole sequence
/// (slowcat wraps, so the tail need not be a whole number of periods).
pub fn period(bars: &[Mini]) -> usize {
    let n = bars.len();
    if n == 0 {
        return 0;
    }
    (1..=n)
        .find(|&p| (p..n).all(|i| bars[i] == bars[i - p]))
        .unwrap_or(n)
}

/// Run-length encode a bar list: consecutive equal bars collapse to `bar!count`.
pub fn rle(bars: &[Mini]) -> Vec<Mini> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bars.len() {
        let mut j = i + 1;
        while j < bars.len() && bars[j] == bars[i] {
            j += 1;
        }
        let count = (j - i) as u32;
        out.push(if count == 1 {
            bars[i].clone()
        } else {
            Mini::Replicate(Box::new(bars[i].clone()), count)
        });
        i = j;
    }
    out
}

/// Factor a bar sequence into a single slowcat `Mini`, run-length compressed.
/// (May use `!`; call [`compress`] for the verified, fallback-safe version.)
pub fn slowcat(bars: &[Mini]) -> Mini {
    let p = period(bars).max(1);
    let folded = &bars[..p];
    if folded.len() == 1 {
        return folded[0].clone(); // one bar loops on its own — no `<>` needed
    }
    Mini::Alt(rle(folded))
}

/// Plain slowcat of the folded period — explicit bars, no `!` (the safe form).
fn slowcat_plain(bars: &[Mini]) -> Mini {
    let p = period(bars).max(1);
    let folded = &bars[..p];
    if folded.len() == 1 {
        folded[0].clone()
    } else {
        Mini::Alt(folded.to_vec())
    }
}

/// Compress a bar sequence to the smallest form that **provably reproduces it**.
/// Tries the run-length form; if the evaluator disagrees (e.g. `!` behaving
/// unexpectedly inside `< >`), falls back to the explicit slowcat. The result,
/// queried cycle-by-cycle, always equals the input bars.
pub fn compress(bars: &[Mini]) -> Mini {
    let rle_form = slowcat(bars);
    if reproduces(bars, &rle_form) {
        rle_form
    } else {
        slowcat_plain(bars)
    }
}

/// Split the body of a `< … >` slowcat into its top-level bars: whitespace at
/// bracket depth 0 separates cycles, while `[ ]`, `< >`, `{ }` groups and their
/// contents stay intact. `<- - [a b] c>` → `["-", "-", "[a b]", "c"]`.
pub fn split_bars(body: &str) -> Vec<String> {
    let mut bars = Vec::new();
    let mut depth: i32 = 0;
    let mut cur = String::new();
    for ch in body.chars() {
        match ch {
            '[' | '<' | '{' => {
                depth += 1;
                cur.push(ch);
            }
            ']' | '>' | '}' => {
                depth -= 1;
                cur.push(ch);
            }
            c if c.is_whitespace() && depth <= 0 => {
                if !cur.trim().is_empty() {
                    bars.push(cur.trim().to_string());
                }
                cur.clear();
            }
            c => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        bars.push(cur.trim().to_string());
    }
    bars
}

/// Recompress a verbose slowcat body (bars treated as opaque tokens): split into
/// bars, factor repeats, and return the compressed `Mini`. Verified against the
/// evaluator via [`compress`], so the result plays identically.
pub fn recompress(body: &str) -> Mini {
    let bars: Vec<Mini> = split_bars(body).into_iter().map(Mini::atom).collect();
    compress(&bars)
}

/// Compression ratio for reporting: naive `<b0 b1 … bn>` length vs the
/// compressed emit length (characters).
pub fn ratio(bars: &[Mini], compressed: &Mini) -> (usize, usize) {
    let naive = Mini::Alt(bars.to_vec()).emit().len();
    (naive, compressed.emit().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars(names: &[&str]) -> Vec<Mini> {
        names.iter().map(|s| Mini::atom(*s)).collect()
    }

    #[test]
    fn finds_period() {
        assert_eq!(period(&bars(&["a", "b", "a", "b", "a"])), 2);
        assert_eq!(period(&bars(&["a", "a", "a"])), 1);
        assert_eq!(period(&bars(&["a", "b", "c"])), 3);
    }

    #[test]
    fn all_same_bars_collapse_to_one() {
        // a voice that plays the same bar every cycle → just the bar
        let b = bars(&["bd", "bd", "bd", "bd"]);
        assert_eq!(compress(&b), Mini::atom("bd"));
    }

    #[test]
    fn periodic_folds_and_reproduces() {
        // [a a b a a b] → period 3 → <a!2 b>, and it round-trips
        let b = bars(&["c3", "c3", "e3", "c3", "c3", "e3"]);
        let c = compress(&b);
        assert!(reproduces(&b, &c), "compressed form must reproduce bars");
        // it is at least as short as the explicit period slowcat
        assert!(c.emit().len() <= Mini::Alt(bars(&["c3", "c3", "e3"])).emit().len());
    }

    #[test]
    fn non_repeating_is_left_intact() {
        let b = bars(&["c3", "e3", "g3", "b3"]);
        let c = compress(&b);
        assert!(reproduces(&b, &c));
    }
}
