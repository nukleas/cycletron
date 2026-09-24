/**
 * NEON CIRCUIT — the pattern as a two-layer circuit board, seen in ISO CITY's
 * 2:1 dimetric projection and drawn in the flat PCB-viewer idiom (KiCad /
 * tscircuit): copper traces, vias with drill holes, silkscreen, and chips as
 * lit isometric packages standing on the board.
 *
 *   U0 SEQ          → the scheduler chip at the back; every note leaves here
 *   U1…U8           → one IC package per track, a row across the middle,
 *                     reference and name engraved on its top face
 *   J1 OUT          → the output header at the front
 *   copper          → runs along the board's x on the top layer in the
 *                     track's accent, along y on the bottom layer, a via at
 *                     every layer change — so crossings are legal
 *   scheduled hap   → a pulse leaves SEQ ahead of time and reaches the IC's
 *                     input pin exactly on the onset, flashing each via it
 *                     passes; the package lights and the signal carries on
 *                     to J1
 *   kick onsets     → the power rails along the board edges surge
 *   no pattern      → four idle ICs; FFT transients and a slow clock tick
 *                     send the pulses
 *
 * Everything flat is laid out on a fixed virtual board and drawn through one
 * isometric canvas transform; packages are extruded boxes lit like ISO CITY's
 * buildings, drawn back to front. Incoming pulses are stateless — placed by
 * the time left until the hap, read two bars ahead — so they can't drift
 * from the schedule. Outgoing pulses live in fixed pools.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel, instrumentFamily, type TrackSync, type VizTrack} from '../tracks.js';
import {
    TransientDetector, alphaRamp, clamp01, drawLabel, lerpRgb, mixRgb, rampAt, rgbOf,
} from '../util.js';
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

// The virtual board every flat thing is laid out on (board units).
const BOARD_W = 1000;
const BOARD_H = 640;
/** Board-unit sizing scale for parts, traces and text. */
const UNIT = 1.3;
// ISO CITY's 2:1 dimetric ratios (36 : 18 : 22 px per unit).
const ISO_Y = 0.5;
const ISO_Z = 22 / 36;
// Package heights (board units).
const IC_Z = 26;
const SEQ_Z = 30;
const J1_Z = 12;
const PIN_Z = 7;
/** Quantized flash levels for the cached package face colours. */
const FLASH_LEVELS = 8;

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

/** Lit face colours for one package colour, by flash level. */
interface Faces {
    key: string;
    top: string[];
    left: string[];
    right: string[];
    stroke: string;
}

interface Chip {
    name: string;
    color: string;
    rgb: RGB;
    track: VizTrack | null;
    /** Footprint on the board (board units). */
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
    faces: Faces;
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

/** Pin → turn → turn → pin, with the middle leg on the bottom layer. */
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

function emptyFaces(): Faces {
    return {key: '', top: [], left: [], right: [], stroke: ''};
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

    // Projection: board (x, y, z) → screen.
    private w = 0;
    private h = 0;
    private kx = 1;
    private ox = 0;
    private oy = 0;

    // Board layout (board units).
    private readonly trace = 3;
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
    private boardSideCss = '';
    private edgeCss = '';
    private gridCss = '';
    private padCss = '';
    private holeCss = '';
    private silkRamp: string[] = [];
    private bottomRamp: string[] = [];
    private railRamp: string[] = [];
    private readonly idleRgb: RGB[] = [];
    private readonly idleCss: string[] = [];
    private seqFaces = emptyFaces();
    private j1Faces = emptyFaces();

    // Scratch for pointAt() / project().
    private px = 0;
    private py = 0;

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (!(s.width > 0 && s.height > 0)) return;
        // Fit the board's isometric diamond (plus package height) to the canvas.
        const span = BOARD_W + BOARD_H;
        // The diamond may run slightly past the sides: its corners are bare board.
        const kx = Math.min((s.width * 1.06) / span, (s.height * 0.9) / (span * ISO_Y + SEQ_Z * ISO_Z));
        this.kx = Math.max(0.05, kx);
        const cx = (BOARD_W - BOARD_H) / 2;
        const cy = span / 2;
        this.ox = s.width / 2 - cx * this.kx;
        this.oy = s.height / 2 - cy * this.kx * ISO_Y + (SEQ_Z * ISO_Z * this.kx) / 2;
        if (this.chipCount < 0) return;
        this.placeChips(this.chipCount);
    }

    private ensureTheme(t: Theme): void {
        if (t === this.theme) return;
        this.theme = t;
        const neon = rgbOf(t.neon, [71, 246, 255]);
        const css = (c: RGB): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
        const board = mixRgb(t.bgRgb, t.bgLightRgb, 0.7);
        this.boardCss = css(board);
        this.boardSideCss = css(mixRgb(t.bgRgb, board, 0.4));
        this.edgeCss = `rgba(${t.borderRgb[0]}, ${t.borderRgb[1]}, ${t.borderRgb[2]}, 0.9)`;
        this.gridCss = `rgba(${t.borderRgb[0]}, ${t.borderRgb[1]}, ${t.borderRgb[2]}, 0.35)`;
        this.padCss = css(mixRgb(t.textRgb, t.bgRgb, 0.35));
        this.holeCss = t.bg;
        // Silkscreen leans toward the theme's yellow, as on a real board.
        this.silkRamp = alphaRamp(mixRgb(t.textRgb, rgbOf(t.active, [247, 255, 90]), 0.35), 24);
        this.bottomRamp = alphaRamp(mixRgb(t.borderRgb, neon, 0.35), 24);
        this.railRamp = alphaRamp(neon, 24);
        const pool = t.accentPool;
        this.idleRgb.length = 0;
        this.idleCss.length = 0;
        for (const c of [pool[0], pool[1], pool[3], pool[4]]) {
            this.idleRgb.push(c);
            this.idleCss.push(css(c));
        }
        // SEQ and J1 are dark epoxy / black plastic, barely tinted.
        this.seqFaces = this.facesFor(emptyFaces(), 'seq', t.textRgb, 0.35);
        this.j1Faces = this.facesFor(emptyFaces(), 'j1', t.borderRgb, 0.35);
        for (const c of this.chips) c.faces.key = '';
    }

    /**
     * ISO CITY's colour-mix face lighting for one package colour: dark sides,
     * a lighter top, all rising toward the accent as the package flashes.
     */
    private facesFor(f: Faces, key: string, a: RGB, tint = 1): Faces {
        if (f.key === key) return f;
        const t = this.theme!;
        f.key = key;
        f.top.length = f.left.length = f.right.length = 0;
        for (let i = 0; i < FLASH_LEVELS; i++) {
            const lit = i / (FLASH_LEVELS - 1);
            f.top.push(lerpRgb(t.bgLighterRgb, a, (0.14 + lit * 0.45) * tint));
            f.left.push(lerpRgb(t.bgRgb, a, (0.06 + lit * 0.34) * tint));
            f.right.push(lerpRgb(t.bgLighterRgb, a, (0.2 + lit * 0.4) * tint));
        }
        f.stroke = lerpRgb(t.borderRgb, a, 0.45 * tint);
        return f;
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
                c.rgb = live[i].accent;
            } else {
                c.track = null;
                c.name = IDLE_NAMES[i];
                c.color = this.idleCss[i];
                c.rgb = this.idleRgb[i];
            }
            this.facesFor(c.faces, c.color, c.rgb);
        }
    }

    /** Lay the board out for `n` chips: SEQ at the back, ICs across, J1 in front. */
    private placeChips(n: number): void {
        this.chipCount = n;
        while (this.chips.length < n) {
            this.chips.push({
                name: '', color: '', rgb: [0, 0, 0], track: null,
                x: 0, y: 0, w: 0, h: 0, in: newRoute(), out: newRoute(),
                flash: 0, viaIn: new Float32Array(2), viaOut: new Float32Array(2),
                faces: emptyFaces(),
            });
        }
        const bw = BOARD_W;
        const bh = BOARD_H;
        const midY = bh / 2;
        const u = UNIT;

        // SEQ: a long chip near the back edge, one output pin per track.
        this.seqW = Math.min(bw * 0.09, 70 * u);
        this.seqH = Math.min(bh * 0.66, Math.max(n, 4) * 30 * u);
        this.seqX = bw * 0.08;
        this.seqY = midY - this.seqH / 2;
        // J1: a pin header near the front edge.
        this.jX = bw - bw * 0.08;
        // SEQ output pins sit exactly on its pads (drawPackage spaces them the same).
        for (let i = 0; i < n; i++) {
            this.seqPinY[i] = this.seqY + this.seqH * ((i + 0.5) / n);
            this.jPinY[i] = midY + (this.seqPinY[i] - midY) * 1.1;
        }

        // The IC row, with each track's own lane on both sides.
        const rowsTop = bh * 0.08;
        const pitch = (bh * 0.84) / Math.max(1, n);
        const icW = Math.min(bw * 0.13, 110 * u);
        const icH = Math.min(pitch * 0.62, 56 * u);
        const icX = bw * 0.5 - icW / 2;
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
            // Input on the IC's second pin along the back side, output on the
            // third along the front side (of IC_PINS per side).
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
        const reach = 14 * UNIT;
        for (let v = 0; v < 2; v++) {
            const near = 1 - Math.abs(d - r.cum[v + 1]) / reach;
            if (near > glow[v]) glow[v] = near;
        }
    }

    /** Point at distance `d` along a route → this.px / this.py (board units). */
    private pointAt(r: Route, d: number): void {
        let i = 1;
        while (i < ROUTE_POINTS - 1 && r.cum[i] < d) i++;
        const seg = r.cum[i] - r.cum[i - 1];
        const f = seg > 0 ? clamp01((d - r.cum[i - 1]) / seg) : 0;
        this.px = r.xs[i - 1] + (r.xs[i] - r.xs[i - 1]) * f;
        this.py = r.ys[i - 1] + (r.ys[i] - r.ys[i - 1]) * f;
    }

    /** Board point (x, y, z) → screen, into this.px / this.py. */
    private project(x: number, y: number, z: number): void {
        this.px = this.ox + (x - y) * this.kx;
        this.py = this.oy + (x + y) * this.kx * ISO_Y - z * this.kx * ISO_Z;
    }

    /** Put the canvas into the board plane at height z (board units in, screen out). */
    private enterPlane(ctx: CanvasRenderingContext2D, z: number): void {
        const k = this.kx;
        ctx.translate(0, -z * k * ISO_Z);
        ctx.transform(k, k * ISO_Y, -k, k * ISO_Y, this.ox, this.oy);
    }

    /** A bright run of copper ending at progress `t`, with a square head (board plane). */
    private drawPulse(ctx: CanvasRenderingContext2D, r: Route, t: number, color: string): void {
        const d = t * r.length;
        const tail = Math.min(d, 34 * UNIT);
        ctx.strokeStyle = color;
        ctx.lineWidth = this.trace * 1.5;
        ctx.beginPath();
        this.pointAt(r, d - tail);
        ctx.moveTo(this.px, this.py);
        for (let i = 1; i < ROUTE_POINTS - 1; i++) {
            if (r.cum[i] > d - tail && r.cum[i] < d) ctx.lineTo(r.xs[i], r.ys[i]);
        }
        this.pointAt(r, d);
        ctx.lineTo(this.px, this.py);
        ctx.stroke();
        const hs = this.trace * 2.6;
        ctx.fillStyle = color;
        ctx.fillRect(this.px - hs / 2, this.py - hs / 2, hs, hs);
    }

    private leg(ctx: CanvasRenderingContext2D, r: Route, from: number): void {
        ctx.moveTo(r.xs[from], r.ys[from]);
        ctx.lineTo(r.xs[from + 1], r.ys[from + 1]);
    }

    render(ctx: CanvasRenderingContext2D, _s: VizServices): void {
        if (!(this.w > 0 && this.h > 0) || this.chipCount < 0) return;
        const n = this.chipCount;
        const labels = this.w >= 360 && this.h >= 240;

        // Board thickness first: the two front edges of the slab.
        const thick = 8;
        ctx.save();
        ctx.fillStyle = this.boardSideCss;
        ctx.beginPath();
        this.project(0, BOARD_H, 0); ctx.moveTo(this.px, this.py);
        this.project(BOARD_W, BOARD_H, 0); ctx.lineTo(this.px, this.py);
        this.project(BOARD_W, 0, 0); ctx.lineTo(this.px, this.py);
        this.project(BOARD_W, 0, -thick); ctx.lineTo(this.px, this.py);
        this.project(BOARD_W, BOARD_H, -thick); ctx.lineTo(this.px, this.py);
        this.project(0, BOARD_H, -thick); ctx.lineTo(this.px, this.py);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Everything flat, drawn in the board plane.
        ctx.save();
        this.enterPlane(ctx, 0);
        this.drawBoardPlane(ctx, n, labels);
        ctx.restore();

        // Packages, back to front: SEQ is furthest back, then the ICs in
        // order, then J1 at the front.
        ctx.save();
        ctx.lineJoin = 'miter';
        this.drawPackage(ctx, this.seqX, this.seqY, this.seqW, this.seqH, SEQ_Z,
            this.seqFaces, 0, 'U0', 'SEQ', Math.max(1, n), null, labels);
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            this.drawPackage(ctx, c.x, c.y, c.w, c.h, IC_Z, c.faces, c.flash,
                `U${i + 1}`, c.name.toUpperCase(), IC_PINS, c, labels);
        }
        this.drawHeader(ctx, n, labels);
        ctx.restore();
    }

    private drawBoardPlane(ctx: CanvasRenderingContext2D, n: number, labels: boolean): void {
        const tr = this.trace;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Board: fill, edge cuts, a sparse dot grid.
        ctx.beginPath();
        ctx.rect(0, 0, BOARD_W, BOARD_H);
        ctx.fillStyle = this.boardCss;
        ctx.fill();
        ctx.strokeStyle = this.edgeCss;
        ctx.lineWidth = 2;
        ctx.stroke();
        const step = 32;
        ctx.fillStyle = this.gridCss;
        ctx.beginPath();
        for (let y = step; y < BOARD_H - step * 0.5; y += step) {
            for (let x = step; x < BOARD_W - step * 0.5; x += step) ctx.rect(x - 1, y - 1, 2.4, 2.4);
        }
        ctx.fill();

        // Power rails along the long edges, stubs to SEQ and the end ICs.
        const inset = step * 0.6;
        const railA = inset;
        const railB = BOARD_H - inset;
        ctx.strokeStyle = rampAt(this.railRamp, 0.22 + this.rail * 0.6);
        ctx.lineWidth = tr * (1.8 + this.rail * 0.8);
        ctx.beginPath();
        ctx.moveTo(inset, railA);
        ctx.lineTo(BOARD_W - inset, railA);
        ctx.moveTo(inset, railB);
        ctx.lineTo(BOARD_W - inset, railB);
        ctx.stroke();
        ctx.strokeStyle = rampAt(this.railRamp, 0.16 + this.rail * 0.4);
        ctx.lineWidth = tr;
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

        // Bottom-layer copper: every middle leg, one batched path.
        ctx.strokeStyle = rampAt(this.bottomRamp, 0.75);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            if (c.in.vias) this.leg(ctx, c.in, 1);
            if (c.out.vias) this.leg(ctx, c.out, 1);
        }
        ctx.stroke();

        // Top-layer copper in the chip's colour.
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            ctx.strokeStyle = c.color;
            ctx.globalAlpha = 0.34 + c.flash * 0.3;
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
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            this.drawVias(ctx, c.in, c.viaIn, c.color);
            this.drawVias(ctx, c.out, c.viaOut, c.color);
        }

        // Pulses.
        if (this.playing) {
            for (let i = 0; i < n; i++) {
                const c = this.chips[i];
                const track = c.track!;
                for (let e = 0; e < track.count; e++) {
                    const left = track.begins[e] - this.phase;
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

        // Silkscreen along the front edge.
        if (labels) {
            const status = this.playing ? `BAR ${this.bar + 1}` : 'STANDBY';
            drawLabel(ctx, `CYCLETRON  REV A  ·  ${status}`, step, railB - 16,
                rampAt(this.silkRamp, 0.5), 14);
        }
    }

    private drawVias(ctx: CanvasRenderingContext2D, r: Route, glow: Float32Array, color: string): void {
        if (!r.vias) return;
        const viaR = this.trace * 2.2;
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
            ctx.arc(x, y, viaR * 0.42, 0, Math.PI * 2);
            ctx.fillStyle = this.holeCss;
            ctx.fill();
        }
    }

    /**
     * An extruded box standing on the board: the two visible sides (front of
     * the y edge, front of the x edge) and the top, ISO CITY's drawBox.
     */
    private box(
        ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, z0: number, z1: number,
        top: string, left: string, right: string, stroke: string,
    ): void {
        ctx.lineWidth = 1;
        ctx.strokeStyle = stroke;
        // Face along the y = y + h edge.
        ctx.beginPath();
        this.project(x, y + h, z1); ctx.moveTo(this.px, this.py);
        this.project(x + w, y + h, z1); ctx.lineTo(this.px, this.py);
        this.project(x + w, y + h, z0); ctx.lineTo(this.px, this.py);
        this.project(x, y + h, z0); ctx.lineTo(this.px, this.py);
        ctx.closePath();
        ctx.fillStyle = left;
        ctx.fill();
        ctx.stroke();
        // Face along the x = x + w edge.
        ctx.beginPath();
        this.project(x + w, y, z1); ctx.moveTo(this.px, this.py);
        this.project(x + w, y + h, z1); ctx.lineTo(this.px, this.py);
        this.project(x + w, y + h, z0); ctx.lineTo(this.px, this.py);
        this.project(x + w, y, z0); ctx.lineTo(this.px, this.py);
        ctx.closePath();
        ctx.fillStyle = right;
        ctx.fill();
        ctx.stroke();
        // Top.
        ctx.beginPath();
        this.project(x, y, z1); ctx.moveTo(this.px, this.py);
        this.project(x + w, y, z1); ctx.lineTo(this.px, this.py);
        this.project(x + w, y + h, z1); ctx.lineTo(this.px, this.py);
        this.project(x, y + h, z1); ctx.lineTo(this.px, this.py);
        ctx.closePath();
        ctx.fillStyle = top;
        ctx.fill();
        ctx.stroke();
    }

    /**
     * An IC package: gull-wing pins along both long sides (the back row drawn
     * before the body, the front row after), the lit body, and reference,
     * name and pin-1 dot engraved on the top face.
     */
    private drawPackage(
        ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, z: number,
        faces: Faces, flash: number, ref: string, value: string, pinsPerSide: number,
        chip: Chip | null, labels: boolean,
    ): void {
        const lvl = Math.min(FLASH_LEVELS - 1, Math.round(clamp01(flash) * (FLASH_LEVELS - 1)));
        const pinLen = 7 * UNIT;
        const pinW = Math.max(3, Math.min(h / (pinsPerSide * 2.2), 7 * UNIT));
        const pinTop = this.padCss;
        const pinSide = faces.left[0];
        const liveIn = chip ? chip.in.ys[3] : NaN;
        const liveOut = chip ? chip.out.ys[0] : NaN;

        // Pins on the back side (x - pinLen … x): behind the body.
        for (let p = 0; p < pinsPerSide; p++) {
            const py = y + h * ((p + 0.5) / pinsPerSide);
            const live = chip !== null && Math.abs(py - liveIn) < 0.5;
            const c = live ? chip.color : pinTop;
            this.box(ctx, x - pinLen, py - pinW / 2, pinLen, pinW, 0, PIN_Z, c, pinSide, c, faces.stroke);
        }
        this.box(ctx, x, y, w, h, 0, z, faces.top[lvl], faces.left[lvl], faces.right[lvl], faces.stroke);
        // Pins on the front side (x + w … x + w + pinLen): in front of the body.
        for (let p = 0; p < pinsPerSide; p++) {
            const py = y + h * ((p + 0.5) / pinsPerSide);
            const live = chip !== null && Math.abs(py - liveOut) < 0.5;
            const c = live ? chip.color : pinTop;
            this.box(ctx, x + w, py - pinW / 2, pinLen, pinW, 0, PIN_Z, c, pinSide, c, faces.stroke);
        }

        // Engraving on the top face.
        ctx.save();
        this.enterPlane(ctx, z);
        const dotR = 3.2 * UNIT;
        ctx.beginPath();
        ctx.arc(x + dotR * 2.4, y + dotR * 2.4, dotR, 0, Math.PI * 2);
        ctx.fillStyle = rampAt(this.silkRamp, 0.6);
        ctx.fill();
        if (labels) {
            const fs = Math.min(15, h * 0.3);
            const maxChars = Math.max(2, Math.floor((w - 10) / (fs * 0.62)));
            const text = value.length > maxChars ? value.slice(0, maxChars - 1) + '…' : value;
            drawLabel(ctx, text, x + w / 2, y + h * 0.56, rampAt(this.silkRamp, 0.62 + flash * 0.38), fs, 'center');
            drawLabel(ctx, ref, x + w - 6, y + fs * 0.75, rampAt(this.silkRamp, 0.5), fs * 0.75, 'right');
        }
        ctx.restore();
    }

    /** J1: a black plastic header with a pin standing in each hole. */
    private drawHeader(ctx: CanvasRenderingContext2D, n: number, labels: boolean): void {
        if (n === 0) return;
        const pitch = n > 1 ? this.jPinY[1] - this.jPinY[0] : 30;
        const hw = Math.min(26 * UNIT, pitch * 0.9);
        const top = this.jPinY[0] - hw / 2 - 4;
        const len = this.jPinY[n - 1] - this.jPinY[0] + hw + 8;
        const f = this.j1Faces;
        this.box(ctx, this.jX - hw / 2, top, hw, len, 0, J1_Z, f.top[0], f.left[0], f.right[0], f.stroke);
        const pin = hw * 0.26;
        for (let i = 0; i < n; i++) {
            const c = this.chips[i];
            const lit = c.flash > 0.08;
            const col = lit ? c.color : this.padCss;
            this.box(ctx, this.jX - pin / 2, this.jPinY[i] - pin / 2, pin, pin, J1_Z, J1_Z + 10,
                col, this.j1Faces.left[0], col, f.stroke);
        }
        if (labels) {
            ctx.save();
            this.enterPlane(ctx, 0);
            drawLabel(ctx, 'J1 OUT', this.jX, top - 14, rampAt(this.silkRamp, 0.7), 14, 'center');
            ctx.restore();
        }
    }
}

export const neonCircuitDef: VizModeDef = {
    id: 'neon-circuit',
    name: 'NEON CIRCUIT',
    create: () => new NeonCircuitMode(),
};
