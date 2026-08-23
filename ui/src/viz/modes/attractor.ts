/**
 * STRANGE ATTRACTOR — Lorenz attractor integrated forward in time. FFT bands
 * modulate the three parameters so the "shape" of the chaos breathes:
 *   sigma (10)  — bass mildly raises it (compresses spiral)
 *   rho   (28)  — high band pushes the butterfly wider
 *   beta  (8/3) — mid keeps it stable
 * Trail is a ring buffer of recent points rendered as a fading polyline.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU} from '../util.js';

const TRAIL_CAP = 720;

class AttractorMode implements VizMode {
    private x = 0.1;
    private y = 0;
    private z = 0;
    private trail = new Float32Array(TRAIL_CAP * 3);   // [x, y, z] triples
    private head = 0;

    layout(_s: VizServices): void {}

    update(dt: number, s: VizServices): void {
        const sigma = 10 + s.low * 4;
        const rho = 28 + s.high * 18;
        const beta = 8 / 3 + s.mid * 0.6;

        // Sub-step the integration so the trail is smooth even at low frame rate.
        const subSteps = 6;
        const h = Math.min(dt, 1 / 30) / subSteps;
        for (let step = 0; step < subSteps; step++) {
            const dx = sigma * (this.y - this.x);
            const dy = this.x * (rho - this.z) - this.y;
            const dz = this.x * this.y - beta * this.z;
            this.x += dx * h;
            this.y += dy * h;
            this.z += dz * h;
            const head = this.head;
            this.trail[head * 3 + 0] = this.x;
            this.trail[head * 3 + 1] = this.y;
            this.trail[head * 3 + 2] = this.z;
            this.head = (head + 1) % TRAIL_CAP;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const cx = w / 2;
        const cy = h * 0.55;
        // Lorenz coordinates roam roughly in [-30, 30] for x/y, [0, 50] for z.
        const scale = Math.min(w, h) / 70;
        const head = this.head;

        const baseHue = s.theme.neonHue;
        const secHue = s.theme.secondaryHue;
        const cycleHue = (s.cycle * 18) % 360;

        // Iterate oldest → newest so that newer segments paint over older.
        ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < TRAIL_CAP; i++) {
            const idx = (head + i) % TRAIL_CAP;
            const t = i / (TRAIL_CAP - 1); // 0 = oldest, 1 = newest
            const x = this.trail[idx * 3 + 0];
            const y = this.trail[idx * 3 + 1];
            const z = this.trail[idx * 3 + 2];
            // Project (x, y, z) → 2D. z shifts upward, y becomes vertical.
            const sx = cx + x * scale;
            const sy = cy + (y * 0.6 - z) * scale;

            if (!started) {
                ctx.moveTo(sx, sy);
                started = true;
            } else {
                ctx.lineTo(sx, sy);
            }

            // Periodically stroke segments so we can recolor by age. Stroking
            // every point is expensive; do it in batches.
            if ((i & 31) === 31 || i === TRAIL_CAP - 1) {
                const hue = baseHue + (secHue - baseHue) * t * 0.6 + cycleHue;
                ctx.strokeStyle = `hsla(${hue}, 95%, ${50 + t * 35}%, ${0.05 + t * 0.6})`;
                ctx.lineWidth = 0.6 + t * 1.6;
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(sx, sy);
            }
        }

        // Bright head point — emphasizes "where we are now".
        const hx = cx + this.x * scale;
        const hy = cy + (this.y * 0.6 - this.z) * scale;
        ctx.fillStyle = `hsla(${baseHue + cycleHue}, 100%, 85%, 0.9)`;
        ctx.beginPath();
        ctx.arc(hx, hy, 3, 0, TAU);
        ctx.fill();
    }
}

export const attractorDef: VizModeDef = {
    id: 'attractor',
    name: 'STRANGE ATTRACTOR',
    trailFade: 0.16,
    create: () => new AttractorMode(),
};
