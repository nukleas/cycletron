//! Round-trip verification: emit → parse-back → check the events.
//!
//! The generators lower musical intent to a string. This module runs that
//! string through the *real* strudel-rs mini-notation parser+evaluator and
//! reads the events back out, so we can assert the pattern we built is the
//! pattern that plays. This is the "reverse of strudel" loop closing on itself:
//! if `emit(intent)` and `parse(emit(intent))` disagree, the generator is wrong.

use crate::grid::Grid;

/// Onset fractions (event start times in `[0,1)`) of a mini-notation string,
/// as produced by the strudel-rs evaluator. Sorted ascending, de-duplicated.
pub fn onsets(mini_str: &str) -> Result<Vec<f64>, String> {
    let ast = strudel_mini::parse(mini_str).map_err(|e| format!("parse: {e}"))?;
    let pat = strudel_mini::evaluate(&ast).map_err(|e| format!("eval: {e}"))?;
    let mut xs: Vec<f64> = pat
        .query_arc(0i32, 1i32)
        .into_iter()
        // keep event *onsets* (whole starts inside this cycle), not fragments
        .filter(|h| h.whole.is_some_and(|w| w.begin == h.part.begin))
        .map(|h| h.part.begin.to_f64())
        .collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    Ok(xs)
}

/// Validate a whole `.strudel` document the way `corpus-check`/`validate_code`
/// does: run it through the DSL file parser + evaluator, and require at least
/// one event in cycle 0 (a silent pattern is a generation bug). This lets a
/// composer confirm its output plays before it is ever written to disk.
pub fn validate_doc(code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err("empty document".to_string());
    }
    // Structural file → standalone DSL → mini-notation (strudel-rs cascade).
    let out = strudel_dsl::execute(code).map_err(|e| e.to_string())?;
    require_haps(&out.pattern)
}

fn require_haps(pattern: &strudel_core::Pattern) -> Result<(), String> {
    if pattern.query_arc(0i32, 1i32).is_empty() {
        Err("document emits no events in cycle 0 — silent".to_string())
    } else {
        Ok(())
    }
}

/// Note tokens of a mini-notation string, in time order, as the strudel-rs
/// evaluator sees them (e.g. `"c4 eb4 g4"` → `["c4","d#4","g4"]`). String
/// values only; non-string events are skipped.
pub fn note_tokens(mini_str: &str) -> Result<Vec<String>, String> {
    let ast = strudel_mini::parse(mini_str).map_err(|e| format!("parse: {e}"))?;
    let pat = strudel_mini::evaluate(&ast).map_err(|e| format!("eval: {e}"))?;
    let mut haps: Vec<_> = pat
        .query_arc(0i32, 1i32)
        .into_iter()
        .filter(|h| h.whole.is_some_and(|w| w.begin == h.part.begin))
        .collect();
    haps.sort_by(|a, b| a.part.begin.partial_cmp(&b.part.begin).unwrap());
    Ok(haps
        .iter()
        .filter_map(|h| h.value.as_string().map(str::to_string))
        .collect())
}

/// Evaluate a full `.strudel` document to its pattern (via the DSL file parser,
/// so `let` bindings + `arrange(...)` resolve).
fn eval_doc(doc: &str) -> Result<strudel_core::Pattern, String> {
    let file = strudel_dsl::parse_strudel_file(doc).map_err(|e| e.to_string())?;
    let out = strudel_dsl::evaluate_file(file).map_err(|e| e.to_string())?;
    Ok(out.pattern)
}

fn pat_cycle_sig(pat: &strudel_core::Pattern, cycle: i32) -> Vec<String> {
    let mut haps: Vec<_> = pat
        .query_arc(cycle, cycle + 1)
        .into_iter()
        .filter(|h| h.whole.is_some_and(|w| w.begin == h.part.begin))
        .collect();
    haps.sort_by(|a, b| a.part.begin.partial_cmp(&b.part.begin).unwrap());
    haps.iter()
        .map(|h| format!("{}@{:.4}", h.value, h.part.begin.to_f64() - f64::from(cycle)))
        .collect()
}

/// Do two documents produce identical events for every cycle in `0..cycles`?
/// The lossless proof for the arrange compressor: the compact `arrange(...)`
/// form must play exactly like the fully-expanded slowcat.
pub fn docs_equivalent(a: &str, b: &str, cycles: usize) -> Result<bool, String> {
    let pa = eval_doc(a)?;
    let pb = eval_doc(b)?;
    Ok((0..cycles as i32).all(|c| pat_cycle_sig(&pa, c) == pat_cycle_sig(&pb, c)))
}

/// A per-cycle event signature: `value@onset` for every onset in cycle `cycle`,
/// in time order. Uses `Value`'s Display (so numbers and note names both work),
/// giving a robust fingerprint for comparing two patterns cycle-by-cycle.
pub fn cycle_sig(mini_str: &str, cycle: i32) -> Result<Vec<String>, String> {
    let ast = strudel_mini::parse(mini_str).map_err(|e| format!("parse: {e}"))?;
    let pat = strudel_mini::evaluate(&ast).map_err(|e| format!("eval: {e}"))?;
    let mut haps: Vec<_> = pat
        .query_arc(cycle, cycle + 1)
        .into_iter()
        .filter(|h| h.whole.is_some_and(|w| w.begin == h.part.begin))
        .collect();
    haps.sort_by(|a, b| a.part.begin.partial_cmp(&b.part.begin).unwrap());
    Ok(haps
        .iter()
        .map(|h| format!("{}@{:.4}", h.value, h.part.begin.to_f64() - f64::from(cycle)))
        .collect())
}

/// Does `compressed` (a slowcat/pattern) reproduce `bars` when queried
/// cycle-by-cycle? This is the lossless guarantee for the compressor: cycle `i`
/// of the compressed form must equal bar `i` played on its own.
pub fn reproduces(bars: &[crate::mini::Mini], compressed: &crate::mini::Mini) -> bool {
    let cstr = compressed.emit();
    bars.iter().enumerate().all(|(i, bar)| {
        match (cycle_sig(&bar.emit(), 0), cycle_sig(&cstr, i as i32)) {
            (Ok(exp), Ok(got)) => exp == got,
            _ => false,
        }
    })
}

/// Verify that a lowered melody re-parses to exactly the intended notes, in
/// order. Closes the loop for melodic material the way [`verify_grid`] does for
/// drums.
pub fn verify_notes(expected: &[String], mini_str: &str) -> Result<(), String> {
    let got = note_tokens(mini_str)?;
    if got != expected {
        return Err(format!("note sequence drifted: intended {expected:?}, evaluator gave {got:?}"));
    }
    Ok(())
}

/// Verify that every lane of a [`Grid`] plays exactly where its mask says. For
/// each lane we emit just that lane (through the same lowering the grid uses),
/// parse it back, and compare the evaluator's onsets against the mask: a
/// single hit at step `i` lands at `i/steps`; a ratchet of `n` adds hits at
/// `i/steps + k/(steps·n)`. Returns the number of lanes checked on success.
pub fn verify_grid(grid: &Grid) -> Result<usize, String> {
    let steps = grid.steps() as f64;
    for (li, lane) in grid.lanes().iter().enumerate() {
        let mut expected: Vec<f64> = Vec::new();
        for (i, &count) in lane.hits.iter().enumerate() {
            for k in 0..count {
                expected.push(i as f64 / steps + k as f64 / (steps * count as f64));
            }
        }
        let lane_str = Grid::lane_to_mini(lane).emit();
        let got = onsets(&lane_str)?;
        if got.len() != expected.len()
            || got
                .iter()
                .zip(&expected)
                .any(|(a, b)| (a - b).abs() > 1e-6)
        {
            return Err(format!(
                "lane {li} ({}) drifted: intended {expected:?}, evaluator gave {got:?}",
                lane.sound
            ));
        }
    }
    Ok(grid.lanes().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onsets_match_placement() {
        // "bd ~ ~ bd" fires at 0 and 3/4.
        let xs = onsets("bd ~ ~ bd").unwrap();
        assert_eq!(xs.len(), 2);
        assert!((xs[0] - 0.0).abs() < 1e-9);
        assert!((xs[1] - 0.75).abs() < 1e-9);
    }

    #[test]
    fn generated_dnb_break_round_trips() {
        // A proper DnB two-step: kick on 1 and the "&" of 3, snare on 2 and 4,
        // hats on every 16th. Built on ONE 16-step grid → cannot misalign.
        let g = Grid::new(16)
            .hit("bd", &[0, 10])
            .hit("sd", &[4, 12])
            .every("hh", 1, 0);
        // The evaluator agrees with every lane's intended placement.
        assert_eq!(verify_grid(&g).unwrap(), 3);
        // And the whole grid is a legal, non-silent pattern.
        assert!(g.has_onsets());
        let ast = strudel_mini::parse(&g.to_string()).expect("stack parses");
        assert!(!strudel_mini::evaluate(&ast).unwrap().query_arc(0i32, 1i32).is_empty());
    }
}
