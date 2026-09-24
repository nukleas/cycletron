/**
 * NEON CIRCUIT — the pattern as a two-layer circuit board, drawn in the flat
 * PCB-viewer idiom (KiCad / tscircuit): copper traces, pads, vias with drill
 * holes, silkscreen outlines and reference labels on a dark board.
 *
 *   U0 SEQ          → the scheduler chip on the left; every note leaves here
 *   U1…U8           → one IC per track, stacked down the middle, labelled
 *                     with the track's name
 *   J1 OUT          → the output header on the right
 *   copper          → horizontal runs on the top layer in the track's accent,
 *                     vertical runs on the bottom layer, a via at every
 *                     layer change — so crossings are legal, as on a board
 *   scheduled hap   → a pulse leaves SEQ ahead of time and reaches the IC's
 *                     input pad exactly on the onset, flashing each via it
 *                     passes; the IC lights and the signal carries on to J1
 *   kick onsets     → the power rails along the board edges surge
 *   no pattern      → four idle ICs; FFT transients and a slow clock tick
 *                     send the pulses
 *
 * Incoming pulses are stateless — their position is the time left until the
 * hap, read two bars ahead — so they can't drift from the schedule. Routes
 * are rebuilt only on layout or when the chip count changes; pulses on their
 * way out live in a fixed pool.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel, instrumentFamily, type TrackSync, type VizTrack} from '../tracks.js';
import {TransientDetector, alphaRamp, clamp01, drawLabel, mixRgb, rampAt, rgbOf} from '../util.js';
import {currentBpm} from '../../bpm.js';

const MAX_CHIPS = 8;
const IDLE_CHIPS = 4;
const IDLE_NAMES = ['CLK', 'LOW', 'MID', 'HIGH'];
/** Seconds a pulse takes from SEQ to its IC — it launches this far ahead. */
const IN_SECONDS = 0.45;
/** Seconds from an IC to the output header. */
const OUT_SECONDS = 0.35;
const MAX_PULSES = 64;
/** Points per route: pin → via → via → pin. */
const ROUTE_POINTS = 4;
const IDLE_CLOCK = 1.2;
/** Pads per side on a track IC. */
const IC_PINS = 4;

type RGB = readonly [number, number, number];

/** One pin-to-pin run: top layer, a via, bottom layer, a via, top layer. */
interface Route {
    xs: Float32Array;
    ys: Float32Array;
    /** Cumulative length at each point. */
    cum: Float32Array;
    length: number;
    /** False when the run is straight (no layer change, no vias). */
    vias: boolean;
}

interface Chip {
    name: string;
    color: string;
    track: VizTrack | null;
    /** Body rectangle (CSS px). */
    x: number;
    y: number;
    w: number;
    h: number;
    in: Route;
    out: Route;
    flash: number;
    /** Glow on the two vias of each route. */
    viaIn: Float32Array;
    viaOut: Float32Array;
}

function newRoute(): Route {
    return {
        xs: new Float32Array(ROUTE_POINTS),
        ys: new Float32Array(ROUTE_POINTS),
        cum: new Float32Array(ROUTE_POINTS),
        length: 0,
        vias: true,
    };
}

/** Pin → turn → turn → pin, with the vertical leg on the bottom layer. */
function setRoute(r: Route, x0: number, y0: number, lane: number, x1: number, y1: number): void {
    r.xs[0] = x0; r.ys[0] = y0;
    r.xs[1] = lane; r.ys[1] = y0;
    r.xs[2] = lane; r.ys[2] = y1;
    r.xs[3] = x1; r.ys[3] = y1;
    r.cum[0] = 0;
    for (let i = 1; i < ROUTE_POINTS; i++) {
        r.cum[i] = r.cum[i - 1] + Math.abs(r.xs[i] - r.xs[i - 1]) + Math.abs(r.ys[i] - r.ys[i - 1]);
    }
    r.length = r.cum[ROUTE_POINTS - 1];
    r.vias = Math.abs(y1 - y0) > 0.5;
}

class NeonCircuitMode implements VizMode {
    /** Two bars, so a pulse can leave before the bar line for an early hap. */
    private readonly tracks = new TrackModel(2);
    private readonly transients = new TransientDetector(0.3, 0.35, 0.5);

    private readonly chips: Chip[] = [];
    private chipCount = -1;
    private readonly live: VizTrack[] = [];
    private playing = false;
    private phase = 0;
    /** Cycles an inbound pulse spends on its route at the current tempo. */
    private travel = 0.2;
    private bar = 0;

    // Board geometry (layout).
    private w = 0;
    private h = 0;
    private u = 1;
    private trace = 2;
    private bx0 = 0;
    private by0 = 0;
    private bx1 = 0;
    private by1 = 0;
    private seqX = 0;
    private seqY = 0;
    private seqW = 0;
    private seqH = 0;
    private jX = 0;
    private readonly seqPinY = new Float32Array(MAX_CHIPS);
    private readonly jPinY = new Float32Array(MAX_CHIPS);

    // Pulse pools, struct of arrays; chip -1 = free. Idle pulses run inbound
    // on their own clock, outbound pulses run chip → J1.
    private readonly iChip = new Int8Array(MAX_PULSES).fill(-1);
    private readonly iT = new Float32Array(MAX_PULSES);
    private iNext = 0;
    private readonly oChip = new Int8Array(MAX_PULSES).fill(-1);
    private readonly oT = new Float32Array(MAX_PULSES);
    private oNext = 0;

    private rail = 0;
    private idleTimer = 0;

    // Theme cache.
    private theme: Theme | null = null;
    private boardCss = '';
    private edgeCss = '';
    private gridCss = '';
    private bodyCss = '';
    private padCss = '';
    private holeCss = '';
    private silkRamp: string[] = [];
    private bottomRamp: string[] = [];
    private railRamp: string[] = [];
    private readonly idleCss: string[] = [];

    // Scratch for pointAt().
    private px = 0;
    private py = 0;

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (!(s.width > 0 && s.height > 0)) return;
        this.u = Math.max(0.5, Math.min(s.width, s.height) / 720);
        this.trace = Math.max(1.5, Math.min(3.5, 2.2 * this.u));
        const m = Math.max(10, Math.min(s.width, s.height) * 0.04);
        this.bx0 = m;
        this.by0 = m;
        this.bx1 = s.width - m;
        this.by1 = s.height - m;
        this.chipCount = -1; // re-place chips and routes at the new size
    }

    private ensureTheme(t: Theme): void {
        if (t === this.theme) return;
        this.theme = t;
        const neon = rgbOf(t.neon, [71, 246, 255]);
        const css = (c: RGB): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
        this.boardCss = css(mixRgb(t.bgRgb, t.bgLightRgb, 0.7));
        this.edgeCss = `rgba(${t.borderRgb[0]}, ${t.borderRgb[1]}, ${t.borderRgb[2]}, 0.9)`;
        this.gridCss = `rgba(${t.borderRgb[0]}, ${t.borderRgb[1]}, ${t.borderRgb[2]}, 0.35)`;
        this.bodyCss = css(t.bgRgb);
        this.padCss = css(mixRgb(t.textRgb, t.bgRgb, 0.35));
        this.holeCss = t.bg;
        // Silkscreen leans toward the theme's yellow, as on a real board.
        this.silkRamp = alphaRamp(mixRgb(t.textRgb, rgbOf(t.active, [247, 255, 90]), 0.35), 24);
        this.bottomRamp = alphaRamp(mixRgb(t.borderRgb, neon, 0.35), 24);
        this.railRamp = alphaRamp(neon, 24);
        const pool = t.accentPool;
        this.idleCss.length = 0;
        for (const c of [pool[0], pool[1], pool[3], pool[4]]) this.idleCss.push(css(c));
    }

    /** Chips follow the live track list while playing; four idle chips otherwise. */
    private syncChips(): void {
        const live = this.live;
        live.length = 0;
        if (this.playing) {
            for (const tr of this.tracks.tracks) {
                if (live.length >= MAX_CHIPS) break;
                if (tr.count > 0 || tr.activity > 0.02) live.push(tr);
            }
        }
        const n = this.playing ? live.length : IDLE_CHIPS;
        if (n !== this.chipCount) this.placeChips(n);
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            if (this.playing) {
                c.track = live[i];
                c.name = live[i].name;
                c.color = live[i].accentCss;
            } else {
                c.track = null;
                c.name = IDLE_NAMES[i];
                c.color = this.idleCss[i];
            }
        }
    }

    /** Lay the board out for `n` chips: SEQ left, ICs in a column, J1 right. */
    private placeChips(n: number): void {
        this.chipCount = n;
        while (this.chips.length < n) {
            this.chips.push({
                name: '', color: '', track: null,
                x: 0, y: 0, w: 0, h: 0, in: newRoute(), out: newRoute(),
                flash: 0, viaIn: new Float32Array(2), viaOut: new Float32Array(2),
            });
        }
        const bw = this.bx1 - this.bx0;
        const bh = this.by1 - this.by0;
        const midY = (this.by0 + this.by1) / 2;

        // SEQ: a tall chip on the left, one output pin per track.
        this.seqW = Math.min(bw * 0.09, 70 * this.u);
        this.seqH = Math.min(bh * 0.6, Math.max(n, 4) * 22 * this.u);
        this.seqX = this.bx0 + bw * 0.1;
        this.seqY = midY - this.seqH / 2;
        // J1: a pin header on the right.
        this.jX = this.bx1 - bw * 0.07;
        // SEQ output pins sit exactly on its pads (drawIC spaces them the same).
        for (let i = 0; i < n; i++) {
            this.seqPinY[i] = this.seqY + this.seqH * ((i + 0.5) / n);
            this.jPinY[i] = midY + (this.seqPinY[i] - midY) * 1.15;
        }

        // The IC column, with each track's own vertical lane on both sides.
        const rowsTop = this.by0 + bh * 0.08;
        const pitch = (bh * 0.84) / Math.max(1, n);
        const icW = Math.min(bw * 0.12, 96 * this.u);
        const icH = Math.min(pitch * 0.62, 56 * this.u);
        const icX = this.bx0 + bw * 0.5 - icW / 2;
        const inLane0 = this.seqX + this.seqW + bw * 0.05;
        const inLane1 = icX - bw * 0.05;
        const outLane0 = icX + icW + bw * 0.05;
        const outLane1 = this.jX - bw * 0.05;
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            c.w = icW;
            c.h = icH;
            c.x = icX;
            c.y = rowsTop + pitch * (i + 0.5) - icH / 2;
            const f = n <= 1 ? 0.5 : i / (n - 1);
            // Input on the IC's second pad down the left, output on the third
            // down the right (of IC_PINS per side).
            setRoute(c.in, this.seqX + this.seqW, this.seqPinY[i],
                inLane0 + (inLane1 - inLane0) * f, icX, c.y + icH * (1.5 / IC_PINS));
            setRoute(c.out, icX + icW, c.y + icH * (2.5 / IC_PINS),
                outLane1 - (outLane1 - outLane0) * f, this.jX, this.jPinY[i]);
        }
    }

    private readonly onOnset = (track: VizTrack): void => {
        if (instrumentFamily(track.name) === 'kick') this.rail = 1;
        for (let i = 0; i < this.chipCount; i++) {
            if (this.chips[i].track !== track) continue;
            this.chips[i].flash = 1;
            this.launch(this.oChip, this.oT, i, true);
        }
    };

    private launch(pool: Int8Array, ts: Float32Array, chip: number, out: boolean): void {
        const k = out ? this.oNext : this.iNext;
        if (out) this.oNext = (k + 1) % MAX_PULSES;
        else this.iNext = (k + 1) % MAX_PULSES;
        pool[k] = chip;
        ts[k] = 0;
    }

    update(dt: number, s: VizServices): void {
        if (!(this.w > 0 && this.h > 0)) return;
        this.ensureTheme(s.theme);
        const sync: TrackSync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.playing = sync.pattern !== null;
        this.phase = sync.phase;
        this.bar = Math.floor(s.cycle);
        this.travel = Math.max(0.01, IN_SECONDS * currentBpm() / 240);
        this.syncChips();
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        const low = Number.isFinite(s.low) ? Math.max(0, s.low) : 0;
        const mid = Number.isFinite(s.mid) ? Math.max(0, s.mid) : 0;
        const high = Number.isFinite(s.high) ? Math.max(0, s.high) : 0;
        const hits = this.transients.update(dt, low, mid, high);
        if (!this.playing) {
            if (hits.kick) {
                this.launch(this.iChip, this.iT, 1, false);
                this.rail = Math.max(this.rail, 0.6);
            }
            if (hits.snare) this.launch(this.iChip, this.iT, 2, false);
            if (hits.hat) this.launch(this.iChip, this.iT, 3, false);
            this.idleTimer += dt;
            if (this.idleTimer >= IDLE_CLOCK) {
                this.idleTimer = 0;
                this.launch(this.iChip, this.iT, 0, false);
            }
        } else {
            this.idleTimer = 0;
        }

        const fk = Math.exp(-dt * 5);
        const vk = Math.exp(-dt * 6);
        for (let i = 0; i < this.chipCount; i++) {
            const c = this.chips[i];
            c.flash *= fk;
            c.viaIn[0] *= vk; c.viaIn[1] *= vk;
            c.viaOut[0] *= vk; c.viaOut[1] *= vk;
        }
        this.rail *= Math.exp(-dt * 3.5);

        // Idle inbound pulses run on time; arriving fires the chip.
        for (let k = 0; k < MAX_PULSES; k++) {
            const ci = this.iChip[k];
            if (ci < 0) continue;
            if (ci >= this.chipCount) { this.iChip[k] = -1; continue; }
            const t = this.iT[k] + dt / IN_SECONDS;
            if (t >= 1) {
                this.iChip[k] = -1;
                this.chips[ci].flash = 1;
                this.launch(this.oChip, this.oT, ci, true);
                continue;
            }
            this.iT[k] = t;
            this.touchVias(this.chips[ci].in, this.chips[ci].viaIn, t);
        }
        for (let k = 0; k < MAX_PULSES; k++) {
            const ci = this.oChip[k];
            if (ci < 0) continue;
            if (ci >= this.chipCount) { this.oChip[k] = -1; continue; }
            const t = this.oT[k] + dt / OUT_SECONDS;
            if (t >= 1) { this.oChip[k] = -1; continue; }
            this.oT[k] = t;
            this.touchVias(this.chips[ci].out, this.chips[ci].viaOut, t);
        }

        // Scheduled inbound pulses: stateless, placed by the time left to the onset.
        if (this.playing) {
            for (let i = 0; i < this.chipCount; i++) {
                const c = this.chips[i];
                const tr = c.track!;
                for (let e = 0; e < tr.count; e++) {
                    const left = tr.begins[e] - this.phase;
                    if (left > 0 && left <= this.travel) this.touchVias(c.in, c.viaIn, 1 - left / this.travel);
                }
            }
        }
    }

    /** Light a route's vias while a pulse at progress `t` passes over them. */
    private touchVias(r: Route, glow: Float32Array, t: number): void {
        if (!r.vias) return;
        const d = t * r.length;
        const reach = 12 * this.u;
        for (let v = 0; v < 2; v++) {
            const near = 1 - Math.abs(d - r.cum[v + 1]) / reach;
            if (near > glow[v]) glow[v] = near;
        }
    }

    /** Point at distance `d` along a route → this.px / this.py. */
    private pointAt(r: Route, d: number): void {
        let i = 1;
        while (i < ROUTE_POINTS - 1 && r.cum[i] < d) i++;
        const seg = r.cum[i] - r.cum[i - 1];
        const f = seg > 0 ? clamp01((d - r.cum[i - 1]) / seg) : 0;
        this.px = r.xs[i - 1] + (r.xs[i] - r.xs[i - 1]) * f;
        this.py = r.ys[i - 1] + (r.ys[i] - r.ys[i - 1]) * f;
    }

    /** A bright run of copper ending at progress `t`, with a square head. */
    private drawPulse(ctx: CanvasRenderingContext2D, r: Route, t: number, color: string): void {
        const d = t * r.length;
        const tail = Math.min(d, 28 * this.u);
        ctx.strokeStyle = color;
        ctx.lineWidth = this.trace * 1.4;
        ctx.beginPath();
        this.pointAt(r, d - tail);
        ctx.moveTo(this.px, this.py);
        for (let i = 1; i < ROUTE_POINTS - 1; i++) {
            if (r.cum[i] > d - tail && r.cum[i] < d) ctx.lineTo(r.xs[i], r.ys[i]);
        }
        this.pointAt(r, d);
        ctx.lineTo(this.px, this.py);
        ctx.stroke();
        const hs = this.trace * 2.2;
        ctx.fillStyle = color;
        ctx.fillRect(this.px - hs / 2, this.py - hs / 2, hs, hs);
    }

    private leg(ctx: CanvasRenderingContext2D, r: Route, from: number): void {
        ctx.moveTo(r.xs[from], r.ys[from]);
        ctx.lineTo(r.xs[from + 1], r.ys[from + 1]);
    }

    render(ctx: CanvasRenderingContext2D, _s: VizServices): void {
        const {w, h, u, trace} = this;
        if (!(w > 0 && h > 0) || this.chipCount < 0) return;
        const n = this.chipCount;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Board: fill, edge cuts, a sparse dot grid.
        const {bx0, by0, bx1, by1} = this;
        ctx.beginPath();
        ctx.roundRect(bx0, by0, bx1 - bx0, by1 - by0, 8 * u);
        ctx.fillStyle = this.boardCss;
        ctx.fill();
        ctx.strokeStyle = this.edgeCss;
        ctx.lineWidth = 1;
        ctx.stroke();
        const step = Math.max(14, 26 * u);
        const dot = Math.max(1, u);
        ctx.fillStyle = this.gridCss;
        ctx.beginPath();
        for (let y = by0 + step; y < by1 - step * 0.5; y += step) {
            for (let x = bx0 + step; x < bx1 - step * 0.5; x += step) ctx.rect(x, y, dot, dot);
        }
        ctx.fill();

        // Power rails along the top and bottom edges, stubs to SEQ and the ICs.
        const inset = step * 0.6;
        const railA = by0 + inset;
        const railB = by1 - inset;
        ctx.strokeStyle = rampAt(this.railRamp, 0.22 + this.rail * 0.6);
        ctx.lineWidth = trace * (1.8 + this.rail * 0.8);
        ctx.beginPath();
        ctx.moveTo(bx0 + inset, railA);
        ctx.lineTo(bx1 - inset, railA);
        ctx.moveTo(bx0 + inset, railB);
        ctx.lineTo(bx1 - inset, railB);
        ctx.stroke();
        ctx.strokeStyle = rampAt(this.railRamp, 0.16 + this.rail * 0.4);
        ctx.lineWidth = trace;
        ctx.beginPath();
        const seqMid = this.seqX + this.seqW * 0.5;
        ctx.moveTo(seqMid, railA);
        ctx.lineTo(seqMid, this.seqY);
        ctx.moveTo(seqMid, this.seqY + this.seqH);
        ctx.lineTo(seqMid, railB);
        if (n > 0) {
            const first = this.chips[0];
            const last = this.chips[n - 1];
            ctx.moveTo(first.x + first.w * 0.5, railA);
            ctx.lineTo(first.x + first.w * 0.5, first.y);
            ctx.moveTo(last.x + last.w * 0.5, last.y + last.h);
            ctx.lineTo(last.x + last.w * 0.5, railB);
        }
        ctx.stroke();

        // Bottom-layer copper: every vertical leg, one batched path.
        ctx.strokeStyle = rampAt(this.bottomRamp, 0.75);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            if (c.in.vias) this.leg(ctx, c.in, 1);
            if (c.out.vias) this.leg(ctx, c.out, 1);
        }
        ctx.stroke();

        // Top-layer copper: horizontal legs in the chip's colour.
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            ctx.strokeStyle = c.color;
            ctx.globalAlpha = 0.32 + c.flash * 0.3;
            ctx.beginPath();
            this.leg(ctx, c.in, 0);
            this.leg(ctx, c.in, 2);
            this.leg(ctx, c.out, 0);
            this.leg(ctx, c.out, 2);
            if (!c.in.vias) this.leg(ctx, c.in, 1);
            if (!c.out.vias) this.leg(ctx, c.out, 1);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Vias: annular ring, drill hole, the track's colour while a pulse passes.
        const viaR = trace * 1.9;
        const holeR = trace * 0.8;
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            this.drawVias(ctx, c.in, c.viaIn, c.color, viaR, holeR);
            this.drawVias(ctx, c.out, c.viaOut, c.color, viaR, holeR);
        }

        // Pulses.
        if (this.playing) {
            for (let i = 0; i < n; i++) {
                const c = this.chips[i];
                const tr = c.track!;
                for (let e = 0; e < tr.count; e++) {
                    const left = tr.begins[e] - this.phase;
                    if (left > 0 && left <= this.travel) this.drawPulse(ctx, c.in, 1 - left / this.travel, c.color);
                }
            }
        }
        for (let k = 0; k < MAX_PULSES; k++) {
            const ci = this.iChip[k];
            if (ci >= 0 && ci < n) this.drawPulse(ctx, this.chips[ci].in, this.iT[k], this.chips[ci].color);
            const co = this.oChip[k];
            if (co >= 0 && co < n) this.drawPulse(ctx, this.chips[co].out, this.oT[k], this.chips[co].color);
        }

        // Components: SEQ, the ICs, J1.
        const fs = Math.round(Math.min(11, Math.max(9, 8 + u * 1.5)));
        const labels = w >= 360 && h >= 260;
        this.drawIC(ctx, this.seqX, this.seqY, this.seqW, this.seqH, 'U0', 'SEQ', null, Math.max(1, n), labels, fs);
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            this.drawIC(ctx, c.x, c.y, c.w, c.h, `U${i + 1}`, c.name.toUpperCase(), c, IC_PINS, labels, fs);
        }
        this.drawHeader(ctx, n, labels, fs);

        if (labels) {
            const status = this.playing ? `BAR ${this.bar + 1}` : 'STANDBY';
            drawLabel(ctx, `CYCLETRON  REV A  ·  ${status}`, bx0 + step, railB - fs * 1.4,
                rampAt(this.silkRamp, 0.45), fs);
        }
        ctx.restore();
    }

    private drawVias(
        ctx: CanvasRenderingContext2D, r: Route, glow: Float32Array, color: string, viaR: number, holeR: number,
    ): void {
        if (!r.vias) return;
        for (let v = 0; v < 2; v++) {
            const x = r.xs[v + 1];
            const y = r.ys[v + 1];
            ctx.beginPath();
            ctx.arc(x, y, viaR, 0, Math.PI * 2);
            ctx.fillStyle = this.padCss;
            ctx.fill();
            if (glow[v] > 0.02) {
                ctx.globalAlpha = clamp01(glow[v]);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.beginPath();
            ctx.arc(x, y, holeR, 0, Math.PI * 2);
            ctx.fillStyle = this.holeCss;
            ctx.fill();
        }
    }

    /** An IC footprint: body, silkscreen outline, pin-1 dot, pads down each side. */
    private drawIC(
        ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
        ref: string, value: string, chip: Chip | null, pinsPerSide: number, labels: boolean, fs: number,
    ): void {
        const u = this.u;
        const flash = chip ? chip.flash : 0;
        ctx.fillStyle = this.bodyCss;
        ctx.fillRect(x, y, w, h);
        if (chip && flash > 0.02) {
            ctx.globalAlpha = flash * 0.35;
            ctx.fillStyle = chip.color;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
        }
        const silk = rampAt(this.silkRamp, 0.7);
        ctx.strokeStyle = silk;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        const dotR = Math.max(1.2, 2 * u);
        ctx.beginPath();
        ctx.arc(x + dotR * 2.2, y + dotR * 2.2, dotR, 0, Math.PI * 2);
        ctx.fillStyle = silk;
        ctx.fill();

        const padW = Math.max(3, 6 * u);
        const padH = Math.max(2, Math.min(h / (pinsPerSide * 2 + 1), 5 * u));
        ctx.fillStyle = this.padCss;
        ctx.beginPath();
        for (let p = 0; p < pinsPerSide; p++) {
            const py = y + h * ((p + 0.5) / pinsPerSide) - padH / 2;
            ctx.rect(x - padW, py, padW, padH);
            ctx.rect(x + w, py, padW, padH);
        }
        ctx.fill();
        if (chip) {
            // The two live pads — input and output — in the chip's colour.
            ctx.fillStyle = chip.color;
            ctx.globalAlpha = 0.5 + flash * 0.5;
            ctx.fillRect(x - padW, chip.in.ys[3] - padH / 2, padW, padH);
            ctx.fillRect(x + w, chip.out.ys[0] - padH / 2, padW, padH);
            ctx.globalAlpha = 1;
        }

        if (labels) {
            drawLabel(ctx, ref, x, y - fs * 0.8, rampAt(this.silkRamp, 0.75), fs);
            const maxChars = Math.max(2, Math.floor((w - 8 * u) / (fs * 0.62)));
            const text = value.length > maxChars ? value.slice(0, maxChars - 1) + '…' : value;
            drawLabel(ctx, text, x + w / 2, y + h / 2, rampAt(this.silkRamp, 0.55 + flash * 0.45), fs, 'center');
        }
    }

    /** J1: a vertical pin header, round pads with drill holes. */
    private drawHeader(ctx: CanvasRenderingContext2D, n: number, labels: boolean, fs: number): void {
        if (n === 0) return;
        const padR = this.trace * 2.4;
        for (let i = 0; i < n; i++) {
            const y = this.jPinY[i];
            const c = this.chips[i];
            ctx.beginPath();
            ctx.arc(this.jX, y, padR, 0, Math.PI * 2);
            ctx.fillStyle = this.padCss;
            ctx.fill();
            if (c.flash > 0.02) {
                ctx.globalAlpha = c.flash;
                ctx.fillStyle = c.color;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            ctx.beginPath();
            ctx.arc(this.jX, y, padR * 0.45, 0, Math.PI * 2);
            ctx.fillStyle = this.holeCss;
            ctx.fill();
        }
        const top = this.jPinY[0] - padR * 2.2;
        const bottom = this.jPinY[n - 1] + padR * 2.2;
        ctx.strokeStyle = rampAt(this.silkRamp, 0.6);
        ctx.lineWidth = 1;
        ctx.strokeRect(this.jX - padR * 2, top, padR * 4, bottom - top);
        if (labels) drawLabel(ctx, 'J1 OUT', this.jX, top - fs, rampAt(this.silkRamp, 0.75), fs, 'center');
    }
}

export const neonCircuitDef: VizModeDef = {
    id: 'neon-circuit',
    name: 'NEON CIRCUIT',
    create: () => new NeonCircuitMode(),
};
