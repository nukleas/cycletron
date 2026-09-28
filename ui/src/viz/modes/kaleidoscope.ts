/**
 * KALEIDOSCOPE — particles live in one canonical wedge (1/8 of the circle)
 * and are drawn eight times, alternate wedges mirrored, so the whole disc is
 * a true reflection of the wedge.
 *
 *   scheduled onset → a burst of particles in the wedge, coloured by the
 *                     track accent; each track owns a stable angular band
 *                     inside the wedge (slot-seeded)
 *   instrument      → kick: few large, slow dots near the centre; snare:
 *                     a mid-radius spray; hat: small fast sparks; pitched
 *                     notes start further out and travel faster as they rise
 *   kick onsets     → the centre disc + ring pulse (FFT transients when no
 *                     pattern is scheduled)
 *   FFT             → texture only: highs swell the dots slightly; with no
 *                     pattern the bands feed a calm, rate-limited drizzle
 *
 * Particles are a fixed struct-of-arrays pool; radii and speeds are stored
 * as fractions of the disc radius, so a resize rescales without restarting.
 */

import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {
    TAU, TransientDetector, alphaRamp, clamp01, follow, hash32, rampAt, rand01, rgbOf,
} from '../util.js';

const SLICES = 8;
const WEDGE = TAU / SLICES;
const MAX_P = 192;
/** Colour slots: track slot % PAL, or the three idle band colours. */
const PAL = 8;
/** Alpha buckets — one fill + one stroke per (colour, bucket). */
const BUCKETS = 4;

class KaleidoscopeMode implements VizMode {
    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.18, 0.1, 0.06);
    private seq = 0;

    // Particle pool — radius/speed in units of maxR, size in units of u.
    private readonly pr = new Float32Array(MAX_P);
    private readonly pa = new Float32Array(MAX_P);
    private readonly pvr = new Float32Array(MAX_P);
    private readonly pspin = new Float32Array(MAX_P);
    private readonly plife = new Float32Array(MAX_P);
    private readonly plife0 = new Float32Array(MAX_P).fill(1);
    private readonly psize = new Float32Array(MAX_P);
    private readonly pcol = new Uint8Array(MAX_P);
    private nextP = 0;

    /** Per-mirror-image base rotation (even: k·w, odd: (k+1)·w, then reflect). */
    private readonly baseCos = new Float32Array(SLICES);
    private readonly baseSin = new Float32Array(SLICES);

    private readonly palKey: string[] = new Array(PAL).fill('');
    private readonly palRamp: string[][] = [];
    private theme: Theme | null = null;
    private idleKey: string[] = [];
    private chromeRamp: string[] = [];
    private neonRamp: string[] = [];

    private cx = 0;
    private cy = 0;
    private maxR = 0;
    private u = 1;
    private t = 0;
    private idleAcc = 0;
    private hiSm = 0;
    private pulse = 0;
    private pulseTarget = 0;

    constructor() {
        for (let k = 0; k < SLICES; k++) {
            // Odd wedges reflect a → (k+1)·w − a so they fill [k·w, (k+1)·w]
            // rather than folding back onto the previous even wedge.
            const base = (k % 2 === 0 ? k : k + 1) * WEDGE;
            this.baseCos[k] = Math.cos(base);
            this.baseSin[k] = Math.sin(base);
        }
        for (let i = 0; i < PAL; i++) this.palRamp.push([]);
    }

    layout(s: VizServices): void {
        this.cx = s.width / 2;
        this.cy = s.height / 2;
        this.maxR = Math.min(s.width, s.height) * 0.48;
        this.u = Math.max(0.4, Math.min(s.width, s.height) / 720);
        this.syncTheme(s.theme);
    }

    private syncTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        this.chromeRamp = alphaRamp(theme.textRgb, 16);
        const pool = theme.accentPool;
        this.neonRamp = alphaRamp(rgbOf(theme.neon, theme.textRgb), 16);
        this.idleKey = [0, 2, 4].map((i) => {
            const c = pool[i % pool.length] ?? theme.textRgb;
            return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
        });
    }

    /** Point a palette slot at a colour; ramps rebuild only when it changes. */
    private claimColour(slot: number, key: string, rgb: readonly [number, number, number]): number {
        const i = slot % PAL;
        if (this.palKey[i] !== key) {
            this.palKey[i] = key;
            this.palRamp[i] = alphaRamp(rgb, 16);
        }
        return i;
    }

    private rand(): number {
        return rand01(hash32(0x6b1d, this.seq++));
    }

    private spawn(angle: number, r: number, vr: number, size: number, life: number, col: number): void {
        const i = this.nextP;
        this.nextP = (i + 1) % MAX_P;
        this.pa[i] = Math.min(WEDGE - 1e-4, Math.max(0, angle));
        this.pr[i] = r;
        this.pvr[i] = vr;
        this.pspin[i] = (this.rand() - 0.5) * 0.12;
        this.psize[i] = size;
        this.plife[i] = life;
        this.plife0[i] = life;
        this.pcol[i] = col;
    }

    private spawnOnset(track: VizTrack, e: number): void {
        const col = this.claimColour(track.slot, track.accentCss, track.accent);
        // Stable angular band per track inside the wedge.
        const band = 0.12 + rand01(hash32(track.slot, 0x51ed)) * 0.76;
        const family = instrumentFamily(track.name);
        const note = track.notes[e];
        let n: number, r0: number, v: number, size: number, life: number;
        if (Number.isFinite(note)) {
            const p = clamp01((note - 24) / 72);
            n = 2; r0 = 0.08 + p * 0.3; v = 0.22 + p * 0.3; size = 2.2; life = 2.2;
        } else if (family === 'kick') {
            n = 3; r0 = 0.13; v = 0.16; size = 4; life = 2.4;
        } else if (family === 'snare') {
            n = 4; r0 = 0.2; v = 0.3; size = 2.4; life = 1.6;
        } else if (family === 'hat') {
            n = 1; r0 = 0.3; v = 0.5; size = 1.5; life = 1.1;
        } else {
            n = 2; r0 = 0.14; v = 0.26; size = 2.4; life = 1.8;
        }
        for (let k = 0; k < n; k++) {
            const a = (band + (this.rand() - 0.5) * 0.18) * WEDGE;
            this.spawn(a, r0 + this.rand() * 0.05, v * (0.85 + this.rand() * 0.3),
                size * (0.85 + this.rand() * 0.3), life, col);
        }
        if (family === 'kick') this.pulseTarget = 1;
        else this.pulseTarget = Math.max(this.pulseTarget, 0.18);
    }

    update(dt: number, s: VizServices): void {
        this.syncTheme(s.theme);
        this.t += dt;
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, (track, e) => this.spawnOnset(track, e));
        this.tracks.decay(dt);

        const low = Math.max(0, Math.min(1.5, s.low || 0));
        const mid = Math.max(0, Math.min(1.5, s.mid || 0));
        const high = Math.max(0, Math.min(1.5, s.high || 0));
        this.hiSm = follow(this.hiSm, Math.min(1, high), dt, 28, 7);
        const hits = this.transients.update(dt, low, mid, high);

        if (!sync.pattern) {
            // Idle drizzle: a budget accumulator so the rate is frame-rate
            // independent; bands pick the colour, transient kicks pulse the centre.
            this.idleAcc += dt * (0.9 + (low + mid + high) * 3);
            while (this.idleAcc >= 1) {
                this.idleAcc -= 1;
                const b = this.rand() * (low + mid + high + 0.3);
                const which = b < low + 0.1 ? 0 : b < low + mid + 0.2 ? 1 : 2;
                const theme = this.theme!;
                const pool = theme.accentPool;
                const rgb = pool[(which * 2) % pool.length] ?? theme.textRgb;
                const col = this.claimColour(which, this.idleKey[which], rgb);
                this.spawn(this.rand() * WEDGE, 0.06 + this.rand() * 0.1,
                    0.12 + this.rand() * 0.1 + which * 0.05, 2.4 - which * 0.5, 2.6, col);
            }
            if (hits.kick) this.pulseTarget = 1;
            this.pulseTarget = Math.max(this.pulseTarget, 0.12 + 0.08 * Math.sin(this.t * 1.3));
        } else {
            this.idleAcc = 0;
        }

        this.pulseTarget *= Math.exp(-dt * 9);
        this.pulse = follow(this.pulse, this.pulseTarget, dt, 32, 6);

        const drag = Math.exp(-dt * 0.5);
        for (let i = 0; i < MAX_P; i++) {
            if (this.plife[i] <= 0) continue;
            this.pr[i] += this.pvr[i] * dt;
            this.pvr[i] *= drag;
            // Drift in angle, reflecting off the mirror lines so the symmetry
            // never shows a seam.
            let a = this.pa[i] + this.pspin[i] * dt;
            if (a < 0) { a = -a; this.pspin[i] = -this.pspin[i]; }
            if (a > WEDGE) { a = 2 * WEDGE - a; this.pspin[i] = -this.pspin[i]; }
            this.pa[i] = a;
            this.plife[i] -= dt;
            if (this.pr[i] > 1.02) this.plife[i] = 0;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const R = this.maxR;
        if (R <= 0 || s.width === 0 || s.height === 0) return;
        this.syncTheme(s.theme);
        const u = this.u;
        ctx.save();
        ctx.translate(this.cx, this.cy);

        // Mirror lines + rim — one path.
        ctx.strokeStyle = rampAt(this.chromeRamp, 0.1);
        ctx.lineWidth = Math.max(0.75, u * 0.8);
        ctx.beginPath();
        for (let k = 0; k < SLICES; k++) {
            const c = Math.cos(k * WEDGE), sn = Math.sin(k * WEDGE);
            ctx.moveTo(c * R * 0.08, sn * R * 0.08);
            ctx.lineTo(c * R, sn * R);
        }
        ctx.moveTo(R, 0);
        ctx.arc(0, 0, R, 0, TAU);
        ctx.stroke();

        // Particles: one fill (dots) + one stroke (radial tails) per colour ×
        // alpha bucket, each path carrying all eight mirror images.
        const sizeK = u * (1 + this.hiSm * 0.35);
        ctx.lineWidth = Math.max(0.75, u);
        ctx.lineCap = 'round';
        for (let col = 0; col < PAL; col++) {
            const ramp = this.palRamp[col];
            if (ramp.length === 0) continue;
            for (let b = 0; b < BUCKETS; b++) {
                let any = false;
                ctx.beginPath();
                for (let i = 0; i < MAX_P; i++) {
                    const life = this.plife[i];
                    if (life <= 0 || this.pcol[i] !== col) continue;
                    const f = life / this.plife0[i];
                    if (Math.min(BUCKETS - 1, Math.floor(f * BUCKETS)) !== b) continue;
                    any = true;
                    const ca = Math.cos(this.pa[i]), sa = Math.sin(this.pa[i]);
                    const r = this.pr[i] * R;
                    const tail = Math.min(r, this.pvr[i] * R * 0.12);
                    const dot = this.psize[i] * sizeK;
                    for (let k = 0; k < SLICES; k++) {
                        const cb = this.baseCos[k], sb = this.baseSin[k];
                        // Even: rotate by base; odd: reflect then rotate.
                        const dx = k % 2 === 0 ? cb * ca - sb * sa : cb * ca + sb * sa;
                        const dy = k % 2 === 0 ? sb * ca + cb * sa : sb * ca - cb * sa;
                        ctx.moveTo(dx * r + dot, dy * r);
                        ctx.arc(dx * r, dy * r, dot, 0, TAU);
                        ctx.moveTo(dx * (r - tail), dy * (r - tail));
                        ctx.lineTo(dx * r, dy * r);
                    }
                }
                if (!any) continue;
                const alpha = (b + 1) / BUCKETS;
                ctx.fillStyle = rampAt(ramp, 0.15 + alpha * 0.7);
                ctx.fill();
                ctx.strokeStyle = rampAt(ramp, 0.25 + alpha * 0.6);
                ctx.stroke();
            }
        }

        // Centre: flat disc + ring, pulsing with kick onsets.
        const p = this.pulse;
        const disc = R * (0.035 + p * 0.03);
        ctx.fillStyle = rampAt(this.neonRamp, 0.2 + p * 0.55);
        ctx.beginPath();
        ctx.arc(0, 0, disc, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = rampAt(this.neonRamp, 0.35 + p * 0.5);
        ctx.lineWidth = Math.max(1, u * 1.2);
        ctx.beginPath();
        ctx.arc(0, 0, disc + R * (0.02 + p * 0.05), 0, TAU);
        ctx.stroke();
        ctx.restore();
    }
}

export const kaleidoscopeDef: VizModeDef = {
    id: 'kaleidoscope',
    name: 'KALEIDOSCOPE',
    create: () => new KaleidoscopeMode(),
};
