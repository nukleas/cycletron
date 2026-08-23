/**
 * TUNNEL — concentric octagons receding to a vanishing point. Cycle-locked
 * rotation; on each downbeat a forward-velocity boost lurches the camera
 * deeper into the tunnel before settling back to baseline drift.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU} from '../util.js';

const RING_COUNT = 18;

class TunnelMode implements VizMode {
    private rings: Array<{ z: number; angle: number; hueShift: number }> = [];
    private zVel = 1.0;
    private lastDownbeat = -1;

    constructor() {
        for (let i = 0; i < RING_COUNT; i++) {
            this.rings.push({
                z: (i + 1) / RING_COUNT,        // 0 = at camera, 1 = vanishing point
                angle: (i / RING_COUNT) * TAU,  // staggered rotation phase
                hueShift: (i % 4) * 22,
            });
        }
    }

    layout(_s: VizServices): void {}

    update(dt: number, s: VizServices): void {
        const {low, mid, high} = s;
        const energy = (low * 0.6 + mid * 0.9 + high * 0.7) * 0.6;

        // Constant forward drift + an instantaneous boost on the downbeat.
        const downbeatIdx = Math.floor(s.cycle);
        if (downbeatIdx !== this.lastDownbeat) {
            this.lastDownbeat = downbeatIdx;
            this.zVel = 3.6;
        }
        // Decay the boost smoothly so the tunnel lurches forward then settles.
        this.zVel = Math.max(0.9, this.zVel - dt * 5.5);

        // Audio energy mildly accelerates baseline drift.
        const drift = this.zVel * (0.55 + energy * 0.8);

        // Advance every ring; recycle ones past the camera to the vanishing point.
        for (const ring of this.rings) {
            ring.z -= drift * dt * 0.45;
            if (ring.z <= 0) ring.z += 1;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const cx = w / 2;
        const cy = h / 2;
        const maxR = Math.min(w, h) * 0.55;
        const SIDES = 8;
        const neonHue = s.theme.neonHue;
        const secHue = s.theme.secondaryHue;

        // Sort rings far-to-near so closer ones paint over farther ones.
        const ringsByZ = [...this.rings].sort((a, b) => b.z - a.z);

        const baseAngle = s.cycle * TAU * 0.25; // 1 full rotation per 4 bars

        for (const ring of ringsByZ) {
            // Perspective: scale falls off as z increases. Pinch near the
            // vanishing point so rings really shrink to a dot.
            const persp = 1 - ring.z;
            if (persp <= 0.01) continue;
            const r = maxR * persp;

            // Mix between cyan and magenta along the depth axis
            const hue = neonHue + (secHue - neonHue) * (1 - persp) * 0.6 + ring.hueShift;

            // Per-ring rotation phase — half rings spin clockwise, half CCW
            // for a "depth contrast" feel.
            const dir = (ring.hueShift / 22) % 2 === 0 ? 1 : -1;
            const angle = baseAngle * dir + ring.angle;

            ctx.beginPath();
            for (let side = 0; side <= SIDES; side++) {
                const a = angle + (side / SIDES) * TAU;
                const x = cx + Math.cos(a) * r;
                const y = cy + Math.sin(a) * r;
                if (side === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();

            // Alpha + thickness rise toward the camera
            ctx.strokeStyle = `hsla(${hue}, 92%, 72%, ${0.12 + persp * 0.55})`;
            ctx.lineWidth = 0.6 + persp * 2.2;
            ctx.stroke();

            // Subtle radial spokes at the brightest rings — emphasizes depth
            if (persp > 0.55) {
                ctx.strokeStyle = `hsla(${hue}, 92%, 78%, ${(persp - 0.55) * 0.35})`;
                ctx.lineWidth = 0.6;
                ctx.beginPath();
                for (let side = 0; side < SIDES; side++) {
                    const a = angle + (side / SIDES) * TAU;
                    const x1 = cx + Math.cos(a) * r * 0.78;
                    const y1 = cy + Math.sin(a) * r * 0.78;
                    const x2 = cx + Math.cos(a) * r;
                    const y2 = cy + Math.sin(a) * r;
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                }
                ctx.stroke();
            }
        }

        // Vanishing-point glow — gives the tunnel a "light at the end" feel.
        const vpGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.12);
        vpGrad.addColorStop(0, `hsla(${neonHue}, 100%, 85%, 0.55)`);
        vpGrad.addColorStop(1, `hsla(${neonHue}, 100%, 70%, 0)`);
        ctx.fillStyle = vpGrad;
        ctx.fillRect(cx - maxR * 0.12, cy - maxR * 0.12, maxR * 0.24, maxR * 0.24);
    }
}

export const tunnelDef: VizModeDef = {
    id: 'tunnel',
    name: 'TUNNEL',
    create: () => new TunnelMode(),
};
