/**
 * WAVE TERRAIN — the last ~1.5s of FFT history as a stack of polylines with
 * fake perspective. Newest row at bottom-front, older rows recede toward a
 * horizon: a topographic map of the song's spectrum scrolling at the viewer.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';

const ROWS = 36;
const BARS = 56;
const ROW_DT = 1 / 24;  // 24 rows/sec

class WaveTerrainMode implements VizMode {
    private history = new Float32Array(ROWS * BARS);
    private head = 0;
    private accum = 0;

    layout(_s: VizServices): void {}

    update(dt: number, s: VizServices): void {
        if (!s.freqData) return;

        // Throttle row writes so the terrain rolls at a fixed rate
        // independent of frame rate.
        this.accum += dt;
        if (this.accum < ROW_DT) return;
        this.accum -= ROW_DT;

        const binCount = s.freqData.length;
        const usable = Math.max(8, Math.floor(binCount * 0.55));
        const head = this.head;

        // Sample raw FFT into this row with log-frequency mapping.
        for (let i = 0; i < BARS; i++) {
            const t0 = i / BARS;
            const t1 = (i + 1) / BARS;
            const b0 = Math.floor(Math.pow(t0, 2) * usable);
            const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 2) * usable));
            let peak = 0;
            for (let b = b0; b < b1 && b < binCount; b++) {
                const v = s.freqData[b];
                if (v > peak) peak = v;
            }
            this.history[head * BARS + i] = (peak / 255) * s.sensitivity;
        }

        this.head = (head + 1) % ROWS;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const head = this.head;
        const horizon = h * 0.18;
        const baseY = h * 0.92;
        const baseHalfW = w * 0.46;
        const horizonHalfW = w * 0.08;
        const peakH = (baseY - horizon) * 0.65;

        // Walk back-to-front so closer rows paint over farther ones.
        for (let r = ROWS - 1; r >= 0; r--) {
            // i = 0 is OLDEST (farthest, smallest), i = ROWS-1 is NEWEST (closest).
            const i = r;
            const idx = (head + i) % ROWS;
            const t = i / (ROWS - 1);                   // 0..1 far→near
            const rowY = horizon + (baseY - horizon) * t;
            const halfW = horizonHalfW + (baseHalfW - horizonHalfW) * t;
            const left = w / 2 - halfW;
            const right = w / 2 + halfW;
            const alpha = 0.15 + t * 0.55;
            const hue = s.theme.neonHue + (1 - t) * 60;

            // Build polyline across this row
            ctx.beginPath();
            for (let b = 0; b < BARS; b++) {
                const v = this.history[idx * BARS + b];
                const x = left + (b / (BARS - 1)) * (right - left);
                const y = rowY - v * peakH * (0.4 + t * 0.6);
                if (b === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            // Close back along the row baseline so we can fill under the line
            ctx.lineTo(right, rowY);
            ctx.lineTo(left, rowY);
            ctx.closePath();

            // Fill under the curve — translucent so layers blend
            ctx.fillStyle = `hsla(${hue}, 92%, 50%, ${alpha * 0.22})`;
            ctx.fill();

            // Stroke the top edge for ridgeline definition
            ctx.beginPath();
            for (let b = 0; b < BARS; b++) {
                const v = this.history[idx * BARS + b];
                const x = left + (b / (BARS - 1)) * (right - left);
                const y = rowY - v * peakH * (0.4 + t * 0.6);
                if (b === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = `hsla(${hue}, 92%, 75%, ${alpha})`;
            ctx.lineWidth = 0.9;
            ctx.stroke();
        }

        // Horizon glow — soft cyan band where the terrain meets the sky.
        const skyGrad = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 4);
        skyGrad.addColorStop(0, `hsla(${s.theme.neonHue}, 92%, 60%, 0)`);
        skyGrad.addColorStop(1, `hsla(${s.theme.neonHue}, 92%, 60%, 0.25)`);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, horizon - 40, w, 44);
    }
}

export const waveTerrainDef: VizModeDef = {
    id: 'wave-terrain',
    name: 'WAVE TERRAIN',
    create: () => new WaveTerrainMode(),
};
