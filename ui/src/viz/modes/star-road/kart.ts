/**
 * STAR ROAD karts, seen from behind: an original wedge kart with fat rear
 * wheels, a rear wing, twin exhausts and a helmeted driver. Drawn as a vector
 * sprite at its projected position, `k` pixels per meter. Drift sparks and the
 * boost flame are pure functions of time, so a render replays exactly.
 */

import {TAU, hash32, rand01} from '../../util.js';

export interface KartLook {
    /** Body color. */
    body: string;
    /** Darker trim: bumper, wing, helmet stripe. */
    trim: string;
}

/** Drift spark tiers: blue, orange, purple. Body and hot core. */
export const SPARK_TIERS: ReadonlyArray<readonly [string, string]> = [
    ['#3ec6ff', '#a0f4ff'],
    ['#ff8c1a', '#ffd24a'],
    ['#d24bff', '#ff8ae8'],
];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/**
 * Kart at ground point (x, y) on screen. `lean` (radians) tilts it into a
 * drift and shows a little of the side; `bob` lifts it on bumps.
 */
export function drawKart(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, look: KartLook, lean: number, bob = 0): void {
    if (k < 0.8) return;
    ctx.save();
    ctx.translate(x, y - bob * k);
    ctx.rotate(lean * 0.35);
    ctx.scale(k, k);
    ctx.lineJoin = 'round';

    // Contact shadow.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 0.02, 0.78, 0.13, 0, 0, TAU);
    ctx.fill();

    // A drift turns the kart: the side shows, the far wheel tucks in.
    const side = Math.sin(lean) * 0.35;

    // Body: a wedge, wider at the floor.
    const body = ctx.createLinearGradient(0, -0.5, 0, -0.16);
    body.addColorStop(0, '#adc2d0');
    body.addColorStop(0.18, look.body);
    body.addColorStop(1, '#202e40');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-0.5 + side, -0.16);
    ctx.lineTo(0.5 + side, -0.16);
    ctx.lineTo(0.42 + side * 1.4, -0.5);
    ctx.lineTo(-0.42 + side * 1.4, -0.5);
    ctx.closePath();
    ctx.fill();
    if (Math.abs(side) > 0.02) {
        ctx.fillStyle = look.trim;
        ctx.beginPath();
        const e = side > 0 ? -0.5 : 0.5;
        ctx.moveTo(e + side, -0.16);
        ctx.lineTo(e + side * 3.2, -0.2);
        ctx.lineTo(e * 0.84 + side * 3, -0.48);
        ctx.lineTo(e * 0.84 + side * 1.4, -0.5);
        ctx.closePath();
        ctx.fill();
    }
    // Bumper and number plate.
    ctx.fillStyle = look.trim;
    ctx.fillRect(-0.44 + side, -0.24, 0.88, 0.08);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(-0.1 + side, -0.4, 0.2, 0.1);

    // Exhausts.
    ctx.fillStyle = '#3a3f48';
    for (const ex of [-0.18, 0.18]) {
        ctx.beginPath();
        ctx.arc(ex + side, -0.28, 0.06, 0, TAU);
        ctx.fill();
    }

    // Rear wheels.
    for (const wx of [-0.56, 0.56]) {
        const tuck = wx * Math.sign(side) > 0 ? 0.85 : 1;
        ctx.fillStyle = '#121218';
        ctx.beginPath();
        roundRect(ctx, wx + side * 0.6 - 0.15 * tuck, -0.44, 0.3 * tuck, 0.44, 0.07);
        ctx.fill();
        ctx.fillStyle = '#4a4f5c';
        ctx.fillRect(wx + side * 0.6 - 0.11 * tuck, -0.3, 0.22 * tuck, 0.05);
    }

    // Seat back, driver and helmet.
    ctx.fillStyle = '#1a2030';
    ctx.beginPath();
    roundRect(ctx, -0.22 + side * 1.6, -0.74, 0.44, 0.28, 0.08);
    ctx.fill();
    const helmet = ctx.createLinearGradient(-0.2, -1.1, 0.2, -0.7);
    helmet.addColorStop(0, '#afc3d0'); helmet.addColorStop(0.5, '#52687d'); helmet.addColorStop(1, '#202d40');
    ctx.fillStyle = helmet;
    ctx.beginPath();
    ctx.arc(side * 2, -0.9, 0.22, 0, TAU);
    ctx.fill();
    ctx.fillStyle = look.trim;
    ctx.fillRect(-0.05 + side * 2, -1.12, 0.1, 0.44);

    // Rear wing on two struts.
    ctx.fillStyle = look.trim;
    ctx.fillRect(-0.3 + side * 1.4, -0.6, 0.04, 0.12);
    ctx.fillRect(0.26 + side * 1.4, -0.6, 0.04, 0.12);
    ctx.fillStyle = '#26394b';
    ctx.beginPath();
    roundRect(ctx, -0.5 + side * 1.5, -0.68, 1.0, 0.09, 0.03);
    ctx.fill();
    // Fine illuminated wing edge and two rear lamps keep each track identifiable.
    ctx.fillStyle = look.body;
    ctx.fillRect(-0.46 + side * 1.5, -0.68, 0.92, 0.012);
    ctx.fillStyle = look.trim;
    ctx.fillRect(-0.4 + side, -0.37, 0.18, 0.025);
    ctx.fillRect(0.22 + side, -0.37, 0.18, 0.025);
    ctx.restore();
}

/**
 * Twin exhaust flames toward the camera. `power` 0..1 sets the length;
 * `tier` picks the core: 0 blue-white, 1 warm, 2 violet.
 */
export function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, power: number, time: number, tier: number, lean: number): void {
    if (power <= 0.02 || k < 0.8) return;
    const side = Math.sin(lean) * 0.35;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean * 0.35);
    ctx.scale(k, k);
    ctx.globalCompositeOperation = 'lighter';
    const core = tier === 2 ? '#f0c0ff' : tier === 1 ? '#fff6d0' : '#d8f6ff';
    for (const ex of [-0.18, 0.18]) {
        // Slow and small. The old 10 Hz term read as the kart vibrating.
        const flicker = 0.92 + 0.08 * Math.sin(time * 17 + ex * 40) * Math.sin(time * 9);
        const len = (0.1 + 0.3 * power) * flicker;
        const g = ctx.createRadialGradient(ex + side, -0.28, 0, ex + side, -0.28, len);
        g.addColorStop(0, core);
        g.addColorStop(0.4, tier === 2 ? 'rgba(210, 75, 255, 0.8)' : 'rgba(255, 176, 32, 0.85)');
        g.addColorStop(1, 'rgba(255, 90, 16, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(ex + side, -0.28 + len * 0.25, len * 0.55, len, 0, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}

/**
 * Drift sparks thrown off both rear wheels, in the current tier's color.
 * Twelve particles per wheel on a looping 0.3 s life, placed by hash.
 */
export function drawSparks(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, tier: number, time: number, lean: number): void {
    if (tier < 0 || k < 0.8) return;
    const [body, hot] = SPARK_TIERS[Math.min(2, tier)];
    const side = Math.sin(lean) * 0.35;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const wx of [-0.56, 0.56]) {
        for (let i = 0; i < 12; i++) {
            const h = hash32(i, wx > 0 ? 7 : 11);
            const life = (time / 0.3 + rand01(h)) % 1;
            const out = wx > 0 ? 1 : -1;
            const px = (wx + side * 0.6 + out * life * (0.4 + rand01(hash32(h, 1)) * 0.5)) * k;
            const py = (-0.05 - life * (0.25 + rand01(hash32(h, 2)) * 0.4) + life * life * 0.5) * k;
            const r = (0.12 * (1 - life) + 0.02) * k;
            ctx.globalAlpha = 1 - life;
            ctx.strokeStyle = life < 0.25 ? hot : body;
            ctx.lineWidth = Math.max(1, r * 0.35);
            ctx.beginPath();
            ctx.moveTo(px - r, py); ctx.lineTo(px + r, py);
            ctx.moveTo(px, py - r); ctx.lineTo(px, py + r);
            ctx.stroke();
        }
    }
    if (tier >= 2) {
        // The top tier lights the road under the kart.
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(side * k, 0, 1.1 * k, 0.22 * k, 0, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}
