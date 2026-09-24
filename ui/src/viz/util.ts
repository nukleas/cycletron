/** Shared math + color helpers for the ambient visualizer modes. */

export const TAU = Math.PI * 2;

/**
 * Beat envelope — sharp attack, fast decay across one beat. Takes a phase
 * value (cycles, not radians); returns 0..1. Snappy "drum hit" feel: ~30%
 * of the beat duration carries most of the energy, then it's flat.
 */
export function beatEnv(phase: number): number {
    const t = phase - Math.floor(phase); // 0..1 within current beat
    // (1 - t)^4 → 1.0 at beat onset, fades sharply; back near 0 by t≈0.5
    const decay = 1 - t;
    const d2 = decay * decay;
    return d2 * d2;
}

/** Parse `#rgb` / `#rrggbb` into components. Falls back if parsing fails. */
export function rgbOf(color: string, fallback: [number, number, number]): [number, number, number] {
    const c = color.trim();
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        return [
            parseInt(c[1] + c[1], 16),
            parseInt(c[2] + c[2], 16),
            parseInt(c[3] + c[3], 16),
        ];
    }
    if (/^#[0-9a-f]{6}$/i.test(c)) {
        return [
            parseInt(c.slice(1, 3), 16),
            parseInt(c.slice(3, 5), 16),
            parseInt(c.slice(5, 7), 16),
        ];
    }
    return fallback;
}

/**
 * Extract a hue (0..360) from a CSS color string. Supports `#rrggbb`, `#rgb`,
 * and `hsl(h, ...)`. Falls back to the provided default if parsing fails.
 */
export function hueOf(color: string, fallback: number): number {
    const c = color.trim();
    if (!c) return fallback;

    const hslMatch = c.match(/^hsla?\(\s*([-\d.]+)/i);
    if (hslMatch) {
        const h = parseFloat(hslMatch[1]);
        return Number.isFinite(h) ? ((h % 360) + 360) % 360 : fallback;
    }

    let r = 0, g = 0, b = 0;
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        r = parseInt(c[1] + c[1], 16);
        g = parseInt(c[2] + c[2], 16);
        b = parseInt(c[3] + c[3], 16);
    } else if (/^#[0-9a-f]{6}$/i.test(c)) {
        r = parseInt(c.slice(1, 3), 16);
        g = parseInt(c.slice(3, 5), 16);
        b = parseInt(c.slice(5, 7), 16);
    } else {
        return fallback;
    }

    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    if (d === 0) return fallback;

    let h: number;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;

    h = h * 60;
    if (h < 0) h += 360;
    return h;
}

/** Canvas stand-in for CSS `color-mix(in srgb, a (1-t)%, b t%)`. */
export function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Map a bar index (0..N-1) to a hue along the FlameGraph "track palette":
 * red (bass) → orange → yellow → green/cyan (highs).
 */
export function barHue(i: number, N: number): number {
    const t = N <= 1 ? 0 : i / (N - 1);
    if (t < 0.25) return 0 + (t / 0.25) * 20;              // red → orange
    if (t < 0.50) return 20 + ((t - 0.25) / 0.25) * 25;    // orange → yellow
    if (t < 0.75) return 45 + ((t - 0.50) / 0.25) * 75;    // yellow → green
    return 120 + ((t - 0.75) / 0.25) * 65;                 // green → cyan
}

export interface Transients {
    kick: boolean;
    snare: boolean;
    hat: boolean;
}

/**
 * Per-band onset detection shared by the event-driven modes. Deltas catch the
 * attack, cooldowns stop sustained energy from retriggering. Thresholds are
 * the tuned MarbleDrop values; per-band cooldown lengths vary by mode (how
 * often it can afford to fire) and are passed at construction.
 */
export class TransientDetector {
    private prevLow = 0;
    private prevMid = 0;
    private prevHigh = 0;
    private lowCd = 0;
    private midCd = 0;
    private highCd = 0;

    constructor(
        private readonly lowCooldown: number,
        private readonly midCooldown: number,
        private readonly highCooldown: number,
    ) {}

    /** Call exactly once per frame. */
    update(dt: number, low: number, mid: number, high: number): Transients {
        this.lowCd = Math.max(0, this.lowCd - dt);
        this.midCd = Math.max(0, this.midCd - dt);
        this.highCd = Math.max(0, this.highCd - dt);

        const kick = low - this.prevLow > 0.08 && low > 0.25 && this.lowCd <= 0;
        const snare = mid - this.prevMid > 0.09 && mid > 0.28 && this.midCd <= 0;
        const hat = high - this.prevHigh > 0.06 && high > 0.20 && this.highCd <= 0;

        if (kick) this.lowCd = this.lowCooldown;
        if (snare) this.midCd = this.midCooldown;
        if (hat) this.highCd = this.highCooldown;

        this.prevLow = low;
        this.prevMid = mid;
        this.prevHigh = high;
        return { kick, snare, hat };
    }
}

/** Monospace stack for instrument labels — the drafting modes' one typeface. */
export const MONO_FONT = "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, ui-monospace, monospace";

export function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Deterministic 32-bit mix. The viz modes use this instead of `Math.random`
 * so shapes are stable across rebuilds, resizes and re-entry.
 */
export function hash32(a: number, b: number): number {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return (h ^ (h >>> 16)) >>> 0;
}

/** 0..1 from a hash, taking the high bits. */
export function rand01(h: number): number {
    return (h >>> 8) / 0x1000000;
}

/** Seeded stream of 0..1 values for modes that draw many in sequence. */
export class SeededRandom {
    private n = 0;

    constructor(private readonly seed: number) {}

    next(): number {
        return rand01(hash32(this.seed, this.n++));
    }

    range(lo: number, hi: number): number {
        return lo + (hi - lo) * this.next();
    }
}

/**
 * One step of an asymmetric follower: rises at `attack` and falls at
 * `release` (both rates per second), frame-rate independent. Fast attack /
 * slow release keeps transients readable without jitter.
 */
export function follow(current: number, target: number, dt: number, attack: number, release: number): number {
    const rate = target > current ? attack : release;
    return current + (target - current) * (1 - Math.exp(-dt * rate));
}

/**
 * Precomputed `rgba()` strings for one colour at `steps` evenly spaced alphas
 * (index 0 = transparent, last = opaque), so hot loops pick a string instead
 * of building one. Pick with {@link rampAt}.
 */
export function alphaRamp(rgb: readonly [number, number, number], steps = 32): string[] {
    const out = new Array<string>(steps);
    for (let i = 0; i < steps; i++) {
        out[i] = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(i / (steps - 1)).toFixed(3)})`;
    }
    return out;
}

export function rampAt(ramp: readonly string[], alpha: number): string {
    return ramp[Math.round(clamp01(alpha) * (ramp.length - 1))];
}

export function mixRgb(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    t: number,
): [number, number, number] {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

/** Small instrument label, as on the drafting modes' rails. */
export function drawLabel(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    color: string, size = 10, align: CanvasTextAlign = 'left',
): void {
    ctx.fillStyle = color;
    ctx.font = `${size}px ${MONO_FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
}
