/**
 * STAR ROAD's course and space: a ribbon road whose centerline bends and
 * rolls over hills as a fixed function of distance, seen by a chase camera
 * that follows the road's heading. The rainbow ribbon is
 * rendered as dark spectral glass with continuous accent rails, sparse star
 * markers, a quiet starfield, soft nebulae and abstract neon signs.
 *
 * Distance `s` runs along the road. The camera is a sheared pinhole: points
 * are offset by the road's slope at the camera, which turns the bends into
 * proper sweeping curves without a full rotation per point.
 */

import type {Theme} from '../../types.js';
import {TAU, hash32, rand01, lerpRgb} from '../../util.js';

export type Rgb = [number, number, number];

export const HALF_WIDTH = 6.4;
/** The road's depth below its surface, seen at the edges. */
const THICKNESS = 0.45;
const NEAR = 0.6;

/** N64 band order, nearest first: yellow, green, cyan, blue, purple, red, orange. */
const BANDS: readonly Rgb[] = [
    [239, 189, 115], [82, 198, 160], [71, 210, 229], [100, 132, 234], [165, 115, 221], [225, 100, 166], [234, 144, 107],
];
const BAND_LEN = 7.5;
/** Most of each band blends into the next for a continuous spectral surface. */
const BLEND = 0.75;
const BLEND_STEPS = 16;
const BAND_COLORS: Rgb[][] = BANDS.map((a, i) => {
    const b = BANDS[(i + 1) % BANDS.length];
    const out: Rgb[] = [];
    for (let k = 0; k <= BLEND_STEPS; k++) {
        const t = k / BLEND_STEPS;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    return out;
});
export const BAND_RGB = BANDS;

const RAIL_STEP = 6;
const RAIL_STAR = '#efbd73';
const RAIL_CORE = '#152331';
const UNDERSIDE = '#0b1320';

// --- course ---------------------------------------------------------------

const BENDS: ReadonlyArray<readonly [number, number, number]> = [[34, 0.0061, 0.3], [17, 0.0137, 1.1], [4, 0.031, 2.2]];
const HILLS: ReadonlyArray<readonly [number, number, number]> = [[6, 0.009, 0], [2.5, 0.023, 2]];

function wave(table: typeof BENDS, s: number, order: 0 | 1 | 2): number {
    let v = 0;
    for (const [a, b, c] of table) {
        const ph = b * s + c;
        v += order === 0 ? a * Math.sin(ph) : order === 1 ? a * b * Math.cos(ph) : -a * b * b * Math.sin(ph);
    }
    return v;
}

export function roadX(s: number): number {
    return wave(BENDS, s, 0);
}

export function roadY(s: number): number {
    return wave(HILLS, s, 0);
}

/** Heading of the road at `s`, radians from straight ahead. */
export function roadHeading(s: number): number {
    return Math.atan(wave(BENDS, s, 1));
}

/** Signed bend at `s`: positive bends right. */
export function roadCurve(s: number): number {
    return wave(BENDS, s, 2);
}

// --- camera ---------------------------------------------------------------

export class RoadCamera {
    s = 0;
    x = 0;
    y = 0;
    slopeX = 0;
    slopeY = 0;
    f = 800;
    cx = 0;
    cy = 0;
    /** Results of the last `project`. */
    sx = 0;
    sy = 0;
    d = 1;

    /**
     * Sit `height` above the road at `s`, offset `lane` across it, looking at
     * a point `look` ahead and `lookHeight` above the road.
     */
    set(s: number, lane: number, height: number, look: number, lookHeight: number, f: number, cx: number, cy: number): void {
        this.s = s;
        this.x = roadX(s) + lane;
        this.y = roadY(s) + height;
        this.slopeX = (roadX(s + look) + lane - this.x) / look;
        this.slopeY = (roadY(s + look) + lookHeight - this.y) / look;
        this.f = f;
        this.cx = cx;
        this.cy = cy;
    }

    project(x: number, y: number, s: number): boolean {
        const d = s - this.s;
        if (d < NEAR) return false;
        this.d = d;
        this.sx = this.cx + (x - this.x - this.slopeX * d) * this.f / d;
        this.sy = this.cy - (y - this.y - this.slopeY * d) * this.f / d;
        return true;
    }
}

// --- road -----------------------------------------------------------------

function bandCss(s: number, bg: Rgb, light: number): string {
    const u = s / BAND_LEN;
    const i = ((Math.floor(u) % BANDS.length) + BANDS.length) % BANDS.length;
    const f = u - Math.floor(u);
    const t = f < 1 - BLEND ? 0 : (f - (1 - BLEND)) / BLEND;
    return lerpRgb(bg, BAND_COLORS[i][Math.round(t * BLEND_STEPS)], light);
}

const qx = new Float32Array(4);
const qy = new Float32Array(4);

/**
 * Road ribbon, far to near: underside edges, the band, and a soft specular
 * streak down the middle. `glow` (0..1) brightens the streak on the beat.
 */
export function drawRoad(ctx: CanvasRenderingContext2D, cam: RoadCamera, far: number, glow: number, theme: Theme): void {
    // Segment length grows with distance; band edges stay crisp up close.
    const starts: number[] = [];
    let d = NEAR;
    while (d < far) {
        starts.push(d);
        d += Math.max(0.75, d * 0.022);
    }
    starts.push(far);
    const specular = 0.012 + 0.025 * glow;
    for (let i = starts.length - 2; i >= 0; i--) {
        const s0 = cam.s + starts[i];
        const s1 = cam.s + starts[i + 1];
        const x0 = roadX(s0), x1 = roadX(s1), y0 = roadY(s0), y1 = roadY(s1);
        // Near edge: left, right; far edge: right, left.
        if (!cam.project(x0 - HALF_WIDTH, y0, s0)) continue;
        qx[0] = cam.sx; qy[0] = cam.sy;
        cam.project(x0 + HALF_WIDTH, y0, s0);
        qx[1] = cam.sx; qy[1] = cam.sy;
        cam.project(x1 + HALF_WIDTH, y1, s1);
        qx[2] = cam.sx; qy[2] = cam.sy;
        cam.project(x1 - HALF_WIDTH, y1, s1);
        qx[3] = cam.sx; qy[3] = cam.sy;

        // The ribbon's thickness, visible below each edge.
        const t0 = THICKNESS * cam.f / starts[i];
        const t1 = THICKNESS * cam.f / starts[i + 1];
        ctx.fillStyle = UNDERSIDE;
        ctx.beginPath();
        ctx.moveTo(qx[0], qy[0]); ctx.lineTo(qx[3], qy[3]); ctx.lineTo(qx[3], qy[3] + t1); ctx.lineTo(qx[0], qy[0] + t0);
        ctx.moveTo(qx[1], qy[1]); ctx.lineTo(qx[2], qy[2]); ctx.lineTo(qx[2], qy[2] + t1); ctx.lineTo(qx[1], qy[1] + t0);
        ctx.fill();

        ctx.fillStyle = bandCss((s0 + s1) / 2, theme.bgRgb, 0.21 - 0.14 * Math.min(1, starts[i] / far));
        ctx.beginPath();
        ctx.moveTo(qx[0], qy[0]); ctx.lineTo(qx[1], qy[1]); ctx.lineTo(qx[2], qy[2]); ctx.lineTo(qx[3], qy[3]);
        ctx.closePath();
        // Overlap the seam a hair so far segments never show a gap.
        ctx.fill();
        // Opaque color mixing avoids bright antialiasing seams between glass segments.
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke();

        const a = 0.22, b = 0.78;
        ctx.globalAlpha = specular;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(qx[0] + (qx[1] - qx[0]) * a, qy[0] + (qy[1] - qy[0]) * a);
        ctx.lineTo(qx[0] + (qx[1] - qx[0]) * b, qy[0] + (qy[1] - qy[0]) * b);
        ctx.lineTo(qx[3] + (qx[2] - qx[3]) * b, qy[3] + (qy[2] - qy[3]) * b);
        ctx.lineTo(qx[3] + (qx[2] - qx[3]) * a, qy[3] + (qy[2] - qy[3]) * a);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

/** Unit five-point star, ten vertices, point up. */
const STAR: readonly [number, number][] = Array.from({length: 10}, (_, i) => {
    const r = i % 2 === 0 ? 1 : 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    return [Math.cos(a) * r, Math.sin(a) * r] as [number, number];
});

export function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spin = 0): void {
    const c = Math.cos(spin), s = Math.sin(spin);
    for (let i = 0; i < STAR.length; i++) {
        const [u, v] = STAR[i];
        const px = x + (u * c - v * s) * r, py = y + (u * s + v * c) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
}

/**
 * The edge lights: continuous rails and an amber star every 6 m, far to near.
 * `pulse` (0..1) is a kick: a bright wave runs down the fence.
 */
export function drawRails(ctx: CanvasRenderingContext2D, cam: RoadCamera, far: number, pulse: number, theme: Theme): void {
    // Continuous luminous edges carry the eye through bends; star markers are secondary.
    ctx.save();
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
        ctx.beginPath();
        for (let d = far; d >= 1; d -= 1) {
            const s = cam.s + d;
            if (!cam.project(roadX(s) + side * (HALF_WIDTH + 0.05), roadY(s) + 0.08, s)) continue;
            if (d === far) ctx.moveTo(cam.sx, cam.sy); else ctx.lineTo(cam.sx, cam.sy);
        }
        ctx.strokeStyle = side < 0 ? theme.neonSecondary : theme.neon;
        ctx.lineWidth = 5; ctx.globalAlpha = 0.06 + pulse * 0.08; ctx.stroke();
        ctx.lineWidth = 1.2; ctx.globalAlpha = 0.5 + pulse * 0.25; ctx.stroke();
    }
    ctx.restore();
    const first = Math.ceil((cam.s + NEAR) / RAIL_STEP);
    const last = Math.floor((cam.s + far) / RAIL_STEP);
    for (let n = last; n >= first; n--) {
        const s = n * RAIL_STEP;
        const x = roadX(s), y = roadY(s) + 0.6;
        for (const side of [-1, 1]) {
            if (!cam.project(x + side * (HALF_WIDTH + 0.35), y, s)) continue;
            const r = 0.2 * cam.f / cam.d;
            if (r < 1.2) {
                ctx.fillStyle = RAIL_STAR;
                ctx.fillRect(cam.sx - 1, cam.sy - 1, 2, 2);
                continue;
            }
            ctx.globalAlpha = 0.45 + 0.4 * pulse;
            ctx.fillStyle = RAIL_STAR;
            ctx.beginPath();
            starPath(ctx, cam.sx, cam.sy, r);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = RAIL_CORE;
            ctx.beginPath();
            starPath(ctx, cam.sx, cam.sy, r * 0.55);
            ctx.fill();
        }
    }
}

// --- space ----------------------------------------------------------------

const STAR_LAYERS = [
    {count: 220, size: 1, parallax: 0.02, twinkle: 0, colors: ['#ffffff']},
    {count: 70, size: 1.3, parallax: 0.06, twinkle: 3, colors: ['#cfe6ff', '#fff4c8']},
    {count: 18, size: 1.8, parallax: 0.12, twinkle: 5, colors: ['#ffffff']},
] as const;

/** Void, two nebula discs and a three-layer starfield that pans with the heading. */
export function drawSpace(ctx: CanvasRenderingContext2D, vw: number, vh: number, heading: number, time: number, theme: Theme): void {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, vw, vh);
    for (const [fx, fy, fr, rgb, a] of [[0.78, 0.18, 0.2, '58, 24, 104', 0.4], [0.18, 0.12, 0.15, '106, 24, 72', 0.28]] as const) {
        const x = fx * vw - heading * vw * 0.3, y = fy * vh, r = fr * vh * 1.6;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${rgb}, ${a})`);
        g.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    let id = 0;
    for (const layer of STAR_LAYERS) {
        const pan = heading * layer.parallax * vw * 8;
        for (let c = 0; c < layer.colors.length; c++) {
            ctx.fillStyle = layer.colors[c];
            for (let i = 0; i < layer.count; i++, id++) {
                if (i % layer.colors.length !== c) continue;
                const h = hash32(id, 977);
                const x = ((rand01(h) * vw - pan) % vw + vw) % vw;
                const y = rand01(hash32(h, 1)) * vh;
                ctx.globalAlpha = layer.twinkle ? 0.35 + 0.2 * Math.sin(time * layer.twinkle + id) : 0.32;
                ctx.fillRect(x, y, layer.size, layer.size);
            }
        }
    }
    ctx.globalAlpha = 1;
}

// --- neon signs -------------------------------------------------------------

const NEON = ['#ff4ad0', '#39ffe0', '#ffe14a', '#7dff6a'] as const;
const SIGN_SPACING = 95;

type Shape = Array<Array<[number, number]>>;

function ring(cx: number, cy: number, rx: number, ry: number, n = 20): Array<[number, number]> {
    return Array.from({length: n + 1}, (_, i) => [cx + Math.cos((i / n) * TAU) * rx, cy + Math.sin((i / n) * TAU) * ry] as [number, number]);
}

/** Abstract neon line art in a unit box (y up). */
const SHAPES: readonly Shape[] = [
    // Star.
    [STAR.map(([x, y]) => [x * 0.5, -y * 0.5] as [number, number]).concat([[STAR[0][0] * 0.5, -STAR[0][1] * 0.5]])],
    // Ringed planet.
    [ring(0, 0, 0.32, 0.32), ring(0, 0, 0.55, 0.14)],
    // Eighth note.
    [ring(-0.12, -0.32, 0.17, 0.12), [[0.05, -0.3], [0.05, 0.45], [0.32, 0.22]]],
    // Chevrons.
    [[[-0.5, -0.1], [0, 0.35], [0.5, -0.1]], [[-0.5, -0.45], [0, 0], [0.5, -0.45]]],
    // Diamond with a spark.
    [[[0, 0.5], [0.4, 0], [0, -0.5], [-0.4, 0], [0, 0.5]], [[-0.12, 0], [0.12, 0]], [[0, -0.12], [0, 0.12]]],
    // Lightning.
    [[[0.15, 0.5], [-0.2, 0.02], [0.08, 0.02], [-0.15, -0.5], [0.3, 0.1], [0.02, 0.1], [0.25, 0.5]]],
];

/**
 * Neon signs hang off both sides of the course at fixed distances, facing
 * the road. Two in five blink at 2 Hz; `flash` (0..1) brightens them all.
 */
export function drawSigns(ctx: CanvasRenderingContext2D, cam: RoadCamera, far: number, time: number, flash: number): void {
    const first = Math.ceil(cam.s / SIGN_SPACING);
    const last = Math.floor((cam.s + far * 1.4) / SIGN_SPACING);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let n = last; n >= first; n--) {
        const h = hash32(n, 4099);
        const s = n * SIGN_SPACING;
        const side = (n & 1) === 0 ? -1 : 1;
        const x0 = roadX(s) + side * (40 + rand01(hash32(h, 1)) * 45);
        const y0 = roadY(s) + 10 + rand01(hash32(h, 2)) * 22;
        const size = 11 + rand01(hash32(h, 3)) * 8;
        const shape = SHAPES[h % SHAPES.length];
        const color = NEON[(h >>> 5) % NEON.length];
        const blink = (h >>> 9) % 5 < 2 && Math.sin(time * TAU * 2 + n) < 0;
        const alpha = (blink ? 0.3 : 1) * (0.3 + 0.45 * flash);
        if (!cam.project(x0, y0, s)) continue;
        const k = cam.f / cam.d;
        const fade = Math.min(1, (cam.s + far * 1.4 - s) / 60);
        ctx.strokeStyle = color;
        for (const pass of [0, 1]) {
            ctx.globalAlpha = alpha * fade * (pass === 0 ? 0.28 : 0.95);
            ctx.lineWidth = Math.max(1, (pass === 0 ? 1.2 : 0.35) * k);
            ctx.beginPath();
            for (const line of shape) {
                line.forEach(([u, v], i) => {
                    const px = cam.sx + u * size * k, py = cam.sy - v * size * k;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                });
            }
            ctx.stroke();
        }
    }
    ctx.restore();
}
