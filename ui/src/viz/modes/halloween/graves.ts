/** Deterministic slot assignment shared by the graveyard's rows and the house's floors. */

export const COLS = 12;

/**
 * The slot a new arrival takes: its pitch slot, else the nearest free one,
 * stepping outward with the first side from the seed; -1 when the row is
 * full. `taken` marks the slots already held over the arrival's lifetime.
 */
export function graveFor(col: number, seed: number, taken: Uint8Array): number {
    const first = (seed & 1) === 0 ? 1 : -1;
    for (let d = 0; d < taken.length; d++) {
        for (const side of d === 0 ? [0] : [first, -first]) {
            const c = col + side * d;
            if (c >= 0 && c < taken.length && !taken[c]) return c;
        }
    }
    return -1;
}
