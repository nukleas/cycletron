/**
 * FLAME GRAPH — spectrum flame: one silhouette across the canvas on a
 * log-frequency axis from 40 Hz on the left to 12 kHz on the right, with
 * embers lifting off the loudest bands. Deliberately bare: no rulers, ticks
 * or readouts — just the flame and its edge.
 *
 * Mapping:
 *   FFT bins        → flame height per band (fast attack, slow release)
 *   scheduled haps  → embers in the track's accent rising from the frequency
 *                     the hap sounds at — the note's fundamental for pitched
 *                     haps, the family's band for drums
 *   silence         → a low pilot flame that still flickers
 */

import {TrackModel, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {SeededRandom, follow, rgbOf} from '../util.js';
import {SpectrumSampler, onsetAxis} from './flame-graph/spectrum.js';

const BANDS = 64;
const MAX_EMBERS = 96;
/** Embers each scheduled hap lifts from its frequency. */
const HAP_EMBERS = 2;

class FlameGraphMode implements VizMode {
    private readonly sampler = new SpectrumSampler(BANDS);
    private readonly target = new Float32Array(BANDS);
    /** Followed band levels — the raw signal, never blurred in place. */
    private readonly bars = new Float32Array(BANDS);
    /** Render-only neighbour blur of `bars`, rebuilt each update. */
    private readonly shape = new Float32Array(BANDS);

    // Ember pool, struct of arrays; life <= 0 = free.
    private readonly ex = new Float32Array(MAX_EMBERS);
    private readonly ey = new Float32Array(MAX_EMBERS);
    private readonly evx = new Float32Array(MAX_EMBERS);
    private readonly evy = new Float32Array(MAX_EMBERS);
    private readonly elife = new Float32Array(MAX_EMBERS);
    /** Ember colour; FFT embers use the flame's own base colour. */
    private readonly ecolor: string[] = new Array<string>(MAX_EMBERS).fill('');
    private nextEmber = 0;


    private readonly tracks = new TrackModel();
    private readonly rng = new SeededRandom(0xf1a3e);
    private time = 0;

    // Layout, CSS px.
    private w = 0;
    private h = 0;
    private u = 1;
    private lw = 1;
    private baseY = 0;
    private maxH = 0;

    // Palette, rebuilt when the theme or geometry changes.
    private theme: Theme | null = null;
    private gradH = -1;
    private flameFill: CanvasGradient | string = '';
    private outlineCss = '';
    private emberCss = '';

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (s.width === 0 || s.height === 0) return;
        const u = Math.max(0.45, Math.min(s.width, s.height) / 720);
        this.u = u;
        this.lw = Math.max(1, Math.min(2, u));
        this.baseY = s.height;
        this.maxH = this.baseY * 0.84;
        this.gradH = -1;
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const pos = Math.min(BANDS - 1, Math.max(0, onsetAxis(track, e) * BANDS - 0.5));
        const i0 = Math.floor(pos);
        const i1 = Math.min(BANDS - 1, i0 + 1);
        const y = this.flameY(i0) + (this.flameY(i1) - this.flameY(i0)) * (pos - i0);
        for (let n = 0; n < HAP_EMBERS; n++) {
            this.spawnEmber(((pos + 0.5) / BANDS) * this.w, y, track.accentCss, 1.15);
        }
    };

    private spawnEmber(x: number, y: number, color: string, lift: number): void {
        const u = this.u;
        const k = this.nextEmber;
        this.nextEmber = (k + 1) % MAX_EMBERS;
        this.ex[k] = x + this.rng.range(-0.4, 0.4) * (this.w / BANDS);
        this.ey[k] = y;
        this.evx[k] = this.rng.range(-12, 12) * u;
        this.evy[k] = -this.rng.range(40, 90) * u * lift;
        this.elife[k] = this.rng.range(0.5, 0.8);
        this.ecolor[k] = color;
    }

    update(dt: number, s: VizServices): void {
        if (this.w === 0 || this.h === 0) return;
        this.time += dt;

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

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
            this.bars[i] = follow(this.bars[i], target, dt, 30, 6);
        }

        for (let i = 0; i < BANDS; i++) {
            const a = this.bars[i > 0 ? i - 1 : 0];
            const c = this.bars[i < BANDS - 1 ? i + 1 : BANDS - 1];
            this.shape[i] = Math.min(1.15, a * 0.25 + this.bars[i] * 0.5 + c * 0.25);
        }

        for (let i = 0; i < BANDS; i++) {
            const v = this.shape[i];
            if (v <= 0.45 || this.rng.next() >= v * dt * 4) continue;
            this.spawnEmber(((i + 0.5) / BANDS) * this.w, this.baseY - v * this.maxH, this.emberCss, 1);
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
        this.emberCss = t.active;
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

        // Embers.
        const es = Math.max(1.5, 2.2 * u);
        for (let k = 0; k < MAX_EMBERS; k++) {
            const life = this.elife[k];
            if (life <= 0) continue;
            ctx.globalAlpha = Math.min(1, life * 0.8);
            ctx.fillStyle = this.ecolor[k];
            ctx.fillRect(this.ex[k] - es * 0.5, this.ey[k] - es * 0.5, es, es);
        }
        ctx.restore();
    }
}

export const flameGraphDef: VizModeDef = {
    id: 'flame-graph',
    name: 'FLAME GRAPH',
    create: () => new FlameGraphMode(),
};
