/**
 * FLAME GRAPH — Winamp-style spectrum flame: one big silhouette across the
 * canvas driven by raw FFT bins with log-frequency mapping (more resolution
 * in the bass), peak-hold dots, and rising tongue particles.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, barHue} from '../util.js';

const FLAME_BARS = 64;

interface Tongue {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
    hue: number;
}

class FlameGraphMode implements VizMode {
    private bars = new Float32Array(FLAME_BARS);   // smoothed heights 0..1
    private peaks = new Float32Array(FLAME_BARS);  // peak-hold positions 0..1
    private particles: Tongue[] = [];

    layout(_s: VizServices): void {
        // Screen-relative rendering — nothing to precompute.
    }

    update(dt: number, s: VizServices): void {
        if (!s.freqData) return;
        const N = FLAME_BARS;
        const binCount = s.freqData.length;
        // Above ~half the bins is mostly air, use the bottom half for legibility.
        const usableBins = Math.max(8, Math.floor(binCount * 0.55));

        // Sample raw FFT with a log-frequency curve so bass occupies more
        // visual width (musical perception is logarithmic).
        for (let i = 0; i < N; i++) {
            const t0 = i / N;
            const t1 = (i + 1) / N;
            const b0 = Math.floor(Math.pow(t0, 2) * usableBins);
            const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 2) * usableBins));

            let peak = 0;
            for (let b = b0; b < b1 && b < binCount; b++) {
                const v = s.freqData[b];
                if (v > peak) peak = v;
            }
            const target = (peak / 255) * s.sensitivity;

            // Classic spectrum analyzer feel: instant rise, gradual fall.
            const curr = this.bars[i];
            this.bars[i] = target > curr
                ? target
                : Math.max(0, curr + (target - curr) * Math.min(1, dt * 4));

            // Peak-hold: matches current bar on rise, decays slowly on fall.
            const peakVal = this.peaks[i];
            if (this.bars[i] >= peakVal) {
                this.peaks[i] = this.bars[i];
            } else {
                this.peaks[i] = Math.max(0, peakVal - dt * 0.55);
            }
        }

        // Light spatial smoothing — averages each bar with neighbors so the
        // flame silhouette flows instead of looking like 32-pixel pixel art.
        const smoothed = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const a = this.bars[Math.max(0, i - 1)];
            const b = this.bars[i];
            const c = this.bars[Math.min(N - 1, i + 1)];
            smoothed[i] = a * 0.25 + b * 0.5 + c * 0.25;
        }
        this.bars.set(smoothed);

        // Rising tongue particles — only on loud bars.
        const spawnPx = s.height;
        for (let i = 0; i < N; i++) {
            const v = this.bars[i];
            if (v > 0.45 && Math.random() < v * dt * 5) {
                const px = ((i + 0.5) / N) * s.width;
                this.particles.push({
                    x: px + (Math.random() - 0.5) * 10,
                    y: spawnPx - v * spawnPx * 0.7,
                    vx: (Math.random() - 0.5) * 25,
                    vy: -40 - Math.random() * 55,
                    life: 0.45 + Math.random() * 0.35,
                    size: 1.8 + Math.random() * 1.4,
                    hue: barHue(i, N),
                });
            }
        }

        // Tongue physics — drift up, curl slightly, fade.
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy *= 0.96;
            p.vx *= 0.92;
            p.life -= dt * 1.6;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const N = FLAME_BARS;
        const baseY = h - 6;
        const maxH = h * 0.86;

        // Ember bed — a soft red glow strip along the base. Always present so
        // even silent passages show a faint hint of warmth.
        const emberGrad = ctx.createLinearGradient(0, baseY, 0, baseY - 60);
        emberGrad.addColorStop(0, 'hsla(10, 95%, 50%, 0.30)');
        emberGrad.addColorStop(1, 'hsla(20, 95%, 50%, 0)');
        ctx.fillStyle = emberGrad;
        ctx.fillRect(0, baseY - 60, w, 60);

        // Build the silhouette path — smooth quadratic curves between bar
        // midpoints so the flame's edge undulates instead of stepping.
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        for (let i = 0; i < N; i++) {
            const x = ((i + 0.5) / N) * w;
            const y = baseY - this.bars[i] * maxH;
            if (i === 0) {
                ctx.lineTo(0, y);
                ctx.lineTo(x, y);
            } else {
                const xPrev = ((i - 0.5) / N) * w;
                const yPrev = baseY - this.bars[i - 1] * maxH;
                const cx = (x + xPrev) * 0.5;
                const cy = (y + yPrev) * 0.5;
                ctx.quadraticCurveTo(xPrev, yPrev, cx, cy);
            }
        }
        ctx.lineTo(w, baseY);
        ctx.closePath();

        // Pass 1: horizontal HUE gradient — these are the "track colors".
        const hueGrad = ctx.createLinearGradient(0, 0, w, 0);
        hueGrad.addColorStop(0.00, 'hsla(0,   95%, 50%, 0.85)');
        hueGrad.addColorStop(0.25, 'hsla(20,  95%, 55%, 0.85)');
        hueGrad.addColorStop(0.50, 'hsla(45,  95%, 65%, 0.80)');
        hueGrad.addColorStop(0.75, 'hsla(120, 90%, 70%, 0.65)');
        hueGrad.addColorStop(1.00, `hsla(${s.theme.neonHue}, 95%, 75%, 0.55)`);
        ctx.fillStyle = hueGrad;
        ctx.fill();

        // Pass 2: vertical brightness fade via screen blend — burns the tips
        // brighter and the base saturated, giving the heat falloff.
        const heatGrad = ctx.createLinearGradient(0, baseY, 0, baseY - maxH);
        heatGrad.addColorStop(0.00, 'hsla(0, 0%, 0%, 0)');
        heatGrad.addColorStop(0.55, 'hsla(0, 0%, 100%, 0.18)');
        heatGrad.addColorStop(1.00, 'hsla(0, 0%, 100%, 0.45)');
        ctx.fillStyle = heatGrad;
        ctx.globalCompositeOperation = 'screen';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // Bright outline along the flame's top edge — same shape, just stroke.
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
            const x = ((i + 0.5) / N) * w;
            const y = baseY - this.bars[i] * maxH;
            if (i === 0) ctx.moveTo(x, y);
            else {
                const xPrev = ((i - 0.5) / N) * w;
                const yPrev = baseY - this.bars[i - 1] * maxH;
                const cx = (x + xPrev) * 0.5;
                const cy = (y + yPrev) * 0.5;
                ctx.quadraticCurveTo(xPrev, yPrev, cx, cy);
            }
        }
        ctx.strokeStyle = 'hsla(50, 100%, 85%, 0.45)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Peak-hold dots — small floating sparks along each bar's recent max.
        for (let i = 0; i < N; i++) {
            const p = this.peaks[i];
            if (p < 0.08) continue;
            const x = ((i + 0.5) / N) * w;
            const y = baseY - p * maxH;
            const hue = barHue(i, N);
            ctx.fillStyle = `hsla(${hue + 25}, 95%, 85%, 0.55)`;
            ctx.beginPath();
            ctx.arc(x, y, 1.8, 0, TAU);
            ctx.fill();
        }

        // Rising tongue particles — fade as they climb.
        for (const p of this.particles) {
            const a = Math.max(0.08, p.life);
            ctx.fillStyle = `hsla(${p.hue + 30}, 95%, 82%, ${a * 0.55})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, TAU);
            ctx.fill();
        }
    }
}

export const flameGraphDef: VizModeDef = {
    id: 'flame-graph',
    name: 'FLAME GRAPH',
    create: () => new FlameGraphMode(),
};
