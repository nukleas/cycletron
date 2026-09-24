/**
 * WAVE TERRAIN — the song's spectrum as a hidden-line ridge landscape
 * scrolling toward the viewer. Each ridge is one FFT snapshot on a
 * log-frequency axis (bass left, air right); the newest sits at the front and
 * older ones recede in perspective to the horizon.
 *
 * Mapping:
 *   cycle           → row clock: 16 ridges per bar, so the terrain is ruled
 *                     in musical time — downbeat ridges brightest, beats next
 *   FFT bins        → ridge height per band (followed, then stamped per row)
 *   scheduled haps  → an accent marker stamped on the newest ridge at the
 *                     hap's frequency (note fundamental or drum family band),
 *                     which then rides that ridge back to the horizon
 *   stopped         → a flat, calm grid still rolling on a slow time clock
 *
 * Each ridge is filled with the background before its stroke goes on top,
 * drawn far → near, so nearer ridges hide what's behind them.
 */

import {TrackModel, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {alphaRamp, follow, rampAt, rgbOf} from '../util.js';
import {SpectrumSampler, onsetAxis} from './flame-graph/spectrum.js';

const ROWS = 48;
const BANDS = 56;
const ROWS_PER_BAR = 16;
/** Row clock while stopped, rows per second. */
const IDLE_RATE = 4;
/** Depth of the oldest row relative to the newest; sets the perspective. */
const Z_FAR = 4;
const MAX_MARKS = 96;

class WaveTerrainMode implements VizMode {
    private readonly sampler = new SpectrumSampler(BANDS);
    private readonly target = new Float32Array(BANDS);
    private readonly level = new Float32Array(BANDS);
    /** Row ring: heights per band, the row's serial and its beat weight. */
    private readonly history = new Float32Array(ROWS * BANDS);
    private readonly rowSerial = new Float64Array(ROWS).fill(-1);
    private readonly rowKind = new Uint8Array(ROWS);
    private head = 0;
    /** Monotonic count of rows stamped — survives seeks and clock switches. */
    private serial = 0;
    /** Row clock position (in rows) and the last whole step stamped. */
    private pos = 0;
    private step = 0;
    private synced = false;
    private lastCycle = NaN;

    // Hap markers: pinned to a row serial and an axis position.
    private readonly markSerial = new Float64Array(MAX_MARKS).fill(-1);
    private readonly markAxis = new Float32Array(MAX_MARKS);
    private readonly markColor: string[] = new Array<string>(MAX_MARKS).fill('');
    private nextMark = 0;

    /** Per-row screen points, rebuilt while drawing that row. */
    private readonly xs = new Float32Array(BANDS);
    private readonly ys = new Float32Array(BANDS);
    /** Edge taper so each ridge starts and ends on its baseline. */
    private readonly taper = new Float32Array(BANDS);

    private readonly tracks = new TrackModel();

    private w = 0;
    private h = 0;
    private u = 1;
    private lw = 1;

    private theme: Theme | null = null;
    private lineRamp: string[] = [];
    private beatRamp: string[] = [];
    private horizonCss = '';

    constructor() {
        const edge = 4;
        for (let i = 0; i < BANDS; i++) {
            const d = Math.min(i, BANDS - 1 - i);
            this.taper[i] = d >= edge ? 1 : Math.sin((d / edge) * Math.PI * 0.5);
        }
        // Start with a full flat field so the grid is there from frame one.
        for (let r = ROWS - 1; r >= 0; r--) this.stampRow(-r);
    }

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (s.width === 0 || s.height === 0) return;
        this.u = Math.max(0.45, Math.min(s.width, s.height) / 720);
        this.lw = Math.max(1, Math.min(2, this.u * 1.1));
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const k = this.nextMark;
        this.nextMark = (k + 1) % MAX_MARKS;
        this.markSerial[k] = this.serial;
        this.markAxis[k] = onsetAxis(track, e);
        this.markColor[k] = track.accentCss;
    };

    private stampRow(step: number): void {
        this.serial++;
        this.head = (this.head + 1) % ROWS;
        const base = this.head * BANDS;
        for (let i = 0; i < BANDS; i++) this.history[base + i] = this.level[i];
        this.rowSerial[this.head] = this.serial;
        const m = ((step % ROWS_PER_BAR) + ROWS_PER_BAR) % ROWS_PER_BAR;
        this.rowKind[this.head] = m === 0 ? 2 : m % 4 === 0 ? 1 : 0;
    }

    update(dt: number, s: VizServices): void {
        if (this.w === 0 || this.h === 0) return;

        if (s.freqData && s.freqData.length >= 8) {
            this.sampler.sample(s.freqData, s.sampleRate, s.sensitivity, this.target);
        } else {
            this.target.fill(0);
        }
        for (let i = 0; i < BANDS; i++) {
            const t = this.target[i];
            this.level[i] = follow(this.level[i], Number.isFinite(t) ? Math.min(1.3, t) : 0, dt, 30, 8);
        }

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        const playing = sync.pattern !== null && Number.isFinite(s.cycle) && s.cycle > this.lastCycle;
        this.lastCycle = s.cycle;

        // Row clock: musical while playing, a slow time clock otherwise.
        let target: number;
        if (playing) {
            target = s.cycle * ROWS_PER_BAR;
            if (!this.synced || target < this.pos || target - this.pos > ROWS) {
                // Seek, live start or long stall: re-anchor without a burst.
                this.step = Math.floor(target);
                this.synced = true;
            }
        } else {
            target = this.pos + dt * IDLE_RATE;
            this.synced = false;
        }
        for (let n = 0; this.step < Math.floor(target) && n < ROWS; n++) {
            this.step++;
            this.stampRow(this.step);
        }
        if (this.step < Math.floor(target)) this.step = Math.floor(target);
        this.pos = target;

        // After stamping, so a hap marks the row its step just produced.
        if (playing) this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
    }

    private ensurePalette(t: Theme): void {
        if (t === this.theme) return;
        this.theme = t;
        this.lineRamp = alphaRamp(t.textRgb);
        this.beatRamp = alphaRamp(rgbOf(t.neon, t.textRgb));
        const [r, g, b] = t.borderRgb;
        this.horizonCss = `rgb(${r}, ${g}, ${b})`;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {w, h, u, lw} = this;
        if (w === 0 || h === 0) return;
        this.ensurePalette(s.theme);

        const horizon = h * 0.08;   // vanishing line
        const baseY = h * 0.93;
        const baseHalfW = w * 0.47;
        const peakH = (baseY - horizon) * 0.42;
        const frac = Math.min(1, Math.max(0, this.pos - this.step));
        const markR = Math.max(2.5, 4.5 * u);

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = this.horizonCss;
        ctx.lineWidth = lw;
        ctx.globalAlpha = 0.6;
        // Horizon rule where the oldest ridge fades out.
        const farY = horizon + (baseY - horizon) / Z_FAR;
        ctx.beginPath();
        ctx.moveTo(0, farY);
        ctx.lineTo(w, farY);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Far → near: the ring slot after head is the oldest row.
        for (let r = 1; r <= ROWS; r++) {
            const idx = (this.head + r) % ROWS;
            const serial = this.rowSerial[idx];
            if (serial < 0) continue;
            const age = this.serial - serial + frac;
            if (age > ROWS - 1) continue;
            const z = 1 + (age / (ROWS - 1)) * (Z_FAR - 1);
            const p = 1 / z;
            // Perspective depth in 0..1, 1 = front row.
            const near = (p - 1 / Z_FAR) / (1 - 1 / Z_FAR);
            const rowY = horizon + (baseY - horizon) * p;
            const halfW = baseHalfW * p;
            const left = w * 0.5 - halfW;
            const span = (halfW * 2) / (BANDS - 1);
            const lift = peakH * p;

            const base = idx * BANDS;
            ctx.beginPath();
            for (let b = 0; b < BANDS; b++) {
                const x = left + b * span;
                const y = rowY - this.history[base + b] * this.taper[b] * lift;
                this.xs[b] = x;
                this.ys[b] = y;
                if (b === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            // Open path: fill closes along the baseline (the tapered ends sit
            // on it), stroke draws only the ridge.
            ctx.fillStyle = s.theme.bg;
            ctx.fill();

            const kind = this.rowKind[idx];
            const alpha = (0.18 + 0.72 * near) * (kind === 2 ? 1.25 : kind === 1 ? 0.95 : 0.65);
            ctx.strokeStyle = rampAt(kind === 2 ? this.beatRamp : this.lineRamp, alpha);
            ctx.lineWidth = lw * (0.55 + 0.45 * near) * (kind === 2 ? 1.3 : 1);
            ctx.stroke();

            this.drawMarks(ctx, serial, span, near, markR * (0.35 + 0.65 * p));
        }
        ctx.restore();
    }

    /** Hap markers riding one ridge: small accent diamonds on the line. */
    private drawMarks(ctx: CanvasRenderingContext2D, serial: number, span: number, near: number, r: number): void {
        for (let k = 0; k < MAX_MARKS; k++) {
            if (this.markSerial[k] !== serial) continue;
            // Band b is centred at (b + 0.5) / BANDS on the sampler's axis.
            const pos = Math.min(BANDS - 1, Math.max(0, this.markAxis[k] * BANDS - 0.5));
            const i0 = Math.floor(pos);
            const i1 = Math.min(BANDS - 1, i0 + 1);
            const f = pos - i0;
            const x = this.xs[i0] + span * f;
            const y = this.ys[i0] + (this.ys[i1] - this.ys[i0]) * f;
            ctx.globalAlpha = 0.25 + 0.75 * near;
            ctx.fillStyle = this.markColor[k];
            ctx.beginPath();
            ctx.moveTo(x, y - r);
            ctx.lineTo(x + r, y);
            ctx.lineTo(x, y + r);
            ctx.lineTo(x - r, y);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

export const waveTerrainDef: VizModeDef = {
    id: 'wave-terrain',
    name: 'WAVE TERRAIN',
    create: () => new WaveTerrainMode(),
};
