/**
 * A show's finish over the visuals: film grain and letterbox bars. Grain is a
 * few noise tiles made once from a fixed seed and picked by time, so a frame
 * looks the same however it's reached.
 */

import {hash32, rand01} from './util.js';

export interface Finish {
    /** Frame aspect the letterbox crops to (2.39 for scope), or null for none. */
    letterbox: number | null;
    /** Film grain, 0 (none) to 1. */
    grain: number;
}

const TILE = 256;
const TILES = 6;
/** Grain changes this often, like film frames. */
const GRAIN_HZ = 24;
const GRAIN_ALPHA = 0.22;

let tiles: HTMLCanvasElement[] | null = null;

/** Paint `finish` over the frame at song time `t` seconds. */
export function applyFinish(ctx: CanvasRenderingContext2D, finish: Finish, t: number): void {
    const {width: w, height: h} = ctx.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (finish.grain > 0) {
        const step = Math.floor(t * GRAIN_HZ);
        const tile = grainTiles()[(hash32(0x9a1, step) >>> 0) % TILES];
        const pattern = ctx.createPattern(tile, 'repeat')!;
        // Shift the tile each step too, so its repeats don't line up frame to frame.
        pattern.setTransform(new DOMMatrix().translate(Math.floor(rand01(hash32(0x9a2, step)) * TILE), Math.floor(rand01(hash32(0x9a3, step)) * TILE)));
        ctx.globalAlpha = GRAIN_ALPHA * finish.grain;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }
    if (finish.letterbox !== null && w / h < finish.letterbox) {
        const bar = Math.round((h - w / finish.letterbox) / 2);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, bar);
        ctx.fillRect(0, h - bar, w, bar);
    }
    ctx.restore();
}

/** Fill the frame with `color` at `alpha`: a strobe's white, a fade's black. */
export function wash(ctx: CanvasRenderingContext2D, color: string, alpha: number): void {
    if (alpha <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
}

function grainTiles(): HTMLCanvasElement[] {
    tiles ??= Array.from({length: TILES}, (_, k) => {
        const canvas = document.createElement('canvas');
        canvas.width = TILE;
        canvas.height = TILE;
        const c = canvas.getContext('2d')!;
        const image = c.createImageData(TILE, TILE);
        for (let i = 0; i < TILE * TILE; i++) {
            const v = Math.floor(rand01(hash32(0x6a1 + k, i)) * 256);
            image.data[i * 4] = v;
            image.data[i * 4 + 1] = v;
            image.data[i * 4 + 2] = v;
            image.data[i * 4 + 3] = 255;
        }
        c.putImageData(image, 0, 0);
        return canvas;
    });
    return tiles;
}
