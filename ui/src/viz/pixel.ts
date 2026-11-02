/**
 * 320×180 pixel screen and bitmap sprites, for modes that draw a small
 * buffer from state every frame and blit it sharp. Colours come from the
 * mode: `nearest` snaps a track colour to the theme's accent pool.
 */

export const PW = 320;
export const PH = 180;

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

function css(rgb: readonly [number, number, number]): string {
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}
