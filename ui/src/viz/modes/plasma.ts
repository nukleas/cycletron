/**
 * PLASMA — additively-blended metaballs. Each ball drifts and bounces off the
 * canvas edges; bass + energy pulse the radii for slow breath. Overlapping
 * radial gradients sum to the classic "fused liquid" look without per-pixel
 * field calculation.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU} from '../util.js';

interface Ball {
    x: number;
    y: number;
    vx: number;
    vy: number;
    baseR: number;
    hue: number;
    phase: number;
}

class PlasmaMode implements VizMode {
    private balls: Ball[] = [];
    private bassPulse = 0;

    layout(s: VizServices): void {
        if (this.balls.length > 0 || s.width === 0) return;
        const COUNT = 7;
        const hues = [
            s.theme.neonHue,
            s.theme.secondaryHue,
            s.theme.activeHue,
            s.theme.neonHue + 40,
            s.theme.secondaryHue - 30,
            s.theme.activeHue - 20,
            260, // violet
        ];
        for (let i = 0; i < COUNT; i++) {
            const angle = (i / COUNT) * TAU;
            const speed = 24 + Math.random() * 18;
            this.balls.push({
                x: s.width * 0.5 + Math.cos(angle) * s.width * 0.18,
                y: s.height * 0.5 + Math.sin(angle) * s.height * 0.18,
                vx: Math.cos(angle + 1.5) * speed,
                vy: Math.sin(angle + 1.5) * speed,
                baseR: 60 + Math.random() * 30,
                hue: hues[i],
                phase: Math.random() * TAU,
            });
        }
    }

    update(dt: number, s: VizServices): void {
        if (this.balls.length === 0) this.layout(s);
        const energy = (s.low * 0.6 + s.mid * 0.9 + s.high * 0.7) * 0.6;

        for (const b of this.balls) {
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.phase += dt * (0.4 + energy * 0.5);

            // Wall bounce with a slight velocity reset so balls don't get
            // trapped along an edge.
            if (b.x < b.baseR * 0.5) {
                b.x = b.baseR * 0.5;
                b.vx = Math.abs(b.vx);
            } else if (b.x > s.width - b.baseR * 0.5) {
                b.x = s.width - b.baseR * 0.5;
                b.vx = -Math.abs(b.vx);
            }
            if (b.y < b.baseR * 0.5) {
                b.y = b.baseR * 0.5;
                b.vy = Math.abs(b.vy);
            } else if (b.y > s.height - b.baseR * 0.5) {
                b.y = s.height - b.baseR * 0.5;
                b.vy = -Math.abs(b.vy);
            }
        }

        this.bassPulse = s.low;
    }

    render(ctx: CanvasRenderingContext2D, _s: VizServices): void {
        const low = this.bassPulse;

        ctx.globalCompositeOperation = 'lighter';
        for (const b of this.balls) {
            const breath = 1 + Math.sin(b.phase) * 0.12;
            const pulse = 1 + low * 0.45;
            const r = b.baseR * breath * pulse;

            const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
            grad.addColorStop(0, `hsla(${b.hue}, 95%, 65%, 0.55)`);
            grad.addColorStop(0.45, `hsla(${b.hue}, 95%, 55%, 0.18)`);
            grad.addColorStop(1, `hsla(${b.hue}, 95%, 50%, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(b.x - r, b.y - r, r * 2, r * 2);
        }
        ctx.globalCompositeOperation = 'source-over';
    }
}

export const plasmaDef: VizModeDef = {
    id: 'plasma',
    name: 'PLASMA',
    trailFade: 0.35,
    create: () => new PlasmaMode(),
};
