//! Melody generators — pure functions over scale *degrees*.
//!
//! Everything here returns `Vec<i32>` degree sequences (or transforms thereof).
//! Lower them to notes with [`crate::scale::Scale::to_mini`], so the result is
//! guaranteed diatonic. Generators are deterministic — the "random" walk is a
//! seeded LCG — so the same inputs always produce the same phrase (reproducible
//! corpus, no `Math.random`).

/// A scalar run: `len` notes from `start`, stepping `step` degrees each time.
/// `run(0, 8, 1)` walks up the scale; `run(7, 8, -1)` walks down.
pub fn run(start: i32, len: usize, step: i32) -> Vec<i32> {
    (0..len as i32).map(|i| start + i * step).collect()
}

/// Direction for an arpeggio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Up,
    Down,
    UpDown,
}

/// Arpeggiate `chord_degrees` (degrees relative to the scale, e.g. `[0,2,4]` for
/// a triad) across `octaves`, in the given direction. `scale_len` is the mode's
/// notes-per-octave (so an octave jump is `+scale_len` degrees).
pub fn arpeggio(chord_degrees: &[i32], octaves: usize, scale_len: i32, dir: Dir) -> Vec<i32> {
    let mut up: Vec<i32> = Vec::new();
    for o in 0..octaves as i32 {
        for &d in chord_degrees {
            up.push(d + o * scale_len);
        }
    }
    match dir {
        Dir::Up => up,
        Dir::Down => up.into_iter().rev().collect(),
        Dir::UpDown => {
            let mut v = up.clone();
            // append the descent without repeating the top or bottom note
            v.extend(up.into_iter().rev().skip(1).take_while(|_| true));
            // drop the final element so the phrase doesn't repeat the low note
            v.pop();
            v
        }
    }
}

/// Deterministic in-scale random walk. Seeded LCG; each step moves at most
/// `max_step` degrees and is clamped to `[lo, hi]`. Same seed → same melody.
pub fn walk(seed: u64, len: usize, start: i32, max_step: i32, lo: i32, hi: i32) -> Vec<i32> {
    let mut state = seed ^ 0x9e3779b97f4a7c15;
    let mut deg = start.clamp(lo, hi);
    let span = 2 * max_step + 1;
    let mut out = Vec::with_capacity(len);
    for _ in 0..len {
        out.push(deg);
        // LCG (Knuth's MMIX constants), take high bits for the step.
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let step = ((state >> 33) as i64).rem_euclid(span as i64) as i32 - max_step;
        deg = (deg + step).clamp(lo, hi);
    }
    out
}

/// Retrograde: play the motif backwards.
pub fn retrograde(motif: &[i32]) -> Vec<i32> {
    motif.iter().rev().copied().collect()
}

/// Melodic inversion about an axis degree: each degree reflects to `2*axis - d`.
pub fn invert(motif: &[i32], axis: i32) -> Vec<i32> {
    motif.iter().map(|&d| 2 * axis - d).collect()
}

/// Transpose a motif by `by` scale degrees (diatonic transposition).
pub fn transpose(motif: &[i32], by: i32) -> Vec<i32> {
    motif.iter().map(|&d| d + by).collect()
}

/// Sequence a motif through several diatonic transpositions, concatenated —
/// e.g. `sequence(&[0,1,2], &[0, 2, 4])` states the motif on degrees 0, then 2,
/// then 4. The bread-and-butter of melodic development.
pub fn sequence(motif: &[i32], offsets: &[i32]) -> Vec<i32> {
    offsets.iter().flat_map(|&o| transpose(motif, o)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_ascends_and_descends() {
        assert_eq!(run(0, 4, 1), [0, 1, 2, 3]);
        assert_eq!(run(7, 4, -2), [7, 5, 3, 1]);
    }

    #[test]
    fn arpeggio_shapes() {
        assert_eq!(arpeggio(&[0, 2, 4], 1, 7, Dir::Up), [0, 2, 4]);
        assert_eq!(arpeggio(&[0, 2, 4], 2, 7, Dir::Up), [0, 2, 4, 7, 9, 11]);
        assert_eq!(arpeggio(&[0, 2, 4], 1, 7, Dir::Down), [4, 2, 0]);
        // updown: up then back down without repeating top/bottom
        assert_eq!(arpeggio(&[0, 2, 4], 1, 7, Dir::UpDown), [0, 2, 4, 2]);
    }

    #[test]
    fn walk_is_deterministic_and_bounded() {
        let a = walk(42, 16, 0, 2, -3, 7);
        let b = walk(42, 16, 0, 2, -3, 7);
        assert_eq!(a, b, "same seed → same walk");
        assert!(a.iter().all(|&d| (-3..=7).contains(&d)), "stays in bounds");
        // steps never exceed max_step
        assert!(a.windows(2).all(|w| (w[1] - w[0]).abs() <= 2));
    }

    #[test]
    fn motif_transforms() {
        let m = [0, 1, 3];
        assert_eq!(retrograde(&m), [3, 1, 0]);
        assert_eq!(invert(&m, 0), [0, -1, -3]);
        assert_eq!(transpose(&m, 4), [4, 5, 7]);
        assert_eq!(sequence(&m, &[0, 2]), [0, 1, 3, 2, 3, 5]);
    }
}
