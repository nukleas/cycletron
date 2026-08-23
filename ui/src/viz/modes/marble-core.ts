/**
 * MARBLE CORE — concentric rings rotating at integer multiples of the cycle
 * ("clockwork" feel), with orbiting orbs and an FFT-driven core glow.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, beatEnv} from '../util.js';

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
    hue: number;
}

class MarbleCoreMode implements VizMode {
    private rings: Array<{ radius: number; cyclesPerRev: number; phaseOffset: number; hue: number }> = [];
    private orbs: Array<{ baseAngle: number; cyclesPerRev: number; radius: number; size: number; hue: number }> = [];
    private particles: Particle[] = [];

    layout(s: VizServices): void {
        this.rings.length = 0;
        this.orbs.length = 0;

        // Integer-ratio rotation rates → "clockwork" feel
        const ringSpec: Array<{ radius: number; cyclesPerRev: number; hueShift: number }> = [
            { radius: 80, cyclesPerRev: 4, hueShift: 0 },
            { radius: 132, cyclesPerRev: 2, hueShift: 28 },
            { radius: 184, cyclesPerRev: 1, hueShift: 58 },
            { radius: 236, cyclesPerRev: 0.5, hueShift: 92 },
            { radius: 288, cyclesPerRev: 0.25, hueShift: 130 },
        ];
        for (let i = 0; i < ringSpec.length; i++) {
            const spec = ringSpec[i];
            this.rings.push({
                radius: spec.radius,
                cyclesPerRev: spec.cyclesPerRev,
                phaseOffset: i * 0.4,
                hue: s.theme.neonHue + spec.hueShift,
            });
        }

        const orbSpecs = [1, 2, 3, 4, 6, 8];
        for (let i = 0; i < orbSpecs.length; i++) {
            this.orbs.push({
                baseAngle: (i / orbSpecs.length) * TAU,
                cyclesPerRev: orbSpecs[i],
                radius: 100 + (i % 3) * 44,
                size: 4.5 + (i % 3),
                hue: s.theme.neonHue + (i % 5) * 18,
            });
        }
    }

    update(dt: number, s: VizServices): void {
        const low = s.low;
        // Rings & orbs are positioned from the cycle directly in render —
        // here we only spawn FFT-driven impact particles on strong low hits.
        if (low > 0.55 && Math.random() < low * dt * 9) {
            const angle = Math.random() * TAU;
            const r = 70 + Math.random() * 160;
            this.particles.push({
                x: s.width / 2 + Math.cos(angle) * r,
                y: s.height / 2 + Math.sin(angle) * r * 0.6,
                vx: Math.cos(angle) * (22 + low * 35),
                vy: Math.sin(angle) * (18 + low * 28),
                life: 0.45 + low * 0.5,
                size: 2.5 + low * 3,
                hue: s.theme.activeHue + low * 30,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.96;
            p.vy *= 0.96;
            p.life -= dt * 1.4;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h, low, mid} = s;
        const cx = w / 2;
        const cy = h / 2;
        const cyclePhase = s.cycle * TAU;
        const beat = beatEnv(s.cycle * 4);
        const downbeat = beatEnv(s.cycle);

        // Sweeping "playhead" arm — one revolution per bar, very obvious
        // cycle-locked motion.
        const armAngle = cyclePhase;
        const armOuter = Math.min(w, h) * 0.45;
        const armGrad = ctx.createLinearGradient(
            cx, cy,
            cx + Math.cos(armAngle) * armOuter,
            cy + Math.sin(armAngle) * armOuter,
        );
        armGrad.addColorStop(0, `hsla(${s.theme.neonHue}, 92%, 70%, 0)`);
        armGrad.addColorStop(1, `hsla(${s.theme.neonHue}, 92%, 72%, 0.28)`);
        ctx.strokeStyle = armGrad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(armAngle) * armOuter, cy + Math.sin(armAngle) * armOuter);
        ctx.stroke();

        // Rings — rotation locked to integer ratios of the cycle. Brightness
        // pumps with quarter-beat so the cycle lock reads at a glance.
        for (const ring of this.rings) {
            const ringPhase = cyclePhase * ring.cyclesPerRev + ring.phaseOffset;
            const r = ring.radius + Math.sin(ringPhase) * (4 + low * 7) + downbeat * 6;
            // Each ring brightens when its own phase wraps — those local accents
            // are what make integer ratios visible.
            const ringBeat = beatEnv(ringPhase / TAU);
            const alpha = 0.22 + ringBeat * 0.4 + beat * 0.1;

            ctx.strokeStyle = `hsla(${ring.hue}, 88%, 72%, ${alpha})`;
            ctx.lineWidth = 1.6 + ringBeat * 1.8;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, TAU);
            ctx.stroke();

            // Longer, brighter tick marks — much more obvious rotation
            const tickCount = 8;
            const tickLen = 10 + ringBeat * 6;
            ctx.strokeStyle = `hsla(${ring.hue}, 95%, 82%, ${alpha * 0.9})`;
            ctx.lineWidth = 1.4;
            for (let i = 0; i < tickCount; i++) {
                const a = ringPhase + (i / tickCount) * TAU;
                const x1 = cx + Math.cos(a) * (r - tickLen * 0.5);
                const y1 = cy + Math.sin(a) * (r - tickLen * 0.5);
                const x2 = cx + Math.cos(a) * (r + tickLen * 0.5);
                const y2 = cy + Math.sin(a) * (r + tickLen * 0.5);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }

        // Orbs — orbit at integer rates with a beat-driven size pulse
        for (const orb of this.orbs) {
            const angle = orb.baseAngle + cyclePhase * orb.cyclesPerRev;
            const orbBeat = beatEnv(angle / TAU);
            const x = cx + Math.cos(angle) * orb.radius;
            const y = cy + Math.sin(angle) * orb.radius * 0.58;
            const sizeBoost = 1 + orbBeat * 1.4;

            ctx.fillStyle = `hsla(${orb.hue}, 95%, 75%, ${0.10 + orbBeat * 0.28})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * 2.6 * sizeBoost, 0, TAU);
            ctx.fill();

            ctx.fillStyle = `hsla(${orb.hue}, 92%, 82%, ${0.45 + orbBeat * 0.4})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * sizeBoost, 0, TAU);
            ctx.fill();
        }

        // Impact particles
        for (const p of this.particles) {
            const a = Math.max(0.1, p.life / 1.1);
            ctx.fillStyle = `hsla(${p.hue}, 90%, 78%, ${a})`;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }

        // FFT-reactive core glow
        const coreSize = 18 + (low + mid) * 11;
        const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, coreSize * 1.8);
        grad.addColorStop(0, `hsla(${s.theme.secondaryHue}, 90%, 60%, ${0.35 + (low + mid) * 0.25})`);
        grad.addColorStop(1, `hsla(${s.theme.neonHue}, 92%, 60%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreSize * 1.9, 0, TAU);
        ctx.fill();
    }
}

export const marbleCoreDef: VizModeDef = {
    id: 'marble-core',
    name: 'MARBLE CORE',
    create: () => new MarbleCoreMode(),
};
