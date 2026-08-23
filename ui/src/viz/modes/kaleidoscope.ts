/**
 * KALEIDOSCOPE — spawn particles inside one angular wedge (1/8 of the
 * circle), let them drift outward, then render the wedge 8 times mirrored
 * around the center. FFT energy controls spawn rate.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, beatEnv} from '../util.js';

const SLICES = 8;

interface WedgeParticle {
    r: number;
    angle: number;
    vr: number;
    life: number;
    hue: number;
    size: number;
}

class KaleidoscopeMode implements VizMode {
    private particles: WedgeParticle[] = [];

    layout(_s: VizServices): void {}

    update(dt: number, s: VizServices): void {
        const {low, mid, high} = s;
        const energy = (low + mid + high) / 3;
        const wedge = TAU / SLICES;
        const maxR = Math.min(s.width, s.height) * 0.55;

        // Spawn rate tracks total energy + a constant base so it's never empty
        const spawnRate = (1.2 + energy * 6) * dt;
        if (Math.random() < spawnRate) {
            this.particles.push({
                r: 12 + Math.random() * 24,
                angle: Math.random() * wedge,
                vr: 60 + Math.random() * 90 + low * 80,
                life: 1.0 + Math.random() * 0.4,
                hue: s.theme.neonHue + (Math.random() - 0.5) * 80,
                size: 1.8 + Math.random() * 1.6 + high * 1.5,
            });
        }

        // Drift outward, fade
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.r += p.vr * dt;
            p.life -= dt * 0.85;
            if (p.life <= 0 || p.r > maxR) {
                this.particles.splice(i, 1);
            }
        }

        // Cap particle count
        if (this.particles.length > 280) {
            this.particles.splice(0, this.particles.length - 280);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const cx = w / 2;
        const cy = h / 2;

        // Reusable lambda — draws all particles within the canonical wedge.
        const drawWedge = (): void => {
            for (const p of this.particles) {
                const px = Math.cos(p.angle) * p.r;
                const py = Math.sin(p.angle) * p.r;
                const a = Math.max(0.05, p.life);

                // Glow halo
                ctx.fillStyle = `hsla(${p.hue}, 95%, 70%, ${a * 0.18})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size * 3.2, 0, TAU);
                ctx.fill();

                // Core
                ctx.fillStyle = `hsla(${p.hue}, 95%, 82%, ${a * 0.85})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, TAU);
                ctx.fill();
            }

            // A faint outline of the wedge boundary helps the symmetry read
            const maxR = Math.min(w, h) * 0.5;
            ctx.strokeStyle = `hsla(${s.theme.neonHue}, 92%, 70%, 0.06)`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(maxR, 0);
            ctx.stroke();
        };

        ctx.save();
        ctx.translate(cx, cy);
        for (let slice = 0; slice < SLICES; slice++) {
            ctx.save();
            ctx.rotate((slice / SLICES) * TAU);
            // Mirror every other wedge for a true kaleidoscope reflection.
            if (slice % 2 === 1) ctx.scale(1, -1);
            drawWedge();
            ctx.restore();
        }
        ctx.restore();

        // Center pulse — soft glow that breathes with the cycle.
        const pulse = beatEnv(s.cycle * 4);
        const coreR = 6 + pulse * 14;
        const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2);
        coreGrad.addColorStop(0, `hsla(${s.theme.neonHue}, 100%, 85%, ${0.4 + pulse * 0.4})`);
        coreGrad.addColorStop(1, `hsla(${s.theme.neonHue}, 100%, 60%, 0)`);
        ctx.fillStyle = coreGrad;
        ctx.fillRect(cx - coreR * 2, cy - coreR * 2, coreR * 4, coreR * 4);
    }
}

export const kaleidoscopeDef: VizModeDef = {
    id: 'kaleidoscope',
    name: 'KALEIDOSCOPE',
    create: () => new KaleidoscopeMode(),
};
