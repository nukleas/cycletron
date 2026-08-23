/**
 * NEON CIRCUIT — network of nodes + flowing traces. Node pulses lock to the
 * pattern cycle; particles ride FFT energy; downbeats fire a shockwave ring.
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

class NeonCircuitMode implements VizMode {
    private nodes: Array<{ x: number; y: number; offset: number }> = [];
    private particles: Particle[] = [];

    layout(s: VizServices): void {
        this.nodes.length = 0;
        const cx = s.width / 2;
        const cy = s.height / 2;
        const count = Math.min(32, Math.max(12, Math.floor(Math.max(s.width, s.height) / 36)));
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * TAU;
            const r = Math.min(s.width, s.height) * (0.22 + (i % 5) * 0.035);
            this.nodes.push({
                x: cx + Math.cos(angle) * r,
                y: cy + Math.sin(angle) * r * 0.72,
                offset: (i / count) * TAU * 0.5,
            });
        }
    }

    update(dt: number, s: VizServices): void {
        const {low, mid, high} = s;
        const energy = (low * 0.6 + mid * 0.9 + high * 0.7) * 0.6;
        const cx = s.width / 2;
        const cy = s.height / 2;

        // Particle spawn rate tracks mid+high (transients)
        const spawnRate = (0.6 + mid * 1.8) * dt * 4;
        if (Math.random() < spawnRate) {
            const angle = Math.random() * TAU;
            const speed = 18 + high * 42 + Math.random() * 12;
            this.particles.push({
                x: cx + Math.cos(angle) * (40 + Math.random() * 80),
                y: cy + Math.sin(angle) * (30 + Math.random() * 60),
                vx: Math.cos(angle + (Math.random() - 0.5) * 0.8) * speed,
                vy: Math.sin(angle + (Math.random() - 0.5) * 0.8) * speed,
                life: 0.6 + energy * 0.9 + Math.random() * 0.5,
                size: 1.2 + high * 1.8,
                hue: s.theme.neonHue + (high - low) * 35,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.985;
            p.vy *= 0.985;
            p.life -= dt * (0.7 + low * 0.6);
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h, low, mid, high} = s;
        const neonHue = s.theme.neonHue;
        const secondaryHue = s.theme.secondaryHue;
        const cx = w / 2;
        const cy = h / 2;

        // Cycle = 1 bar. Pulse at quarter-note (4×) for "beat" feel; downbeat
        // (1×) for once-per-bar accents. beatEnv = sharp attack, slow decay.
        const beat = beatEnv(s.cycle * 4);
        const downbeat = beatEnv(s.cycle);
        const cyclePhase = s.cycle * TAU;

        // Connections behind nodes — alpha pulses with the quarter-beat
        const beatBoost = 0.28 + beat * 0.55;
        ctx.lineWidth = 0.8 + beat * 1.4;
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i];
                const b = this.nodes[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 260 || dist < 18) continue;

                const alpha = Math.max(0.08, 0.55 - dist / 260) * (0.4 + mid * 0.9) * beatBoost;
                ctx.strokeStyle = `hsla(${neonHue}, 92%, 68%, ${alpha})`;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
        }

        // Particles (data packets)
        ctx.fillStyle = s.theme.neon;
        for (const p of this.particles) {
            const alpha = Math.max(0.15, p.life / 1.4);
            ctx.globalAlpha = alpha;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }
        ctx.globalAlpha = 1;

        // Nodes — radius driven by quarter-beat (1.0 → 0 each beat). Position
        // breathes outward on the beat too.
        const breathePx = 12 * beat;
        for (const node of this.nodes) {
            // Offset per-node so nodes don't pulse in unison — gives a ripple
            const localBeat = beatEnv(s.cycle * 4 + node.offset * 0.25);
            const r = 3.5 + localBeat * 8 + high * 3;

            const dx = node.x - cx;
            const dy = node.y - cy;
            const d = Math.hypot(dx, dy) || 1;
            const px = node.x + (dx / d) * breathePx * 0.6;
            const py = node.y + (dy / d) * breathePx * 0.6;

            // Glow halo — translucent so code stays readable behind it
            ctx.fillStyle = `hsla(${neonHue}, 92%, 68%, ${0.04 + localBeat * 0.22})`;
            ctx.beginPath();
            ctx.arc(px, py, r * 3.2, 0, TAU);
            ctx.fill();

            // Core — also translucent, fully present only on the beat
            ctx.fillStyle = `hsla(${neonHue}, 92%, 70%, ${0.35 + localBeat * 0.55})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, TAU);
            ctx.fill();
        }

        // Downbeat shockwave — expanding ring from center on every bar
        if (downbeat > 0.02) {
            const t = 1 - downbeat;
            const ringR = Math.min(w, h) * 0.05 + t * Math.min(w, h) * 0.55;
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 70%, ${downbeat * 0.45})`;
            ctx.lineWidth = 1 + downbeat * 2.4;
            ctx.beginPath();
            ctx.arc(cx, cy, ringR, 0, TAU);
            ctx.stroke();
        }

        // Horizontal data bus — alpha also tracks the beat
        if (low > 0.2 || beat > 0.4) {
            const busAlpha = (0.2 + low * 0.35) * (0.4 + beat * 0.8);
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 65%, ${busAlpha})`;
            ctx.lineWidth = 1.5 + low * 1.2 + beat * 1.5;
            const y = h * (0.28 + Math.sin(cyclePhase * 0.5) * 0.12);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }
}

export const neonCircuitDef: VizModeDef = {
    id: 'neon-circuit',
    name: 'NEON CIRCUIT',
    create: () => new NeonCircuitMode(),
};
