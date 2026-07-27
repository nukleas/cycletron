//! Step-aligned drum grids.
//!
//! A [`Grid`] is `steps` columns wide; every lane is a boolean mask of exactly
//! that width. Lowering to mini-notation produces one comma-stacked sequence
//! per lane, all with the same slot count — so the lanes *cannot* drift against
//! each other (the failure mode of hand-written strings like
//! `"bd ~ ~ [bd bd] ~ ~ bd ~, ~ ~ cp ~ [~ cp] ~ cp ~ ~"`, where an 8-slot kick
//! fights a 9-slot clap). Alignment is a property of the type, not a hope.

use crate::mini::Mini;

/// One percussion voice on the grid: a sound name and a per-step hit count.
/// `0` = rest, `1` = a single hit, `n ≥ 2` = an n-tuple ratchet (the slot
/// subdivides into `n` even hits — trap hat rolls, footwork stutters).
#[derive(Clone, Debug)]
pub struct Lane {
    pub sound: String,
    pub hits: Vec<u8>,
}

/// A fixed-resolution percussion grid.
#[derive(Clone, Debug)]
pub struct Grid {
    steps: usize,
    lanes: Vec<Lane>,
}

impl Grid {
    /// A grid `steps` columns wide (e.g. 16 for a 16th-note bar).
    pub fn new(steps: usize) -> Self {
        assert!(steps > 0, "grid needs at least one step");
        Grid {
            steps,
            lanes: Vec::new(),
        }
    }

    pub fn steps(&self) -> usize {
        self.steps
    }

    pub fn lanes(&self) -> &[Lane] {
        &self.lanes
    }

    /// Add a lane with hits on the given step indices (out-of-range indices are
    /// ignored — a step count is authoritative).
    pub fn hit(mut self, sound: &str, positions: &[usize]) -> Self {
        let mut hits = vec![0u8; self.steps];
        for &p in positions {
            if p < self.steps {
                hits[p] = 1;
            }
        }
        self.lanes.push(Lane {
            sound: sound.to_string(),
            hits,
        });
        self
    }

    /// Add a lane from a raw per-step count vector (must be exactly `steps`
    /// wide) — the escape hatch the spec composer uses after swing-splitting
    /// an archetype lane.
    pub fn lane(mut self, sound: &str, counts: Vec<u8>) -> Self {
        assert_eq!(
            counts.len(),
            self.steps,
            "lane width must equal grid steps"
        );
        self.lanes.push(Lane {
            sound: sound.to_string(),
            hits: counts,
        });
        self
    }

    /// Add a lane of ratchets: at each `(pos, div)` the slot subdivides into
    /// `div` even hits (`div = 3` → an `x*3` roll in that 16th). `div == 0` or
    /// an out-of-range `pos` is ignored.
    pub fn ratchet(mut self, sound: &str, rolls: &[(usize, u8)]) -> Self {
        let mut hits = vec![0u8; self.steps];
        for &(p, div) in rolls {
            if p < self.steps && div > 0 {
                hits[p] = div;
            }
        }
        self.lanes.push(Lane {
            sound: sound.to_string(),
            hits,
        });
        self
    }

    /// Add a lane that hits every `interval`-th step starting at `offset`
    /// (e.g. `every("hh", 1, 0)` = straight 16ths; `every("oh", 4, 2)` = the
    /// offbeat open hats).
    pub fn every(mut self, sound: &str, interval: usize, offset: usize) -> Self {
        assert!(interval > 0, "interval must be > 0");
        let hits: Vec<u8> =
            (0..self.steps).map(|i| u8::from(i >= offset && (i - offset) % interval == 0)).collect();
        self.lanes.push(Lane {
            sound: sound.to_string(),
            hits,
        });
        self
    }

    /// Add a Euclidean lane: `k` pulses spread over `n` slots, tiled across the
    /// grid. `n` must divide `steps` so the euclid pattern lands on grid
    /// columns (keeping the lane aligned with the rest).
    pub fn euclid(mut self, sound: &str, k: usize, n: usize) -> Self {
        assert!(
            n > 0 && self.steps % n == 0,
            "euclid n ({n}) must divide grid steps ({})",
            self.steps
        );
        let cell = bjorklund(k, n);
        let reps = self.steps / n;
        let mut hits = Vec::with_capacity(self.steps);
        for _ in 0..reps {
            hits.extend(cell.iter().map(|&b| u8::from(b)));
        }
        self.lanes.push(Lane {
            sound: sound.to_string(),
            hits,
        });
        self
    }

    /// True if any lane fires at least once (a silent grid fails corpus-check).
    pub fn has_onsets(&self) -> bool {
        self.lanes.iter().any(|l| l.hits.iter().any(|&c| c > 0))
    }

    /// Lower one lane to a `Mini` sequence of atoms/rests/ratchets
    /// (length == steps).
    pub(crate) fn lane_to_mini(lane: &Lane) -> Mini {
        // Collapse an all-single-hit lane to `sound*steps` for readability.
        if lane.hits.iter().all(|&c| c == 1) {
            return Mini::Fast(Box::new(Mini::atom(&lane.sound)), lane.hits.len() as u32);
        }
        Mini::Seq(
            lane.hits
                .iter()
                .map(|&count| match count {
                    0 => Mini::Rest,
                    1 => Mini::atom(&lane.sound),
                    n => Mini::Fast(Box::new(Mini::atom(&lane.sound)), n as u32),
                })
                .collect(),
        )
    }

    /// Lower the whole grid to a comma-stacked [`Mini`] (all lanes same width).
    pub fn to_mini(&self) -> Mini {
        Mini::Stack(self.lanes.iter().map(Self::lane_to_mini).collect())
    }

    /// The mini-notation string for use inside `s("…")`.
    pub fn to_string(&self) -> String {
        self.to_mini().emit()
    }
}

/// Bjorklund's algorithm: distribute `k` pulses as evenly as possible over `n`
/// steps. Returns a length-`n` boolean mask. `k >= n` fills every step; `k == 0`
/// is empty.
pub fn bjorklund(k: usize, n: usize) -> Vec<bool> {
    if n == 0 {
        return Vec::new();
    }
    let k = k.min(n);
    if k == 0 {
        return vec![false; n];
    }
    // Standard Bjorklund via the bucket/remainder construction.
    let mut groups: Vec<Vec<bool>> = (0..n).map(|i| vec![i < k]).collect();
    // Reorder so all the "true" singletons come first, then the "false" ones.
    groups.sort_by_key(|g| !g[0]);
    let mut a = k; // number of true-groups
    let mut b = n - k; // number of false-groups
    while b > 1 {
        let m = a.min(b);
        // Append one tail group onto each of the first `m` head groups.
        let tail: Vec<Vec<bool>> = groups.split_off(groups.len() - (if a >= b { b } else { a }).min(m));
        for (i, t) in tail.into_iter().enumerate() {
            groups[i].extend(t);
        }
        let new_a = m;
        let new_b = a.max(b) - m;
        a = new_a;
        b = new_b;
        if a <= 1 {
            break;
        }
    }
    groups.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanes_share_step_count() {
        let g = Grid::new(16)
            .hit("bd", &[0, 10])
            .hit("sd", &[4, 12])
            .every("hh", 1, 0);
        // Every lane mask is exactly 16 wide.
        assert!(g.lanes().iter().all(|l| l.hits.len() == 16));
        let s = g.to_string();
        // all-on hats collapse to hh*16; kick/snare are explicit 16-slot seqs.
        assert!(s.contains("hh*16"), "got: {s}");
        assert!(s.contains("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd"), "got: {s}");
    }

    #[test]
    fn ratchet_lanes_subdivide_slots() {
        let g = Grid::new(16).every("hh", 2, 0).ratchet("hh", &[(7, 3), (15, 4)]);
        let s = g.to_string();
        assert!(s.contains("hh*3"), "got: {s}");
        assert!(s.contains("hh*4"), "got: {s}");
        assert!(g.lanes().iter().all(|l| l.hits.len() == 16));
    }

    #[test]
    fn bjorklund_classic_shapes() {
        // (3,8) → the tresillo x..x..x.
        assert_eq!(
            bjorklund(3, 8),
            vec![true, false, false, true, false, false, true, false]
        );
        // (5,8) → x.xx.xx.
        assert_eq!(bjorklund(5, 8).iter().filter(|&&b| b).count(), 5);
        assert_eq!(bjorklund(0, 4), vec![false; 4]);
        assert_eq!(bjorklund(4, 4), vec![true; 4]);
    }
}
