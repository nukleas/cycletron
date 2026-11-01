/**
 * Night-sky kit shared by the Halloween scenes: sky gradient, stars, moon,
 * lightning, bats and the ghost shape. Everything here is a pure draw
 * function of its arguments or a small pool the owning mode advances in
 * update(); nothing draws random numbers at render time.
 */

import type {Rgb} from '../../hap-field.js';
import {SeededRandom, TAU, hash32, rand01} from '../../util.js';

// ---- sky ---------------------------------------------------------------------

/** One cached gradient, rebuilt when its key changes. */
export class GradientCache {
    private key = '';
    private grad: CanvasGradient | null = null;

    linear(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: readonly [number, string][]): CanvasGradient {
        const key = `l|${x0}|${y0}|${x1}|${y1}|${stops.map((s) => s.join(':')).join(',')}`;
        if (key !== this.key || !this.grad) {
            const g = ctx.createLinearGradient(x0, y0, x1, y1);
            for (const [at, css] of stops) g.addColorStop(at, css);
            this.grad = g;
            this.key = key;
        }
        return this.grad;
    }

    radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: readonly [number, string][]): CanvasGradient {
        const key = `r|${x}|${y}|${r}|${stops.map((s) => s.join(':')).join(',')}`;
        if (key !== this.key || !this.grad) {
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            for (const [at, css] of stops) g.addColorStop(at, css);
            this.grad = g;
            this.key = key;
        }
        return this.grad;
    }
}

/** Stars above the horizon; positions re-seed every 8 bars, twinkle every half bar. */
export function drawStars(ctx: CanvasRenderingContext2D, w: number, horizonY: number, cycle: number, count: number, ramp: readonly string[]): void {
    const epoch = Math.floor(cycle / 8);
    const tick = Math.floor(cycle * 2);
    for (let i = 0; i < count; i++) {
        const x = rand01(hash32(i * 7 + 1, epoch)) * w;
        const y = rand01(hash32(i * 7 + 2, epoch)) * horizonY * 0.92;
        const a = 0.25 + 0.75 * rand01(hash32(i * 7 + 3, tick));
        const size = rand01(hash32(i * 7 + 4, epoch)) < 0.15 ? 2 : 1;
        ctx.fillStyle = ramp[Math.round(a * (ramp.length - 1))];
        ctx.fillRect(x, y, size, size);
    }
}

/** Moon disc with a soft glow and three seeded craters. `glow` scales the halo. */
export function drawMoon(ctx: CanvasRenderingContext2D, cache: GradientCache, x: number, y: number, r: number, disc: string, glowRgb: Rgb, glow: number): void {
    const [gr, gg, gb] = glowRgb;
    const outer = r * 3.2;
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.4 * glow;
    ctx.fillStyle = cache.radial(ctx, x, y, outer, [[0, `rgba(${gr}, ${gg}, ${gb}, 0.55)`], [0.35, `rgba(${gr}, ${gg}, ${gb}, 0.12)`], [1, `rgba(${gr}, ${gg}, ${gb}, 0)`]]);
    ctx.fillRect(x - outer, y - outer, outer * 2, outer * 2);
    ctx.restore();
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    for (let i = 0; i < 3; i++) {
        const a = rand01(hash32(11, i)) * TAU;
        const d = (0.2 + 0.5 * rand01(hash32(13, i))) * r;
        const cr = (0.12 + 0.14 * rand01(hash32(17, i))) * r;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, cr, 0, TAU);
        ctx.fill();
    }
}

// ---- lightning -------------------------------------------------------------------

export interface Bolt {
    age: number;
    life: number;
    /** Main stroke and forks, each a flat x,y list. */
    paths: Float32Array[];
}

/** A jagged bolt from (x, y0) down to y1, built from its seed in update(). */
export function makeBolt(seed: number, x: number, y0: number, y1: number, forks: number, life: number): Bolt {
    const rnd = new SeededRandom(seed);
    const segs = 14;
    const main = new Float32Array((segs + 1) * 2);
    const dy = (y1 - y0) / segs;
    let px = x;
    for (let i = 0; i <= segs; i++) {
        main[i * 2] = px;
        main[i * 2 + 1] = y0 + dy * i;
        px += rnd.range(-0.9, 0.9) * dy;
    }
    const paths = [main];
    for (let f = 0; f < forks; f++) {
        const at = 3 + Math.floor(rnd.next() * (segs - 6));
        const n = 5;
        const fork = new Float32Array((n + 1) * 2);
        let fx = main[at * 2];
        let fy = main[at * 2 + 1];
        const side = rnd.next() < 0.5 ? -1 : 1;
        for (let i = 0; i <= n; i++) {
            fork[i * 2] = fx;
            fork[i * 2 + 1] = fy;
            fx += side * rnd.range(0.3, 1.1) * dy;
            fy += rnd.range(0.5, 1) * dy;
        }
        paths.push(fork);
    }
    return {age: 0, life, paths};
}

export function drawBolt(ctx: CanvasRenderingContext2D, bolt: Bolt, css: string, width: number): void {
    const k = 1 - bolt.age / bolt.life;
    if (k <= 0) return;
    ctx.save();
    ctx.strokeStyle = css;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = pass === 0 ? 0.22 * k : k;
        ctx.lineWidth = pass === 0 ? width * 4 : width;
        for (const p of bolt.paths) {
            ctx.beginPath();
            ctx.moveTo(p[0], p[1]);
            for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
            ctx.stroke();
        }
    }
    ctx.restore();
}

/** How bright the sky flashes this frame, 0..1. */
export function boltFlash(bolts: readonly Bolt[]): number {
    let f = 0;
    for (const b of bolts) {
        const k = 1 - b.age / b.life;
        if (k > 0) f = Math.max(f, k * k);
    }
    return f;
}

/** Age the pool, dropping spent bolts. */
export function ageBolts(bolts: Bolt[], dt: number): void {
    for (let i = bolts.length - 1; i >= 0; i--) {
        bolts[i].age += dt;
        if (bolts[i].age >= bolts[i].life) bolts.splice(i, 1);
    }
}

// ---- bats ----------------------------------------------------------------------

export interface Bat {
    age: number;
    life: number;
    x0: number;
    y0: number;
    /** Flight direction, -1 or 1. */
    dir: number;
    speed: number;
    phase: number;
    size: number;
}

/** A bat entering from one side at a seeded height. */
export function makeBat(seed: number, w: number, h: number): Bat {
    const r = (n: number) => rand01(hash32(seed, n));
    const dir = (seed & 1) === 0 ? 1 : -1;
    return {
        age: 0,
        life: 1.4,
        x0: dir > 0 ? -0.05 * w : 1.05 * w,
        y0: (0.08 + 0.4 * r(1)) * h,
        dir,
        speed: (0.55 + 0.35 * r(2)) * w / 1.4,
        phase: r(3) * TAU,
        size: (0.012 + 0.01 * r(4)) * h,
    };
}

export function drawBats(ctx: CanvasRenderingContext2D, bats: readonly Bat[], h: number, css: string): void {
    if (!bats.length) return;
    ctx.fillStyle = css;
    for (const b of bats) {
        const t = b.age;
        const x = b.x0 + b.dir * b.speed * t;
        const y = b.y0 + Math.sin(t * 3 + b.phase) * 0.04 * h;
        const flap = Math.sin(t * 22 + b.phase);
        const s = b.size;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x - s * 0.6, y - s * (0.9 * flap + 0.2), x - s * 1.4, y - s * (0.3 * flap));
        ctx.quadraticCurveTo(x - s * 0.7, y + s * 0.15, x, y + s * 0.3);
        ctx.quadraticCurveTo(x + s * 0.7, y + s * 0.15, x + s * 1.4, y - s * (0.3 * flap));
        ctx.quadraticCurveTo(x + s * 0.6, y - s * (0.9 * flap + 0.2), x, y);
        ctx.fill();
    }
}

export function ageBats(bats: Bat[], dt: number): void {
    for (let i = bats.length - 1; i >= 0; i--) {
        bats[i].age += dt;
        if (bats[i].age >= bats[i].life) bats.splice(i, 1);
    }
}

// ---- ghosts ----------------------------------------------------------------------

/**
 * A sheet ghost centred on (x, y): domed head, straight sides, a hem of
 * three scallops that ripple with `wave`, and two eye holes. `alpha` is the
 * sheet's opacity; the eyes are cut in `eye`.
 */
export function drawGhost(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number, fill: string, eye: string, wave: number): void {
    if (alpha <= 0.01) return;
    const hw = w / 2;
    const top = y - h / 2;
    const bottom = y + h / 2;
    const shoulder = top + hw;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x - hw, bottom);
    ctx.lineTo(x - hw, shoulder);
    ctx.arc(x, shoulder, hw, Math.PI, 0);
    ctx.lineTo(x + hw, bottom);
    const scallop = hw / 1.5;
    const dip = h * 0.12;
    for (let i = 0; i < 3; i++) {
        const x1 = x + hw - scallop * (i + 1);
        const cx = x1 + scallop / 2;
        const cy = bottom - dip * (1 + 0.6 * Math.sin(wave + i * 2.1));
        ctx.quadraticCurveTo(cx, cy, x1, bottom);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = eye;
    const ey = shoulder + h * 0.02;
    const er = Math.max(1, w * 0.09);
    ctx.beginPath();
    ctx.ellipse(x - hw * 0.38, ey, er, er * 1.4, 0, 0, TAU);
    ctx.ellipse(x + hw * 0.38, ey, er, er * 1.4, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
}
