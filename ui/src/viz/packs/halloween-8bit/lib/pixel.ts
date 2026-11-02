/**
 * 320×180 screen, baked solids, bitmap sprites, and the status strip.
 * Modes redraw this buffer from state every frame and blit it sharp.
 */

import type {Theme} from '../../../sdk.js';
import {mixRgb, rgbOf} from '../../../sdk.js';

export const PW = 320;
export const PH = 180;
export const HUD_H = 8;
export const HUD_Y = PH - HUD_H;

type Rgb = [number, number, number];

export interface Ink {
    bg: string;
    skyDeep: string;
    sky: string;
    hill: string;
    hillDark: string;
    dirt: string;
    stone: string;
    stoneDark: string;
    /** Cooler than bone, so graves don't match the skeletons. */
    tomb: string;
    tombShade: string;
    bone: string;
    moon: string;
    moonDim: string;
    accent: string;
    accentDark: string;
    purple: string;
    red: string;
    roof: string;
    roofAlt: string;
    ghost: string;
    green: string;
    stem: string;
    line: string;
    sil: string;
    wall: string;
    wallDark: string;
    pool: readonly Rgb[];
}

export interface Pix {
    ink: Ink;
    skyDither: CanvasPattern;
    hillDither: CanvasPattern;
    waterDither: CanvasPattern;
}

export function bakePix(t: Theme): Pix {
    const bg = t.bgRgb;
    const pool = t.accentPool;
    const neon = pool[0] ?? rgbOf(t.neon, [255, 122, 26]);
    const secondary = pool[1] ?? rgbOf(t.neonSecondary, [138, 60, 255]);
    const violet = rgbOf(t.violet, secondary);
    const active = rgbOf(t.active, [255, 243, 176]);
    const red = rgbOf(t.red, [255, 46, 77]);
    const text = t.textRgb;
    const green = greenest(pool, neon);
    const white: Rgb = [255, 255, 255];
    const black: Rgb = [0, 0, 0];
    const ink: Ink = {
        bg: t.bg,
        skyDeep: css(bg),
        sky: css(mixRgb(bg, violet, 0.62)),
        hill: css(mixRgb(bg, green, 0.62)),
        hillDark: css(mixRgb(bg, green, 0.36)),
        dirt: css(mixRgb(bg, mixRgb(red, green, 0.45), 0.4)),
        stone: css(mixRgb(bg, active, 0.78)),
        stoneDark: css(mixRgb(bg, active, 0.42)),
        tomb: css(mixRgb(bg, khaki(text, green), 0.52)),
        tombShade: css(mixRgb(bg, khaki(text, green), 0.3)),
        bone: css(mixRgb(text, white, 0.82)),
        moon: css(active),
        moonDim: css(mixRgb(active, violet, 0.4)),
        accent: css(neon),
        accentDark: css(mixRgb(neon, bg, 0.45)),
        purple: css(secondary),
        red: css(red),
        roof: css(mixRgb(red, bg, 0.66)),
        roofAlt: css(mixRgb(red, bg, 0.3)),
        ghost: css(mixRgb(text, white, 0.82)),
        green: css(green),
        stem: css(mixRgb(green, bg, 0.38)),
        line: css(mixRgb(bg, black, 0.7)),
        sil: css(mixRgb(bg, black, 0.45)),
        wall: css(mixRgb(bg, mixRgb(text, bg, 0.7), 0.5)),
        wallDark: css(mixRgb(bg, secondary, 0.48)),
        pool,
    };
    return {
        ink,
        skyDither: checker(ink.skyDeep, ink.sky),
        hillDither: checker(ink.hillDark, ink.hill),
        waterDither: checker(css(mixRgb(bg, secondary, 0.22)), css(mixRgb(bg, secondary, 0.48))),
    };
}

/** Nearest accent-pool colour. `cache` is only a memo; the pick is pure. */
export function nearest(
    rgb: readonly [number, number, number],
    pool: readonly (readonly [number, number, number])[],
    cache: Map<number, string>,
): string {
    const key = ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255);
    const hit = cache.get(key);
    if (hit) return hit;
    if (!pool.length) return css([rgb[0], rgb[1], rgb[2]]);
    let best = 0;
    let bestD = 1e12;
    for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const d = (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2;
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    const out = css(pool[best]);
    cache.set(key, out);
    return out;
}

export class PxScreen {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;

    constructor() {
        const canvas = document.createElement('canvas');
        canvas.width = PW;
        canvas.height = PH;
        const ctx = canvas.getContext('2d', {alpha: false});
        if (!ctx) throw new Error('2d');
        ctx.imageSmoothingEnabled = false;
        this.canvas = canvas;
        this.ctx = ctx;
    }

    blit(ctx: CanvasRenderingContext2D, w: number, h: number, bg: string): void {
        const prev = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);
        const scale = Math.min(w / PW, h / PH);
        const dw = Math.floor(PW * scale);
        const dh = Math.floor(PH * scale);
        ctx.drawImage(this.canvas, Math.floor((w - dw) / 2), Math.floor((h - dh) / 2), dw, dh);
        ctx.imageSmoothingEnabled = prev;
    }

    /** Status strip on the glass. The show camera crops the buffer's bottom edge. */
    stampHud(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        const scale = Math.min(w / PW, h / PH);
        const dw = Math.floor(PW * scale);
        const dh = Math.floor(PH * scale);
        const sh = Math.max(1, Math.round(HUD_H * scale));
        const ox = Math.floor((w - dw) / 2);
        const oy = Math.floor((h - dh) / 2);
        ctx.drawImage(this.canvas, 0, HUD_Y, PW, HUD_H, ox, oy + dh - sh, dw, sh);
        ctx.restore();
    }
}

export interface Sprite {
    w: number;
    h: number;
    px: Uint8Array;
}

/** Rows of `.` and digits 1–7. Shared indent is stripped. */
export function spr(body: string): Sprite {
    const lines = body.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
    const pad = lines.reduce((n, line) => Math.min(n, (/^ */.exec(line)?.[0].length ?? 0)), 99);
    const rows = lines.map((line) => line.slice(pad).replace(/\s+$/, ''));
    const w = rows[0]?.length ?? 0;
    if (!w || !rows.length) throw new Error('empty sprite');
    const px = new Uint8Array(w * rows.length);
    for (let y = 0; y < rows.length; y++) {
        if (rows[y].length !== w) throw new Error(`sprite ${rows[y].length} != ${w}: ${rows[y]}`);
        for (let x = 0; x < w; x++) {
            const c = rows[y][x];
            if (c === '.' || c === ' ') continue;
            if (c < '1' || c > '7') throw new Error(`sprite pixel '${c}'`);
            px[y * w + x] = c.charCodeAt(0) - 48;
        }
    }
    return {w, h: rows.length, px};
}

export interface DrawOpt {
    scale?: number;
    flip?: boolean;
    clipTop?: number;
    clipBottom?: number;
    outline?: string;
}

const bucketN = 8;
const bx: number[][] = Array.from({length: bucketN}, () => []);
const by: number[][] = Array.from({length: bucketN}, () => []);

export function drawSprite(
    ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number,
    colors: readonly (string | null)[], opt?: DrawOpt,
): void {
    const scale = opt?.scale ?? 1;
    if (opt?.outline) {
        const flat = colors.map((c, i) => (i > 0 && c ? opt.outline! : null));
        const rest: DrawOpt = {scale: opt.scale, flip: opt.flip, clipTop: opt.clipTop, clipBottom: opt.clipBottom};
        blit(ctx, s, x + scale, y, flat, scale, rest);
        blit(ctx, s, x - scale, y, flat, scale, rest);
        blit(ctx, s, x, y + scale, flat, scale, rest);
        blit(ctx, s, x, y - scale, flat, scale, rest);
    }
    blit(ctx, s, x, y, colors, scale, opt);
}

export function frameRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
}

/** Flat-colour triangle. Every third row uses `alt` so roofs read as shingles. */
export function fillTri(
    ctx: CanvasRenderingContext2D,
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
    fill: string, alt: string,
): void {
    const top = Math.ceil(Math.min(ay, by, cy));
    const bot = Math.floor(Math.max(ay, by, cy));
    const edges: readonly [number, number, number, number][] = [
        [ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay],
    ];
    for (let y = top; y <= bot; y++) {
        let lo = 1e9;
        let hi = -1e9;
        for (const [x0, y0, x1, y1] of edges) {
            if (y0 === y1) continue;
            if ((y < y0 && y < y1) || (y > y0 && y > y1)) continue;
            const x = x0 + (x1 - x0) * ((y - y0) / (y1 - y0));
            if (x < lo) lo = x;
            if (x > hi) hi = x;
        }
        const left = Math.round(lo);
        const right = Math.round(hi);
        if (right <= left) continue;
        ctx.fillStyle = (Math.floor(y / 3) & 1) === 0 ? fill : alt;
        ctx.fillRect(left, y, right - left, 1);
    }
}

const FONT: Record<string, readonly string[]> = {
    A: ['010', '101', '111', '101', '101'],
    B: ['110', '101', '110', '101', '110'],
    C: ['011', '100', '100', '100', '011'],
    D: ['110', '101', '101', '101', '110'],
    E: ['111', '100', '110', '100', '111'],
    F: ['111', '100', '110', '100', '100'],
    G: ['011', '100', '101', '101', '011'],
    H: ['101', '101', '111', '101', '101'],
    I: ['111', '010', '010', '010', '111'],
    J: ['001', '001', '001', '101', '010'],
    K: ['101', '101', '110', '101', '101'],
    L: ['100', '100', '100', '100', '111'],
    M: ['101', '111', '101', '101', '101'],
    N: ['110', '101', '101', '101', '101'],
    O: ['010', '101', '101', '101', '010'],
    P: ['110', '101', '110', '100', '100'],
    Q: ['010', '101', '101', '011', '001'],
    R: ['110', '101', '110', '101', '101'],
    S: ['011', '100', '010', '001', '110'],
    T: ['111', '010', '010', '010', '010'],
    U: ['101', '101', '101', '101', '011'],
    V: ['101', '101', '101', '010', '010'],
    W: ['101', '101', '101', '111', '101'],
    X: ['101', '101', '010', '101', '101'],
    Y: ['101', '101', '010', '010', '010'],
    Z: ['111', '001', '010', '100', '111'],
    '0': ['111', '101', '101', '101', '111'],
    '1': ['110', '010', '010', '010', '111'],
    '2': ['110', '001', '010', '100', '111'],
    '3': ['110', '001', '011', '001', '110'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '110', '001', '110'],
    '6': ['011', '100', '110', '101', '011'],
    '7': ['111', '001', '010', '100', '100'],
    '8': ['111', '101', '010', '101', '111'],
    '9': ['111', '101', '111', '001', '110'],
};

export function textWidth(text: string): number {
    return text.length * 4;
}

export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    let cx = x | 0;
    const y0 = y | 0;
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
        const g = FONT[upper[i]];
        if (g) {
            for (let r = 0; r < 5; r++) {
                const row = g[r];
                for (let c = 0; c < 3; c++) if (row[c] === '1') ctx.rect(cx + c, y0 + r, 1, 1);
            }
        }
        cx += 4;
    }
    ctx.fill();
}

/** Bottom status strip: mode name, beat pips, bar count. */
export function drawHud(ctx: CanvasRenderingContext2D, ink: Ink, title: string, cycle: number, hot: boolean): void {
    ctx.fillStyle = ink.line;
    ctx.fillRect(0, HUD_Y, PW, HUD_H);
    ctx.fillStyle = hot ? ink.moon : ink.accent;
    ctx.fillRect(0, HUD_Y, PW, 1);
    drawSkull(ctx, 2, HUD_Y + 2, hot ? ink.moon : ink.bone, hot ? ink.red : ink.bg);
    drawText(ctx, title, 10, HUD_Y + 2, ink.bone);
    const bar = String(Math.floor(cycle) % 100).padStart(2, '0');
    const label = `BAR ${bar}`;
    const lx = PW - 3 - textWidth(label);
    drawText(ctx, label, lx, HUD_Y + 2, ink.moon);
    const beat = Math.floor((cycle % 1) * 4) % 4;
    for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i === beat ? ink.accent : ink.purple;
        ctx.fillRect(lx - 18 + i * 4, HUD_Y + 3, 2, 2);
    }
}

function drawSkull(ctx: CanvasRenderingContext2D, x: number, y: number, bone: string, eye: string): void {
    ctx.fillStyle = bone;
    ctx.fillRect(x + 1, y, 3, 1);
    ctx.fillRect(x, y + 1, 5, 3);
    ctx.fillRect(x + 1, y + 4, 3, 1);
    ctx.fillStyle = eye;
    ctx.fillRect(x + 1, y + 2, 1, 1);
    ctx.fillRect(x + 3, y + 2, 1, 1);
}

function blit(
    ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number,
    colors: readonly (string | null)[], scale: number, opt?: DrawOpt,
): void {
    const ox = Math.round(x);
    const oy = Math.round(y);
    const flip = opt?.flip ?? false;
    const top = opt?.clipTop;
    const bot = opt?.clipBottom;
    for (let i = 1; i < bucketN; i++) {
        bx[i].length = 0;
        by[i].length = 0;
    }
    for (let py = 0; py < s.h; py++) {
        const dy = oy + py * scale;
        if (bot !== undefined && dy >= bot) continue;
        if (top !== undefined && dy + scale <= top) continue;
        const row = py * s.w;
        for (let px = 0; px < s.w; px++) {
            const idx = s.px[row + px];
            if (idx <= 0 || idx >= bucketN || idx >= colors.length || !colors[idx]) continue;
            const sx = flip ? s.w - 1 - px : px;
            bx[idx].push(ox + sx * scale);
            by[idx].push(dy);
        }
    }
    for (let i = 1; i < colors.length && i < bucketN; i++) {
        const list = bx[i];
        if (!list.length || !colors[i]) continue;
        ctx.fillStyle = colors[i]!;
        ctx.beginPath();
        const yy = by[i];
        for (let n = 0; n < list.length; n++) ctx.rect(list[n], yy[n], scale, scale);
        ctx.fill();
    }
}

function checker(a: string, b: string): CanvasPattern {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const g = c.getContext('2d');
    if (!g) throw new Error('2d');
    g.fillStyle = a;
    g.fillRect(0, 0, 2, 2);
    g.fillStyle = b;
    g.fillRect(0, 0, 1, 1);
    g.fillRect(1, 1, 1, 1);
    const pattern = g.createPattern(c, 'repeat');
    if (!pattern) throw new Error('pattern');
    return pattern;
}

/** Grey, pulled a little toward green so it stays cooler than near-white bone. */
function khaki(text: Rgb, green: Rgb): Rgb {
    const lum = Math.round((text[0] + text[1] + text[2]) / 3);
    return mixRgb([lum, lum, lum], green, 0.28);
}

function css(rgb: readonly [number, number, number]): string {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function greenest(pool: readonly Rgb[], fallback: Rgb): Rgb {
    let best = fallback;
    let score = -1e9;
    for (const c of pool) {
        const s = c[1] - Math.max(c[0], c[2]);
        if (s > score) {
            score = s;
            best = c;
        }
    }
    return best;
}
