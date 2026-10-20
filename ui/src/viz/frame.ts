/**
 * One visualizer frame, independent of where its inputs come from: the live
 * host feeds it from an AnalyserNode and rAF, the offline renderer from a
 * decoded WAV and a fixed frame clock. Sharing it keeps the two pixel-for-pixel
 * in agreement — a render is what the stage shows.
 */

import type {View} from './edit.js';
import type {VizLayer, VizMode, VizModeDef, VizServices} from './types.js';

/** Scanline drift, px per second. */
const SCANLINE_SPEED = 18;
const SCANLINE_STEP = 3.6;

/** Low / mid / high energies from byte FFT data, scaled by `sensitivity`. */
export function bandEnergies(freqData: Uint8Array, sensitivity: number): {low: number; mid: number; high: number} {
    const len = freqData.length;
    const lowEnd = Math.floor(len * 0.08);
    const midEnd = Math.floor(len * 0.35);

    let low = 0, mid = 0, high = 0;
    for (let i = 0; i < lowEnd; i++) low += freqData[i];
    for (let i = lowEnd; i < midEnd; i++) mid += freqData[i];
    for (let i = midEnd; i < len; i++) high += freqData[i];

    const inv255 = 1 / 255;
    return {
        low: (low / (lowEnd || 1)) * inv255 * sensitivity,
        mid: (mid / ((midEnd - lowEnd) || 1)) * inv255 * sensitivity,
        high: (high / ((len - midEnd) || 1)) * inv255 * sensitivity,
    };
}

/** Advance the scanline phase by `dt` seconds. */
export function advanceScanlines(offset: number, dt: number): number {
    return (offset + dt * SCANLINE_SPEED) % 4;
}

export interface Paint {
    /** Scanline phase (see {@link advanceScanlines}), or null for none. */
    scanlines: number | null;
    /** How the mode is framed; none, as is. */
    view?: View;
    /** Painted over the visuals, under the layers: a show's transition and finish. */
    over?: (ctx: CanvasRenderingContext2D) => void;
    /** Painted over everything: a show's fade to black. */
    after?: (ctx: CanvasRenderingContext2D) => void;
}

/** Paint background, scanlines, the mode, vignette, then what goes `over` the visuals, then overlay layers. */
export function paintFrame(
    ctx: CanvasRenderingContext2D,
    def: VizModeDef,
    mode: VizMode,
    layers: readonly VizLayer[],
    s: VizServices,
    {scanlines, view, over, after}: Paint,
): void {
    const w = s.width;
    const h = s.height;

    // Trail modes get a translucent clear so strokes smear across frames;
    // everyone else gets an opaque background.
    if (def.trailFade !== undefined) {
        const [br, bg, bb] = s.theme.bgRgb;
        ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${def.trailFade})`;
    } else {
        ctx.fillStyle = s.theme.bg;
    }
    ctx.fillRect(0, 0, w, h);

    if (scanlines !== null) drawScanlines(ctx, w, h, s.theme.neonHue, scanlines);
    if (view) {
        ctx.save();
        ctx.translate(w / 2 + view.x * w, h / 2 + view.y * w);
        ctx.rotate(view.rotate);
        ctx.scale(view.scale, view.scale);
        ctx.translate(-w / 2, -h / 2);
        mode.render(ctx, s);
        ctx.restore();
    } else {
        mode.render(ctx, s);
    }
    drawVignette(ctx, w, h);
    over?.(ctx);
    // Layers last: the vignette is a frame around the *visuals*, and
    // dimming Stage Mode's code at the edges would hurt legibility.
    for (const layer of layers) layer.render(ctx, s);
    after?.(ctx);
}

function drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number, hue: number, offset: number): void {
    ctx.strokeStyle = `hsla(${hue}, 92%, 70%, 0.035)`;
    ctx.lineWidth = 1;

    let y = (offset % SCANLINE_STEP) - SCANLINE_STEP;

    ctx.beginPath();
    while (y < h) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        y += SCANLINE_STEP;
    }
    ctx.stroke();
}

function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const grad = ctx.createRadialGradient(
        w * 0.5, h * 0.5, Math.min(w, h) * 0.35,
        w * 0.5, h * 0.5, Math.max(w, h) * 0.72,
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}
