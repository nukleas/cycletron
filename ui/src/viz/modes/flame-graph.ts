/**
 * FLAME GRAPH — spectrum flame: one silhouette across the canvas, a
 * log-frequency axis from 40 Hz on the left to 12 kHz on the right, with
 * peak-hold ticks and embers lifting off the loudest bands.
 *
 * Mapping:
 *   FFT bins        → flame height per band (fast attack, slow release)
 *   scheduled haps  → a flare in the track's accent at the frequency the hap
 *                     sounds at — the note's fundamental for pitched haps,
 *                     the family's band for drums — so you see which part of
 *                     the spectrum each track owns
 *   cycle           → the step ruler under the base: 16 cells per bar, the
 *                     current one lit, downbeat and beat ticks taller
 *   silence         → a low pilot flame that still flickers
 */

import {TrackModel, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {SeededRandom, alphaRamp, follow, rampAt, rgbOf} from '../util.js';
import {SpectrumSampler, onsetAxis} from './flame-graph/spectrum.js';

const BANDS = 64;
const MAX_EMBERS = 96;
const MAX_FLARES = 48;
const STEPS = 16;

class FlameGraphMode implements VizMode {
    private readonly sampler = new SpectrumSampler(BANDS);
    private readonly target = new Float32Array(BANDS);
    /** Followed band levels — the raw signal, never blurred in place. */
    private readonly bars = new Float32Array(BANDS);
    private readonly peaks = new Float32Array(BANDS);
    private readonly peakHold = new Float32Array(BANDS);
    /** Render-only neighbour blur of `bars`, rebuilt each update. */
    private readonly shape = new Float32Array(BANDS);

    // Ember pool, struct of arrays; life <= 0 = free.
    private readonly ex = new Float32Array(MAX_EMBERS);
    private readonly ey = new Float32Array(MAX_EMBERS);
    private readonly evx = new Float32Array(MAX_EMBERS);
    private readonly evy = new Float32Array(MAX_EMBERS);
    private readonly elife = new Float32Array(MAX_EMBERS);
    private nextEmber = 0;

    // Track flares, ring pool.
    private readonly flareAxis = new Float32Array(MAX_FLARES);
    private readonly flareLife = new Float32Array(MAX_FLARES);
    private readonly flareColor: string[] = new Array<string>(MAX_FLARES).fill('');
    private nextFlare = 0;

    private readonly tracks = new TrackModel();
    private readonly rng = new SeededRandom(0xf1a3e);
    private time = 0;
    private phase = 0;
    private playing = false;

    // Layout, CSS px.
    private w = 0;
    private h = 0;
    private u = 1;
    private lw = 1;
    private baseY = 0;
    private maxH = 0;
    private rulerY = 0;
    private rulerH = 0;

    // Palette, rebuilt when the theme or geometry changes.
    private theme: Theme | null = null;
    private gradH = -1;
    private flameFill: CanvasGradient | string = '';
    private outlineCss = '';
    private emberRamp: string[] = [];
    private tickRamp: string[] = [];
    private cellCss = '';

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (s.width === 0 || s.height === 0) return;
        const u = Math.max(0.45, Math.min(s.width, s.height) / 720);
        this.u = u;
        this.lw = Math.max(1, Math.min(2, u));
        this.rulerH = Math.max(5, 10 * u);
        this.rulerY = s.height - Math.max(4, 8 * u) - this.rulerH;
        this.baseY = this.rulerY - Math.max(3, 6 * u);
        this.maxH = this.baseY * 0.84;
        this.gradH = -1;
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const i = this.nextFlare;
        this.nextFlare = (i + 1) % MAX_FLARES;
        this.flareAxis[i] = onsetAxis(track, e);
        this.flareLife[i] = 1;
        this.flareColor[i] = track.accentCss;
    };

    update(dt: number, s: VizServices): void {
        if (this.w === 0 || this.h === 0) return;
        this.time += dt;

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
        this.playing = sync.pattern !== null;
        this.phase = sync.phase;

        if (s.freqData && s.freqData.length >= 8) {
            this.sampler.sample(s.freqData, s.sampleRate, s.sensitivity, this.target);
        } else {
            this.target.fill(0);
        }

        for (let i = 0; i < BANDS; i++) {
            // Pilot flame: never fully out, flickers on its own.
            const pilot = 0.022 + 0.014 * (0.5 + 0.5 * Math.sin(this.time * 2.3 + i * 0.9));
            const t = this.target[i];
            const target = Number.isFinite(t) ? Math.max(t, pilot) : pilot;
            const v = follow(this.bars[i], target, dt, 30, 6);
            this.bars[i] = v;
            if (v >= this.peaks[i]) {
                this.peaks[i] = v;
                this.peakHold[i] = 0.35;
            } else if (this.peakHold[i] > 0) {
                this.peakHold[i] -= dt;
            } else {
                this.peaks[i] = Math.max(v, this.peaks[i] - dt * 0.5);
            }
        }

        for (let i = 0; i < BANDS; i++) {
            const a = this.bars[i > 0 ? i - 1 : 0];
            const c = this.bars[i < BANDS - 1 ? i + 1 : BANDS - 1];
            this.shape[i] = Math.min(1.15, a * 0.25 + this.bars[i] * 0.5 + c * 0.25);
        }

        const u = this.u;
        for (let i = 0; i < BANDS; i++) {
            const v = this.shape[i];
            if (v <= 0.45 || this.rng.next() >= v * dt * 4) continue;
            const k = this.nextEmber;
            this.nextEmber = (k + 1) % MAX_EMBERS;
            this.ex[k] = ((i + 0.5) / BANDS + this.rng.range(-0.4, 0.4) / BANDS) * this.w;
            this.ey[k] = this.baseY - v * this.maxH;
            this.evx[k] = this.rng.range(-12, 12) * u;
            this.evy[k] = -this.rng.range(40, 90) * u;
            this.elife[k] = this.rng.range(0.5, 0.8);
        }
        const drag = Math.exp(-dt * 2.5);
        for (let k = 0; k < MAX_EMBERS; k++) {
            if (this.elife[k] <= 0) continue;
            this.ex[k] += this.evx[k] * dt;
            this.ey[k] += this.evy[k] * dt;
            this.evx[k] *= drag;
            this.evy[k] *= drag;
            this.elife[k] -= dt * 1.4;
        }

        for (let k = 0; k < MAX_FLARES; k++) {
            if (this.flareLife[k] > 0) this.flareLife[k] -= dt * 1.8;
        }
    }

    private ensurePalette(ctx: CanvasRenderingContext2D, t: Theme): void {
        if (t === this.theme && this.gradH === this.h) return;
        this.theme = t;
        this.gradH = this.h;
        const active = rgbOf(t.active, [255, 214, 10]);
        const red = rgbOf(t.red, [255, 59, 48]);
        const secondary = rgbOf(t.neonSecondary, [255, 0, 170]);
        // Hot at the base, cooling to the tips — geometry is fixed, so the
        // gradient only changes on resize or theme change.
        const g = ctx.createLinearGradient(0, this.baseY, 0, this.baseY - this.maxH);
        g.addColorStop(0, `rgba(${active[0]}, ${active[1]}, ${active[2]}, 0.85)`);
        g.addColorStop(0.4, `rgba(${red[0]}, ${red[1]}, ${red[2]}, 0.78)`);
        g.addColorStop(1, `rgba(${secondary[0]}, ${secondary[1]}, ${secondary[2]}, 0.6)`);
        this.flameFill = g;
        this.outlineCss = `rgba(${active[0]}, ${active[1]}, ${active[2]}, 0.7)`;
        this.emberRamp = alphaRamp(active);
        this.tickRamp = alphaRamp(t.textRgb);
        this.cellCss = t.neon;
    }

    private flameY(i: number): number {
        return this.baseY - this.shape[i] * this.maxH;
    }

    /** Traces the flame's top edge — quadratic through band midpoints. */
    private traceEdge(ctx: CanvasRenderingContext2D): void {
        const w = this.w;
        for (let i = 1; i < BANDS; i++) {
            const xPrev = ((i - 0.5) / BANDS) * w;
            const x = ((i + 0.5) / BANDS) * w;
            const yPrev = this.flameY(i - 1);
            ctx.quadraticCurveTo(xPrev, yPrev, (x + xPrev) * 0.5, (this.flameY(i) + yPrev) * 0.5);
        }
        ctx.lineTo(w, this.flameY(BANDS - 1));
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {w, h, u, lw} = this;
        if (w === 0 || h === 0) return;
        this.ensurePalette(ctx, s.theme);
        ctx.save();

        // Flame body: one flat fill under the edge, one outline along it.
        ctx.beginPath();
        ctx.moveTo(0, this.baseY);
        ctx.lineTo(0, this.flameY(0));
        this.traceEdge(ctx);
        ctx.lineTo(w, this.baseY);
        ctx.closePath();
        ctx.fillStyle = this.flameFill;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, this.flameY(0));
        this.traceEdge(ctx);
        ctx.strokeStyle = this.outlineCss;
        ctx.lineWidth = lw;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Peak-hold ticks, one batched path.
        const tickW = Math.max(2, (w / BANDS) * 0.5);
        const tickH = Math.max(1, lw);
        ctx.fillStyle = rampAt(this.emberRamp, 0.75);
        ctx.beginPath();
        for (let i = 0; i < BANDS; i++) {
            const p = this.peaks[i];
            if (p < 0.06) continue;
            const x = ((i + 0.5) / BANDS) * w;
            ctx.rect(x - tickW * 0.5, this.baseY - Math.min(1.15, p) * this.maxH - tickH * 2, tickW, tickH);
        }
        ctx.fill();

        // Track flares: a stem from the base to just above the flame at the
        // hap's frequency, capped with a short bar, in the track's accent.
        const capW = 7 * u;
        const lift = 26 * u;
        ctx.lineWidth = lw * 1.5;
        ctx.lineCap = 'butt';
        for (let k = 0; k < MAX_FLARES; k++) {
            const life = this.flareLife[k];
            if (life <= 0) continue;
            // Band i is centred at (i + 0.5) / BANDS on the axis.
            const pos = Math.min(BANDS - 1, Math.max(0, this.flareAxis[k] * BANDS - 0.5));
            const i0 = Math.floor(pos);
            const i1 = Math.min(BANDS - 1, i0 + 1);
            const y = this.flameY(i0) + (this.flameY(i1) - this.flameY(i0)) * (pos - i0);
            const x = ((pos + 0.5) / BANDS) * w;
            const top = y - lift * (0.4 + 0.6 * life);
            ctx.globalAlpha = life * 0.9;
            ctx.strokeStyle = this.flareColor[k];
            ctx.beginPath();
            ctx.moveTo(x, this.baseY);
            ctx.lineTo(x, top);
            ctx.moveTo(x - capW * 0.5, top);
            ctx.lineTo(x + capW * 0.5, top);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Embers.
        const es = Math.max(1.5, 2.2 * u);
        for (let k = 0; k < MAX_EMBERS; k++) {
            const life = this.elife[k];
            if (life <= 0) continue;
            ctx.fillStyle = rampAt(this.emberRamp, life * 0.8);
            ctx.fillRect(this.ex[k] - es * 0.5, this.ey[k] - es * 0.5, es, es);
        }

        this.drawRuler(ctx);
        ctx.restore();
    }

    /** Step ruler: 16 cells per bar under the base, current cell lit. */
    private drawRuler(ctx: CanvasRenderingContext2D): void {
        const {w, lw, rulerY, rulerH} = this;
        const cell = w / STEPS;
        if (this.playing) {
            const step = Math.min(STEPS - 1, Math.floor(this.phase * STEPS));
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = this.cellCss;
            ctx.fillRect(step * cell, rulerY, cell, rulerH);
            ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = rampAt(this.tickRamp, this.playing ? 0.45 : 0.22);
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(0, this.baseY + lw * 0.5);
        ctx.lineTo(w, this.baseY + lw * 0.5);
        for (let k = 0; k <= STEPS; k++) {
            const x = Math.min(w - lw * 0.5, Math.max(lw * 0.5, k * cell));
            const len = k % STEPS === 0 ? rulerH : k % 4 === 0 ? rulerH * 0.7 : rulerH * 0.35;
            ctx.moveTo(x, rulerY + rulerH);
            ctx.lineTo(x, rulerY + rulerH - len);
        }
        ctx.stroke();
    }
}

export const flameGraphDef: VizModeDef = {
    id: 'flame-graph',
    name: 'FLAME GRAPH',
    create: () => new FlameGraphMode(),
};
