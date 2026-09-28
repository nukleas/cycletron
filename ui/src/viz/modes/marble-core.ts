/**
 * MARBLE CORE — a clockwork of concentric rings, one per track.
 *
 * The playhead arm sweeps once per bar (12 o'clock = the downbeat). Up to five
 * tracks each own a ring, assigned with hysteresis so rings don't swap while
 * a track keeps playing; each ring carries a tick at every scheduled event
 * position in the current bar, and a tick lights on its onset and fades, with
 * sustained notes drawing their arc while they sound. Each ring's orb glides
 * from event to event, arriving on the onset, and swells with its track's
 * activity. The core disc breathes with kick onsets, with the smoothed FFT
 * low band as a second opinion.
 *
 * With no pattern the rings become a calm subdivision clock (4 / 8 / 16) on
 * a local clock, and the core follows the FFT gently.
 *
 * Flat fills and fine outlines; every radius is a fraction of min(w, h).
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {MAX_EVENTS_PER_TRACK, TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import {TAU, alphaRamp, beatEnv, clamp01, drawLabel, follow, rampAt, rgbOf} from '../util.js';

const RINGS = 5;
const TOP = -Math.PI / 2;
/** Idle clock: bars per second when nothing is scheduled. */
const IDLE_RATE = 0.25;
const IDLE_DIVISIONS = [4, 8, 16] as const;

function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

class MarbleCoreMode implements VizMode {
    private readonly tracks = new TrackModel();

    private u = 0;
    private lw = 1;
    private cx = 0;
    private cy = 0;
    private radius = 0;   // outer extent
    private step = 0;     // ring spacing
    private coreR = 0;

    private readonly ringTrack: (VizTrack | null)[] = new Array<VizTrack | null>(RINGS).fill(null);
    /** Per-ring, per-event onset envelopes. */
    private readonly flash = new Float32Array(RINGS * MAX_EVENTS_PER_TRACK);
    private readonly ringLevel = new Float32Array(RINGS);
    private playing = false;
    private phase = 0;
    private idlePhase = 0;
    private idleLevel = 1;
    private kickEnv = 0;
    private lowF = 0;
    private midF = 0;

    private theme: Theme | null = null;
    private neonRamp: string[] = [];
    private textRamp: string[] = [];
    private idleCss: string[] = [];

    layout(s: VizServices): void {
        const m = Math.min(s.width, s.height);
        this.u = m / 720;
        this.lw = Math.min(2, Math.max(1, 0.9 + this.u * 0.35));
        this.cx = s.width / 2;
        this.cy = s.height / 2;
        this.radius = m * 0.46;
        this.step = this.radius * 0.14;
        this.coreR = this.radius * 0.17;
    }

    private ringRadius(k: number): number {
        return this.radius * (0.34 + 0.14 * k);
    }

    private ensureTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        this.neonRamp = alphaRamp(rgbOf(theme.neon, [71, 246, 255]));
        this.textRamp = alphaRamp(theme.textRgb);
        this.idleCss = [theme.neon, theme.neonSecondary, theme.violet];
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        if (instrumentFamily(track.name) === 'kick') this.kickEnv = 1;
        for (let k = 0; k < RINGS; k++) {
            if (this.ringTrack[k] === track) this.flash[k * MAX_EVENTS_PER_TRACK + e] = 1;
        }
    };

    /** Keep assigned tracks while they play; fill free rings with the busiest others. */
    private assignRings(): void {
        for (let k = 0; k < RINGS; k++) {
            const t = this.ringTrack[k];
            if (t && t.count === 0) {
                this.ringTrack[k] = null;
                this.flash.fill(0, k * MAX_EVENTS_PER_TRACK, (k + 1) * MAX_EVENTS_PER_TRACK);
            }
        }
        for (let k = 0; k < RINGS; k++) {
            if (this.ringTrack[k]) continue;
            let best: VizTrack | null = null;
            for (const t of this.tracks.tracks) {
                if (t.count === 0 || this.ringTrack.includes(t)) continue;
                if (!best || t.count > best.count) best = t;
            }
            if (!best) break;
            this.ringTrack[k] = best;
            this.ringLevel[k] = 0;
        }
    }

    update(dt: number, s: VizServices): void {
        this.ensureTheme(s.theme);
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.playing = sync.pattern !== null;
        this.phase = sync.phase;
        // Tracks keep stale counts while stopped; only reassign while playing.
        if (this.playing) this.assignRings();
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        let rings = 0;
        for (let k = 0; k < RINGS; k++) {
            const on = this.playing && this.ringTrack[k] !== null;
            if (on) rings++;
            this.ringLevel[k] = follow(this.ringLevel[k], on ? 1 : 0, dt, 6, 4);
        }
        const idle = rings === 0;
        this.idleLevel = follow(this.idleLevel, idle ? 1 : 0, dt, 4, 6);
        // The idle clock picks up from the bar position so stopping doesn't jump.
        this.idlePhase = idle && !this.playing
            ? (this.idlePhase + dt * IDLE_RATE) % 1
            : this.phase;

        const fk = Math.exp(-dt * 5);
        for (let i = 0; i < this.flash.length; i++) this.flash[i] *= fk;
        this.kickEnv *= Math.exp(-dt * 7);
        const low = Number.isFinite(s.low) ? clamp01(s.low) : 0;
        const mid = Number.isFinite(s.mid) ? clamp01(s.mid) : 0;
        this.lowF = follow(this.lowF, low, dt, 30, 7);
        this.midF = follow(this.midF, mid, dt, 25, 6);
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (s.width <= 0 || s.height <= 0) return;
        if (this.u === 0) this.layout(s);
        this.ensureTheme(s.theme);
        const {cx, cy, lw, step} = this;

        ctx.save();
        ctx.lineCap = 'round';

        if (this.idleLevel > 0.01) this.drawIdle(ctx, this.idleLevel);

        const labels = step >= 16 && s.width >= 360;
        const fontSize = Math.round(Math.min(11, Math.max(9, 8 + this.u * 1.5)));
        const tick = step * 0.28;
        const litTick = step * 0.5;
        for (let k = 0; k < RINGS; k++) {
            const t = this.ringTrack[k];
            const level = this.ringLevel[k];
            if (!t || level < 0.01) continue;
            const r = this.ringRadius(k);
            const act = clamp01(t.activity);
            const base = k * MAX_EVENTS_PER_TRACK;
            ctx.strokeStyle = t.accentCss;

            ctx.globalAlpha = level * (0.22 + act * 0.25 + this.midF * 0.1);
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, TAU);
            ctx.stroke();

            // Resting ticks, batched.
            ctx.globalAlpha = level * 0.5;
            ctx.beginPath();
            for (let e = 0; e < t.count; e++) {
                const a = TOP + t.begins[e] * TAU;
                const c = Math.cos(a), sn = Math.sin(a);
                ctx.moveTo(cx + c * (r - tick / 2), cy + sn * (r - tick / 2));
                ctx.lineTo(cx + c * (r + tick / 2), cy + sn * (r + tick / 2));
            }
            ctx.stroke();

            // Lit ticks in two buckets, plus arcs for notes still sounding.
            for (let bucket = 0; bucket < 2; bucket++) {
                const bright = bucket === 1;
                ctx.globalAlpha = level * (bright ? 1 : 0.55);
                ctx.lineWidth = lw * (bright ? 1.8 : 1.4);
                ctx.beginPath();
                for (let e = 0; e < t.count; e++) {
                    const f = this.flash[base + e];
                    if (f < 0.08 || (f >= 0.5) !== bright) continue;
                    const a = TOP + t.begins[e] * TAU;
                    const c = Math.cos(a), sn = Math.sin(a);
                    const len = tick + (litTick - tick) * f;
                    ctx.moveTo(cx + c * (r - len / 2), cy + sn * (r - len / 2));
                    ctx.lineTo(cx + c * (r + len / 2), cy + sn * (r + len / 2));
                }
                if (bright && this.playing) {
                    for (let e = 0; e < t.count; e++) {
                        const b0 = t.begins[e];
                        if (b0 > this.phase || t.ends[e] <= this.phase || t.ends[e] - b0 < 0.1) continue;
                        const a0 = TOP + b0 * TAU;
                        ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
                        ctx.arc(cx, cy, r, a0, TOP + this.phase * TAU);
                    }
                }
                ctx.stroke();
            }

            // Orb: glides from the last onset to the next, arriving on it.
            const orbA = TOP + this.orbPhase(t) * TAU;
            const orbR = Math.max(2.5, step * 0.13) * (1 + act * 0.7);
            const ox = cx + Math.cos(orbA) * r, oy = cy + Math.sin(orbA) * r;
            ctx.globalAlpha = level;
            ctx.beginPath();
            ctx.arc(ox, oy, orbR, 0, TAU);
            ctx.fillStyle = s.theme.bg;
            ctx.fill();
            ctx.globalAlpha = level * (0.45 + act * 0.55);
            ctx.fillStyle = t.accentCss;
            ctx.fill();
            ctx.globalAlpha = level;
            ctx.lineWidth = lw;
            ctx.stroke();

            if (labels) {
                drawLabel(ctx, t.name, cx - 6 * this.u - 4, cy - r,
                    rampAt(this.textRamp, level * (0.4 + act * 0.45)), fontSize, 'right');
            }
        }
        ctx.globalAlpha = 1;

        // Playhead arm: the bar position (or the idle clock).
        const armPhase = this.playing ? this.phase : this.idlePhase;
        const armA = TOP + armPhase * TAU;
        const ac = Math.cos(armA), as = Math.sin(armA);
        ctx.strokeStyle = rampAt(this.neonRamp, 0.5);
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(cx + ac * this.coreR * 1.15, cy + as * this.coreR * 1.15);
        ctx.lineTo(cx + ac * this.radius * 0.98, cy + as * this.radius * 0.98);
        ctx.stroke();

        // Core: flat disc breathing with kicks, FFT low as the second opinion.
        const coreR = this.coreR * (1 + this.kickEnv * 0.16 + this.lowF * 0.08);
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, TAU);
        ctx.fillStyle = s.theme.bg;
        ctx.fill();
        ctx.fillStyle = rampAt(this.neonRamp, 0.08 + this.kickEnv * 0.3 + this.lowF * 0.12);
        ctx.fill();
        ctx.strokeStyle = s.theme.neon;
        ctx.lineWidth = lw * 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1.5, 2.5 * this.u), 0, TAU);
        ctx.fillStyle = s.theme.neonSecondary;
        ctx.fill();

        ctx.restore();
    }

    /** Bar phase of the orb: smoothstep between the surrounding onsets. */
    private orbPhase(t: VizTrack): number {
        if (t.count === 0) return this.phase;
        const p = this.phase;
        let prev = -Infinity, next = Infinity, first = Infinity, last = -Infinity;
        for (let e = 0; e < t.count; e++) {
            const b = t.begins[e];
            if (b < first) first = b;
            if (b > last) last = b;
            if (b <= p && b > prev) prev = b;
            if (b > p && b < next) next = b;
        }
        if (prev === -Infinity) prev = last - 1;
        if (next === Infinity) next = first + 1;
        const span = next - prev;
        if (span <= 1e-6) return next;
        return prev + span * smoothstep(clamp01((p - prev) / span));
    }

    /** Subdivision clock: rings of 4 / 8 / 16 ticks, the passing tick lit. */
    private drawIdle(ctx: CanvasRenderingContext2D, level: number): void {
        const {cx, cy, lw} = this;
        const tick = this.step * 0.28;
        for (let i = 0; i < IDLE_DIVISIONS.length; i++) {
            const n = IDLE_DIVISIONS[i];
            const r = this.ringRadius(i + 1);
            ctx.strokeStyle = this.idleCss[i];
            ctx.lineWidth = lw;
            ctx.globalAlpha = level * (0.16 + this.midF * 0.1);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = level * 0.4;
            ctx.beginPath();
            for (let j = 0; j < n; j++) {
                const a = TOP + (j / n) * TAU;
                const len = j % (n / 4) === 0 ? tick * 1.4 : tick;
                ctx.moveTo(cx + Math.cos(a) * (r - len / 2), cy + Math.sin(a) * (r - len / 2));
                ctx.lineTo(cx + Math.cos(a) * (r + len / 2), cy + Math.sin(a) * (r + len / 2));
            }
            ctx.stroke();
            const pos = this.idlePhase * n;
            const a = TOP + (Math.floor(pos) / n) * TAU;
            ctx.globalAlpha = level * beatEnv(pos);
            ctx.lineWidth = lw * 1.8;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * (r - tick), cy + Math.sin(a) * (r - tick));
            ctx.lineTo(cx + Math.cos(a) * (r + tick), cy + Math.sin(a) * (r + tick));
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
}

export const marbleCoreDef: VizModeDef = {
    id: 'marble-core',
    name: 'MARBLE CORE',
    create: () => new MarbleCoreMode(),
};
