/**
 * STRANGE ATTRACTOR — the Lorenz system integrated at a fixed step, drawn as
 * a ring-buffer trail coloured by age (theme secondary → neon).
 *
 *   scheduled onset → an impulse on the state's velocity, direction seeded
 *                     per track slot, strength by family (kick strongest);
 *                     the newest stretch of trail flashes in the track accent
 *   downbeat        → the view steps a twelfth of a turn around the z axis
 *   FFT bands       → slowly smoothed, clamped nudges to σ (low), ρ (high)
 *                     and β (mid), so the butterfly breathes without jitter
 *   no pattern      → the view drifts continuously; FFT still shapes it
 *
 * The view is fitted to the trail's actual projected bounds (smoothed), so
 * the attractor stays centred whatever ρ does. The trail is pre-integrated
 * on creation — no spike out of the origin on entry.
 */

import {TrackModel, instrumentFamily} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, alphaRamp, drawLabel, follow, hash32, mixRgb, rampAt, rand01, rgbOf} from '../util.js';

const TRAIL_CAP = 1800;
/** Integration step in Lorenz time, and Lorenz time per second of wall time. */
const STEP = 0.005;
const SPEED = 0.55;
const MAX_STEPS_PER_FRAME = 40;
const BUCKETS = 15;
const HEAD_N = 40;
const TILT = 0.38;

function band(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

class AttractorMode implements VizMode {
    private readonly tracks = new TrackModel();
    private x = 1;
    private y = 1;
    private z = 20;
    /** Velocity impulse from onsets, decaying in Lorenz time. */
    private ix = 0;
    private iy = 0;
    private iz = 0;
    private sigma = 10;
    private rho = 28;
    private beta = 8 / 3;
    private acc = 0;
    private readonly trail = new Float32Array(TRAIL_CAP * 3);
    private readonly proj = new Float32Array(TRAIL_CAP * 2);
    private head = 0;

    private theta = 0.6;
    private thetaTarget = 0.6;
    private lastBar = NaN;
    // Smoothed view fit, in projected Lorenz units.
    private fitX = 0;
    private fitY = 0;
    private fitW = 0;
    private fitH = 0;

    private headFlash = 0;
    private headKey = '';
    private headRamp: string[] = [];

    private theme: Theme | null = null;
    private bucketCss: string[] = [];
    private labelCss = '';
    private w = 0;
    private h = 0;
    private u = 1;

    constructor() {
        // Burn in onto the attractor, then fill the trail with real orbit.
        for (let i = 0; i < 2000; i++) this.step();
        for (let i = 0; i < TRAIL_CAP; i++) {
            this.step();
            this.record();
        }
    }

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        this.u = Math.max(0.4, Math.min(s.width, s.height) / 720);
        this.syncTheme(s.theme);
    }

    private syncTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        const neon = rgbOf(theme.neon, theme.textRgb);
        const sec = rgbOf(theme.neonSecondary, theme.textRgb);
        this.bucketCss = [];
        for (let b = 0; b < BUCKETS; b++) {
            const t = (b + 1) / BUCKETS;
            const [r, g, bl] = mixRgb(sec, neon, t);
            this.bucketCss.push(`rgba(${r}, ${g}, ${bl}, ${(0.14 + 0.78 * t * Math.sqrt(t)).toFixed(3)})`);
        }
        const [tr, tg, tb] = theme.textRgb;
        this.labelCss = `rgba(${tr}, ${tg}, ${tb}, 0.4)`;
    }

    private step(): void {
        const dx = this.sigma * (this.y - this.x) + this.ix;
        const dy = this.x * (this.rho - this.z) - this.y + this.iy;
        const dz = this.x * this.y - this.beta * this.z + this.iz;
        this.x += dx * STEP;
        this.y += dy * STEP;
        this.z += dz * STEP;
        const k = Math.exp(-STEP * 8);
        this.ix *= k;
        this.iy *= k;
        this.iz *= k;
        if (!Number.isFinite(this.x + this.y + this.z)
            || Math.abs(this.x) > 300 || Math.abs(this.y) > 300 || Math.abs(this.z) > 300) {
            this.x = 1; this.y = 1; this.z = 20;
            this.ix = this.iy = this.iz = 0;
        }
    }

    private record(): void {
        const i = this.head * 3;
        this.trail[i] = this.x;
        this.trail[i + 1] = this.y;
        this.trail[i + 2] = this.z;
        this.head = (this.head + 1) % TRAIL_CAP;
    }

    update(dt: number, s: VizServices): void {
        this.syncTheme(s.theme);
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, (track) => {
            const fam = instrumentFamily(track.name);
            const mag = fam === 'kick' ? 36 : fam === 'snare' ? 22 : fam === 'hat' ? 8 : 16;
            // Seeded unit direction per slot.
            const a = rand01(hash32(track.slot, 0xa77)) * TAU;
            const c = rand01(hash32(track.slot, 0xa78)) * 2 - 1;
            const r = Math.sqrt(1 - c * c);
            this.ix += Math.cos(a) * r * mag;
            this.iy += Math.sin(a) * r * mag;
            this.iz += c * mag;
            if (mag >= this.headFlash * 36) {
                if (this.headKey !== track.accentCss) {
                    this.headKey = track.accentCss;
                    this.headRamp = alphaRamp(track.accent, 16);
                }
                this.headFlash = 1;
            }
        });
        this.tracks.decay(dt);
        this.headFlash *= Math.exp(-dt * 3);

        this.sigma = follow(this.sigma, 10 + band(s.low) * 3, dt, 1.5, 0.6);
        this.rho = follow(this.rho, 28 + band(s.high) * 8, dt, 1.5, 0.6);
        this.beta = follow(this.beta, 8 / 3 + band(s.mid) * 0.4, dt, 1.5, 0.6);

        this.acc += Math.min(dt, 0.1) * SPEED;
        let n = 0;
        while (this.acc >= STEP && n < MAX_STEPS_PER_FRAME) {
            this.acc -= STEP;
            this.step();
            this.record();
            n++;
        }
        if (n === MAX_STEPS_PER_FRAME) this.acc = 0;

        // View: step on downbeats while a pattern plays, drift when idle.
        const bar = Math.floor(s.cycle);
        if (sync.pattern) {
            if (Number.isFinite(this.lastBar) && bar > this.lastBar) this.thetaTarget += TAU / 12;
            this.lastBar = bar;
        } else {
            this.lastBar = NaN;
            this.thetaTarget += dt * 0.06;
        }
        this.theta = follow(this.theta, this.thetaTarget, dt, 2.5, 2.5);
        if (this.thetaTarget > TAU * 64) {
            this.thetaTarget -= TAU * 64;
            this.theta -= TAU * 64;
        }

        // Project the trail and fit the view to its bounds.
        const ct = Math.cos(this.theta), st = Math.sin(this.theta);
        const ctl = Math.cos(TILT), stl = Math.sin(TILT);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < TRAIL_CAP; i++) {
            const x = this.trail[i * 3], y = this.trail[i * 3 + 1], z = this.trail[i * 3 + 2];
            const px = x * ct - y * st;
            const depth = x * st + y * ct;
            const py = -(z * ctl + depth * stl);
            this.proj[i * 2] = px;
            this.proj[i * 2 + 1] = py;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
        }
        const halfW = Math.max(1, (maxX - minX) / 2), halfH = Math.max(1, (maxY - minY) / 2);
        if (this.fitW === 0) {
            this.fitX = (minX + maxX) / 2;
            this.fitY = (minY + maxY) / 2;
            this.fitW = halfW;
            this.fitH = halfH;
        } else {
            this.fitX = follow(this.fitX, (minX + maxX) / 2, dt, 1.2, 1.2);
            this.fitY = follow(this.fitY, (minY + maxY) / 2, dt, 1.2, 1.2);
            this.fitW = follow(this.fitW, halfW, dt, 3, 0.6);
            this.fitH = follow(this.fitH, halfH, dt, 3, 0.6);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {w, h, u} = this;
        if (w <= 0 || h <= 0 || this.fitW === 0) return;
        this.syncTheme(s.theme);
        const scale = Math.min(w * 0.42 / this.fitW, h * 0.4 / this.fitH);
        const ox = w / 2 - this.fitX * scale;
        const oy = h / 2 - this.fitY * scale;
        const head = this.head;
        const per = TRAIL_CAP / BUCKETS;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Oldest → newest, one polyline per age bucket (overlapping by one
        // point so the buckets join).
        for (let b = 0; b < BUCKETS; b++) {
            const t = (b + 1) / BUCKETS;
            ctx.strokeStyle = this.bucketCss[b];
            ctx.lineWidth = Math.max(0.6, u * (0.6 + t * 1.1));
            ctx.beginPath();
            const start = b * per;
            const end = Math.min(TRAIL_CAP - 1, start + per);
            for (let i = start; i <= end; i++) {
                const idx = ((head + i) % TRAIL_CAP) * 2;
                const sx = ox + this.proj[idx] * scale;
                const sy = oy + this.proj[idx + 1] * scale;
                if (i === start) ctx.moveTo(sx, sy);
                else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
        }

        // Onset flash: the newest stretch recoloured in the track accent.
        if (this.headFlash > 0.03 && this.headRamp.length > 0) {
            ctx.strokeStyle = rampAt(this.headRamp, this.headFlash);
            ctx.lineWidth = Math.max(1, u * 2.2);
            ctx.beginPath();
            for (let i = TRAIL_CAP - HEAD_N; i < TRAIL_CAP; i++) {
                const idx = ((head + i) % TRAIL_CAP) * 2;
                const sx = ox + this.proj[idx] * scale;
                const sy = oy + this.proj[idx + 1] * scale;
                if (i === TRAIL_CAP - HEAD_N) ctx.moveTo(sx, sy);
                else ctx.lineTo(sx, sy);
            }
            ctx.stroke();
        }

        // Head marker.
        const last = ((head + TRAIL_CAP - 1) % TRAIL_CAP) * 2;
        const hs = Math.max(2, u * 3.5);
        ctx.fillStyle = s.theme.active;
        ctx.fillRect(ox + this.proj[last] * scale - hs / 2, oy + this.proj[last + 1] * scale - hs / 2, hs, hs);

        // Parameter readout.
        const size = Math.max(9, Math.min(11, 9 * u));
        drawLabel(ctx,
            `σ ${this.sigma.toFixed(1)}  ρ ${this.rho.toFixed(1)}  β ${this.beta.toFixed(2)}`,
            Math.max(12, 20 * u), h - Math.max(12, 20 * u), this.labelCss, size);
        ctx.restore();
    }
}

export const attractorDef: VizModeDef = {
    id: 'attractor',
    name: 'STRANGE ATTRACTOR',
    create: () => new AttractorMode(),
};
