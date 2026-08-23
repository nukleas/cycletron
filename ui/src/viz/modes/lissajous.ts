/**
 * LISSAJOUS SCOPE — plot the time-domain waveform against a delayed copy of
 * itself (x[i], x[i + offset]). Folds into complex symmetric curves whose
 * topology shifts on each beat. Trail-painted via the fading background so
 * motion smears beautifully.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';

class LissajousMode implements VizMode {
    private offset = 32;
    private lastBeatIndex = -1;

    layout(_s: VizServices): void {}

    update(_dt: number, s: VizServices): void {
        // Phase shift bumps on each beat — gives the scope curve a fresh
        // topology every quarter note instead of staying static.
        const beatIndex = Math.floor(s.cycle * 4);
        if (beatIndex !== this.lastBeatIndex) {
            this.lastBeatIndex = beatIndex;
            // Walk through offset values that produce visually distinct shapes.
            const choices = [24, 48, 64, 96, 128, 160];
            this.offset = choices[((beatIndex % choices.length) + choices.length) % choices.length];
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (!s.timeData) return;
        const data = s.timeData;
        const N = data.length;
        const off = this.offset;
        if (N < off + 4) return;

        const {width: w, height: h} = s;
        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(w, h) * 0.42;

        // Hue rotates slowly with the cycle for variety between beats.
        const hue = (s.cycle * 30) % 360;
        ctx.strokeStyle = `hsla(${hue}, 95%, 75%, 0.65)`;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        for (let i = 0; i < N - off; i++) {
            // Map 0..255 → -1..1, scale to fit
            const x = ((data[i] - 128) / 128) * scale + cx;
            const y = ((data[i + off] - 128) / 128) * scale + cy;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Subtle inner highlight stroke for a "phosphor" feel.
        ctx.strokeStyle = `hsla(${hue + 20}, 100%, 90%, 0.35)`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
    }
}

export const lissajousDef: VizModeDef = {
    id: 'lissajous',
    name: 'LISSAJOUS SCOPE',
    trailFade: 0.16,
    create: () => new LissajousMode(),
};
