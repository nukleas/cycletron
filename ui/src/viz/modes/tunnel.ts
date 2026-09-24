/**
 * TUNNEL — octagonal rings flying at the viewer, spaced in musical time.
 *
 * Depth is time: one ring per beat (four per bar), and the camera advances
 * with the cycle, so a ring reaches the gate (the fixed reference octagon)
 * exactly on its beat. Bar rings are brighter and carry a small bar number.
 * Projection is true perspective (r = f / depth) with a slight twist per
 * beat of depth, so the rails curve into the vanishing point.
 *
 * Scheduled events ride the tunnel too: each non-kick hap is a lit side of
 * the octagon at an angle hashed per track (pitched notes step round by
 * pitch), in the track's accent, approaching from about a bar out and
 * landing on the gate on its onset; kicks are whole accent rings. Kick
 * onsets punch the field of view and brighten the gate. The whole tunnel
 * turns once every 16 bars.
 *
 * With no pattern the camera drifts calmly on its own clock, nudged by the
 * smoothed FFT energy; low-band transients give a gentle punch.
 *
 * No sorting, no gradients: rings are drawn far → near by beat index, and
 * landed events live in a fixed pool.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import {
    TAU, TransientDetector, alphaRamp, clamp01, drawLabel, follow, hash32, rampAt, rgbOf,
} from '../util.js';

const BEATS = 4;           // rings per bar
const SIDES = 8;
const D_HIT = 1;           // depth (beats) of the gate
const NEAR = 0.32;         // rings vanish past the camera here
const FAR = 24;            // draw distance, beats
/** Scheduled events become visible this many beats before the gate. */
const AHEAD = 4.5;
const TWIST = 0.035;       // radians per beat of depth
const IDLE_RATE = 0.7;     // beats per second when nothing is scheduled
const MAX_LANDED = 96;
const SIDE_ANGLE = TAU / SIDES;

class TunnelMode implements VizMode {
    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.35, 0.4, 0.3);

    private u = 0;
    private lw = 1;
    private cx = 0;
    private cy = 0;
    /** Screen radius of the gate (depth D_HIT). */
    private focal = 0;

    /** Camera position in beats. */
    private beat = 0;
    private bar = 0;
    private phase = 0;
    private playing = false;
    private kickEnv = 0;
    private energy = 0;

    // Landed events keep flying past the gate after the track model moves on.
    private readonly lBeat = new Float64Array(MAX_LANDED);
    private readonly lSide = new Int8Array(MAX_LANDED);   // -1 = whole ring (kick)
    private readonly lColor: string[] = new Array<string>(MAX_LANDED).fill('');
    private readonly lActive = new Uint8Array(MAX_LANDED);
    private lNext = 0;

    private readonly labelBar = new Int32Array(8).fill(-1);
    private readonly labelText: string[] = new Array<string>(8).fill('');

    private theme: Theme | null = null;
    private neonRamp: string[] = [];
    private borderRamp: string[] = [];
    private textRamp: string[] = [];

    layout(s: VizServices): void {
        const m = Math.min(s.width, s.height);
        this.u = m / 720;
        this.lw = Math.min(2, Math.max(1, 0.9 + this.u * 0.35));
        this.cx = s.width / 2;
        this.cy = s.height / 2;
        this.focal = m * 0.4;
    }

    private ensureTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        this.neonRamp = alphaRamp(rgbOf(theme.neon, [71, 246, 255]));
        this.borderRamp = alphaRamp(theme.borderRgb);
        this.textRamp = alphaRamp(theme.textRgb);
    }

    /** Octagon side an event lights: hashed per track, stepped by pitch. */
    private sideOf(track: VizTrack, e: number): number {
        const note = track.notes[e];
        const step = Number.isFinite(note) ? Math.round(note) : 0;
        return (hash32(track.slot, 0x7a11) + step) % SIDES;
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const kick = instrumentFamily(track.name) === 'kick';
        if (kick) this.kickEnv = 1;
        const i = this.lNext;
        this.lNext = (i + 1) % MAX_LANDED;
        this.lActive[i] = 1;
        this.lBeat[i] = (this.bar + track.begins[e]) * BEATS;
        this.lSide[i] = kick ? -1 : this.sideOf(track, e);
        this.lColor[i] = track.accentCss;
    };

    update(dt: number, s: VizServices): void {
        this.ensureTheme(s.theme);
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.playing = sync.pattern !== null;
        this.phase = sync.phase;
        this.bar = Math.floor(s.cycle);

        const low = Number.isFinite(s.low) ? Math.max(0, s.low) : 0;
        const mid = Number.isFinite(s.mid) ? Math.max(0, s.mid) : 0;
        const high = Number.isFinite(s.high) ? Math.max(0, s.high) : 0;
        this.energy = follow(this.energy, clamp01((low * 0.6 + mid * 0.9 + high * 0.7) * 0.5), dt, 25, 6);
        const hits = this.transients.update(dt, low, mid, high);

        if (this.playing) {
            const beat = s.cycle * BEATS;
            if (!Number.isFinite(beat)) return;
            // Seeking backwards would replay landed events ahead of the gate.
            if (beat < this.beat - 0.05) this.lActive.fill(0);
            this.beat = beat;
        } else {
            // Continue from where playback left off — no jump on stop.
            this.beat += dt * (IDLE_RATE + this.energy * 0.8);
            if (hits.kick) this.kickEnv = Math.max(this.kickEnv, 0.5);
        }

        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
        this.kickEnv *= Math.exp(-dt * 7);

        for (let i = 0; i < MAX_LANDED; i++) {
            if (this.lActive[i] && this.lBeat[i] - this.beat + D_HIT <= NEAR) this.lActive[i] = 0;
        }
    }

    /** Twisted world angle of side 0 at a depth. */
    private angleAt(d: number): number {
        return (this.beat / (BEATS * 16)) * TAU + d * TWIST;
    }

    /** Fog toward the far end and fade as a ring passes the camera. */
    private visibility(d: number): number {
        const far = clamp01((FAR - d) / (FAR * 0.6));
        const near = clamp01((d - NEAR) / (D_HIT - NEAR));
        return far * far * near;
    }

    private octagon(ctx: CanvasRenderingContext2D, r: number, a0: number): void {
        const {cx, cy} = this;
        ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
        for (let k = 1; k <= SIDES; k++) {
            const a = a0 + k * SIDE_ANGLE;
            ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
    }

    /** One octagon side, trimmed at both ends so neighbours read separately. */
    private side(ctx: CanvasRenderingContext2D, r: number, a0: number, side: number): void {
        const a = a0 + side * SIDE_ANGLE, b = a + SIDE_ANGLE;
        const x0 = this.cx + Math.cos(a) * r, y0 = this.cy + Math.sin(a) * r;
        const x1 = this.cx + Math.cos(b) * r, y1 = this.cy + Math.sin(b) * r;
        ctx.moveTo(x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.12);
        ctx.lineTo(x0 + (x1 - x0) * 0.88, y0 + (y1 - y0) * 0.88);
    }

    private barLabel(bar: number): string {
        const slot = ((bar % 8) + 8) % 8;
        if (this.labelBar[slot] !== bar) {
            this.labelBar[slot] = bar;
            this.labelText[slot] = String(bar + 1);
        }
        return this.labelText[slot];
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (s.width <= 0 || s.height <= 0) return;
        if (this.u === 0) this.layout(s);
        this.ensureTheme(s.theme);
        const {cx, cy, lw, u} = this;
        const f = this.focal * (1 + this.kickEnv * 0.05);
        // Depth of beat k: its ring meets the gate (D_HIT) on the beat.
        const off = D_HIT - this.beat;
        const kFirst = Math.ceil(this.beat - D_HIT + NEAR);
        const kLast = Math.floor(this.beat - D_HIT + FAR);

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Far-end disc.
        const vr = Math.max(2 * u, (f / FAR) * 1.4);
        ctx.beginPath();
        ctx.arc(cx, cy, vr, 0, TAU);
        ctx.fillStyle = s.theme.bg;
        ctx.fill();
        ctx.strokeStyle = rampAt(this.neonRamp, 0.5);
        ctx.lineWidth = lw;
        ctx.stroke();

        // Rails through every ring's vertices.
        ctx.strokeStyle = rampAt(this.borderRamp, 0.45);
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let side = 0; side < SIDES; side++) {
            for (let k = kLast; k >= kFirst; k--) {
                const d = k + off;
                const a = this.angleAt(d) + side * SIDE_ANGLE;
                const r = f / d;
                if (k === kLast) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
                else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            }
        }
        ctx.stroke();

        // Beat rings, far → near.
        const labels = this.playing && s.width >= 360;
        const fontSize = Math.round(Math.min(11, Math.max(9, 8 + u * 1.5)));
        for (let k = kLast; k >= kFirst; k--) {
            const d = k + off;
            const vis = this.visibility(d);
            if (vis < 0.01) continue;
            const isBar = ((k % BEATS) + BEATS) % BEATS === 0;
            const r = f / d;
            const a0 = this.angleAt(d);
            ctx.strokeStyle = isBar
                ? rampAt(this.neonRamp, vis * 0.6)
                : rampAt(this.borderRamp, vis * 0.8);
            ctx.lineWidth = lw * Math.min(2.5, Math.max(0.6, D_HIT / d)) * (isBar ? 1.3 : 1);
            ctx.beginPath();
            this.octagon(ctx, r, a0);
            ctx.stroke();
            if (isBar && labels && r > 28 * u && vis > 0.2) {
                const la = a0 - SIDE_ANGLE * 0.5;
                drawLabel(ctx, this.barLabel(k / BEATS), cx + Math.cos(la) * (r + 8 * u + 4),
                    cy + Math.sin(la) * (r + 8 * u + 4), rampAt(this.textRamp, vis * 0.6), fontSize, 'center');
            }
        }

        // The gate: fixed reference where events land.
        ctx.strokeStyle = rampAt(this.textRamp, 0.18 + this.kickEnv * 0.35);
        ctx.lineWidth = lw;
        ctx.beginPath();
        this.octagon(ctx, f, this.angleAt(D_HIT));
        ctx.stroke();

        // Incoming scheduled events of this bar.
        if (this.playing) {
            for (const t of this.tracks.tracks) {
                if (t.count === 0) continue;
                const kick = instrumentFamily(t.name) === 'kick';
                ctx.strokeStyle = t.accentCss;
                for (let e = 0; e < t.count; e++) {
                    const b = t.begins[e];
                    if (b <= this.phase) continue;
                    const d = (this.bar + b) * BEATS + off;
                    const vis = clamp01((AHEAD + D_HIT - d) / 2) * this.visibility(d);
                    if (vis < 0.02) continue;
                    ctx.globalAlpha = vis;
                    ctx.lineWidth = lw * Math.min(2.5, Math.max(0.8, D_HIT / d)) * (kick ? 1.3 : 2);
                    ctx.beginPath();
                    if (kick) this.octagon(ctx, f / d, this.angleAt(d));
                    else this.side(ctx, f / d, this.angleAt(d), this.sideOf(t, e));
                    ctx.stroke();
                }
            }
        }

        // Landed events flying past the camera.
        for (let i = 0; i < MAX_LANDED; i++) {
            if (!this.lActive[i]) continue;
            const d = this.lBeat[i] + off;
            const vis = clamp01((d - NEAR) / (D_HIT - NEAR));
            if (vis <= 0) continue;
            ctx.strokeStyle = this.lColor[i];
            ctx.globalAlpha = vis;
            ctx.lineWidth = lw * Math.min(2.5, D_HIT / Math.max(d, NEAR)) * (this.lSide[i] < 0 ? 1.3 : 2);
            ctx.beginPath();
            if (this.lSide[i] < 0) this.octagon(ctx, f / d, this.angleAt(d));
            else this.side(ctx, f / d, this.angleAt(d), this.lSide[i]);
            ctx.stroke();
        }

        ctx.restore();
    }
}

export const tunnelDef: VizModeDef = {
    id: 'tunnel',
    name: 'TUNNEL',
    create: () => new TunnelMode(),
};
