/**
 * NEON CIRCUIT — the pattern as a two-layer circuit board, seen in ISO CITY's
 * 2:1 dimetric projection and drawn in the flat PCB-viewer idiom (KiCad /
 * tscircuit): copper traces, vias with drill holes, silkscreen, and parts as
 * lit isometric packages standing on the board.
 *
 *   U0 SEQ          → the scheduler chip at the back; every note leaves here
 *   one part/track  → a row across the middle, its package chosen by what the
 *                     track plays: kick → QFP flat pack, snare → SOIC,
 *                     hat → SOT-23, bass notes → TO-220 power package,
 *                     other pitched parts → DIP, other percussion → crystal
 *   J1 OUT          → the output header at the front
 *   copper          → runs along the board's x on the top layer in the
 *                     track's accent, along y on the bottom layer, a via at
 *                     every layer change — so crossings are legal
 *   scheduled hap   → a pulse leaves SEQ ahead of time and reaches the part's
 *                     input pin exactly on the onset, flashing each via it
 *                     passes; the package lights and the signal carries on
 *                     to J1
 *   kick onsets     → the power rails along the board edges surge
 *   no pattern      → four idle parts (a clock crystal among them); FFT
 *                     transients and a slow clock tick send the pulses
 *
 * Parts are keyed by track name, so the board changes smoothly: a new track's
 * part rises out of the board and fades in, a removed one sinks and fades,
 * and the rest glide to their new rows with their traces following.
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
    TransientDetector, alphaRamp, clamp01, drawLabel, follow, lerpRgb, mixRgb, rampAt, rgbOf,
} from '../util.js';
import {currentBpm} from '../../bpm.js';

const MAX_LIVE = 8;
/** Live parts plus ones still fading out. */
const MAX_PARTS = 16;
/** Seconds a pulse takes from SEQ to its part — it launches this far ahead. */
const IN_SECONDS = 0.45;
/** Seconds from a part to the output header. */
const OUT_SECONDS = 0.35;
const MAX_PULSES = 64;
/** Points per route: pin → via → via → pin. */
const ROUTE_POINTS = 4;
const IDLE_CLOCK = 1.2;
/** Parts rise in / sink out at these rates (per second). */
const RISE = 3.5;
const SINK = 2.5;
/** Rows, pins and lanes glide to new positions at this rate. */
const GLIDE = 5;
/** Notes below this (MIDI) make a pitched track a bass part. */
const BASS_NOTE = 48;

// The virtual board every flat thing is laid out on (board units).
const BOARD_W = 1000;
const BOARD_H = 640;
/** Board-unit sizing scale for parts, traces and text. */
const UNIT = 1.3;
// ISO CITY's 2:1 dimetric ratios (36 : 18 : 22 px per unit).
const ISO_Y = 0.5;
const ISO_Z = 22 / 36;
const SEQ_Z = 30;
const J1_Z = 12;
/** Quantized flash levels for the cached package face colours. */
const FLASH_LEVELS = 8;

type RGB = readonly [number, number, number];
type Kind = 'qfp' | 'soic' | 'sot23' | 'to220' | 'dip' | 'xtal';

/**
 * Package shapes, in multiples of the row's base size: footprint, body
 * height, pins on the back (input) and front (output) sides and on the two
 * long sides, which pin carries the signal, and trim.
 */
interface PackageSpec {
    w: number;
    h: number;
    z: number;
    /** Pins along the back (x-min) and front (x-max) edges. */
    ends: number;
    /** Pins along the two y edges (quad packages). */
    sides: number;
    /** Input / output pin index along the back / front edge. */
    inPin: number;
    outPin: number;
    pinLen: number;
    pinZ: number;
    /** Metal can instead of epoxy. */
    metal: boolean;
    notch: boolean;
    /** Heat tab behind the back edge (TO-220). */
    tab: boolean;
}

const PACKAGES: Record<Kind, PackageSpec> = {
    qfp: {w: 1.5, h: 1.25, z: 0.55, ends: 4, sides: 4, inPin: 1, outPin: 2, pinLen: 0.14, pinZ: 0.18, metal: false, notch: false, tab: false},
    soic: {w: 2.5, h: 0.85, z: 0.6, ends: 4, sides: 0, inPin: 1, outPin: 2, pinLen: 0.16, pinZ: 0.2, metal: false, notch: false, tab: false},
    sot23: {w: 0.9, h: 0.55, z: 0.42, ends: 2, sides: 0, inPin: 0, outPin: 1, pinLen: 0.14, pinZ: 0.16, metal: false, notch: false, tab: false},
    to220: {w: 1.05, h: 1.0, z: 0.75, ends: 3, sides: 0, inPin: 1, outPin: 1, pinLen: 0.34, pinZ: 0.16, metal: false, notch: false, tab: true},
    dip: {w: 2.7, h: 0.95, z: 0.95, ends: 4, sides: 0, inPin: 1, outPin: 2, pinLen: 0.2, pinZ: 0.34, metal: false, notch: true, tab: false},
    xtal: {w: 1.35, h: 0.62, z: 0.6, ends: 2, sides: 0, inPin: 0, outPin: 1, pinLen: 0.14, pinZ: 0.16, metal: true, notch: false, tab: false},
};
/** Widest package footprint — sets the column the lanes route around. */
const MAX_W = Math.max(...Object.values(PACKAGES).map((p) => p.w + p.pinLen * 2));

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

interface Part {
    /** Track name, or `#idle:<n>` for the idle board. */
    key: string;
    label: string;
    kind: Kind;
    color: string;
    track: VizTrack | null;
    /** Still in the live set this frame; false while fading out. */
    alive: boolean;
    /** 0..1 — rises in, sinks out. */
    presence: number;
    /** Target row (0-based) and the gliding values that follow it. */
    rank: number;
    y: number;
    lane: number;
    seqPin: number;
    jPin: number;
    /** Footprint this frame (board units). */
    x: number;
    top: number;
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

/** The package that suits a track: by drum family, or by register if pitched. */
function kindFor(track: VizTrack): Kind {
    let low = Infinity;
    for (let e = 0; e < track.count; e++) {
        const n = track.notes[e];
        if (Number.isFinite(n) && n < low) low = n;
    }
    if (Number.isFinite(low)) return low < BASS_NOTE ? 'to220' : 'dip';
    switch (instrumentFamily(track.name)) {
        case 'kick': return 'qfp';
        case 'snare': return 'soic';
        case 'hat': return 'sot23';
        default: return 'xtal';
    }
}

const IDLE_PARTS: ReadonlyArray<{label: string; kind: Kind}> = [
    {label: 'CLK', kind: 'xtal'},
    {label: 'LOW', kind: 'qfp'},
    {label: 'MID', kind: 'soic'},
    {label: 'HIGH', kind: 'sot23'},
];

/** Ease out: parts decelerate as they finish rising. */
function easeOut(t: number): number {
    const k = 1 - clamp01(t);
    return 1 - k * k * k;
}

class NeonCircuitMode implements VizMode {
    /** Two bars, so a pulse can leave before the bar line for an early hap. */
    private readonly tracks = new TrackModel(2);
    private readonly transients = new TransientDetector(0.3, 0.35, 0.5);

    /** Every part on the board, live or fading; kept sorted back to front. */
    private readonly parts: Part[] = [];
    private readonly byKey = new Map<string, Part>();
    private liveCount = 0;
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

    // Board layout (board units); SEQ height and the row base size glide.
    private readonly trace = 3;
    private readonly seqX = BOARD_W * 0.08;
    private readonly seqW = Math.min(BOARD_W * 0.09, 70 * UNIT);
    private seqH = 4 * 30 * UNIT;
    private base = 56 * UNIT;
    private readonly jX = BOARD_W * 0.92;

    // Pulse pools; null = free. Idle pulses run inbound on their own clock,
    // outbound pulses run part → J1.
    private readonly iPart: (Part | null)[] = new Array<Part | null>(MAX_PULSES).fill(null);
    private readonly iT = new Float32Array(MAX_PULSES);
    private iNext = 0;
    private readonly oPart: (Part | null)[] = new Array<Part | null>(MAX_PULSES).fill(null);
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
    private tabFaces = emptyFaces();

    // Scratch for pointAt() / project().
    private px = 0;
    private py = 0;

    private readonly backToFront = (a: Part, b: Part): number => a.y - b.y;

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        if (!(s.width > 0 && s.height > 0)) return;
        // Fit the board's isometric diamond (plus package height) to the canvas.
        // The diamond may run slightly past the sides: its corners are bare board.
        const span = BOARD_W + BOARD_H;
        const kx = Math.min((s.width * 1.06) / span, (s.height * 0.9) / (span * ISO_Y + SEQ_Z * ISO_Z));
        this.kx = Math.max(0.05, kx);
        const cx = (BOARD_W - BOARD_H) / 2;
        const cy = span / 2;
        this.ox = s.width / 2 - cx * this.kx;
        this.oy = s.height / 2 - cy * this.kx * ISO_Y + (SEQ_Z * ISO_Z * this.kx) / 2;
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
        // SEQ, J1 and heat tabs are dark epoxy, black plastic and bare metal.
        this.seqFaces = this.facesFor(emptyFaces(), 'seq', t.textRgb, false, 0.35);
        this.j1Faces = this.facesFor(emptyFaces(), 'j1', t.borderRgb, false, 0.35);
        this.tabFaces = this.facesFor(emptyFaces(), 'tab', t.textRgb, true, 0.2);
        for (const p of this.parts) p.faces.key = '';
    }

    /**
     * ISO CITY's colour-mix face lighting for one package colour: dark sides,
     * a lighter top, all rising toward the accent as the package flashes.
     * Metal cans start from the theme's text grey instead of the background.
     */
    private facesFor(f: Faces, key: string, a: RGB, metal: boolean, tint = 1): Faces {
        if (f.key === key) return f;
        const t = this.theme!;
        f.key = key;
        f.top.length = f.left.length = f.right.length = 0;
        const top = metal ? mixRgb(t.textRgb, t.bgLighterRgb, 0.35) : t.bgLighterRgb;
        const side = metal ? mixRgb(t.textRgb, t.bgRgb, 0.55) : t.bgRgb;
        for (let i = 0; i < FLASH_LEVELS; i++) {
            const lit = i / (FLASH_LEVELS - 1);
            const base = metal ? 0.08 : 0.14;
            f.top.push(lerpRgb(top, a, (base + lit * 0.45) * tint));
            f.left.push(lerpRgb(side, a, (base * 0.5 + lit * 0.34) * tint));
            f.right.push(lerpRgb(top, a, (base * 1.4 + lit * 0.4) * tint));
        }
        f.stroke = lerpRgb(t.borderRgb, a, 0.45 * tint);
        return f;
    }

    private partFor(key: string, label: string, kind: Kind): Part {
        let p = this.byKey.get(key);
        if (p) return p;
        p = {
            key, label, kind, color: '', track: null, alive: true, presence: 0,
            rank: 0, y: NaN, lane: NaN, seqPin: NaN, jPin: NaN,
            x: 0, top: 0, w: 0, h: 0, in: newRoute(), out: newRoute(),
            flash: 0, viaIn: new Float32Array(2), viaOut: new Float32Array(2),
            faces: emptyFaces(),
        };
        this.byKey.set(key, p);
        this.parts.push(p);
        return p;
    }

    /**
     * Reconcile the live set (tracks while playing, idle parts otherwise),
     * then glide every part toward its row and rebuild its routes.
     */
    private syncParts(dt: number): void {
        for (const p of this.parts) p.alive = false;
        let n = 0;
        if (this.playing) {
            for (const tr of this.tracks.tracks) {
                if (n >= MAX_LIVE) break;
                if (tr.count === 0 && tr.activity <= 0.02) continue;
                const p = this.partFor(tr.name, tr.name.toUpperCase(), kindFor(tr));
                p.track = tr;
                p.color = tr.accentCss;
                this.facesFor(p.faces, p.color, tr.accent, PACKAGES[p.kind].metal);
                p.alive = true;
                p.rank = n++;
            }
        } else {
            for (let i = 0; i < IDLE_PARTS.length; i++) {
                const spec = IDLE_PARTS[i];
                const p = this.partFor(`#idle:${i}`, spec.label, spec.kind);
                p.track = null;
                p.color = this.idleCss[i];
                this.facesFor(p.faces, p.color, this.idleRgb[i], PACKAGES[p.kind].metal);
                p.alive = true;
                p.rank = n++;
            }
        }
        this.liveCount = n;
        // Rapid edits can churn parts faster than they fade: past the cap,
        // the most-faded leaving parts go at once.
        while (this.parts.length > MAX_PARTS) {
            let drop = -1;
            for (let k = 0; k < this.parts.length; k++) {
                const q = this.parts[k];
                if (!q.alive && (drop < 0 || q.presence < this.parts[drop].presence)) drop = k;
            }
            if (drop < 0) break;
            this.byKey.delete(this.parts[drop].key);
            this.parts.splice(drop, 1);
        }

        // Row geometry for the live count; SEQ and the base size glide to it.
        const rows = Math.max(1, n);
        const pitch = (BOARD_H * 0.84) / rows;
        this.base = follow(this.base, Math.min(pitch * 0.6, 44 * UNIT), dt, GLIDE, GLIDE);
        this.seqH = follow(this.seqH, Math.min(BOARD_H * 0.66, Math.max(n, 4) * 30 * UNIT), dt, GLIDE, GLIDE);
        const seqY = BOARD_H / 2 - this.seqH / 2;
        const rowsTop = BOARD_H * 0.08;
        const colW = MAX_W * this.base;
        const inLane0 = this.seqX + this.seqW + BOARD_W * 0.05;
        const inLane1 = BOARD_W * 0.5 - colW / 2 - BOARD_W * 0.04;
        const outLane0 = BOARD_W * 0.5 + colW / 2 + BOARD_W * 0.04;
        const outLane1 = this.jX - BOARD_W * 0.05;

        for (let k = this.parts.length - 1; k >= 0; k--) {
            const p = this.parts[k];
            p.presence = follow(p.presence, p.alive ? 1 : 0, dt, RISE, SINK);
            if (!p.alive && p.presence < 0.01) {
                this.parts.splice(k, 1);
                this.byKey.delete(p.key);
                continue;
            }
            if (p.alive) {
                // Targets for this part's row; a new part starts there.
                const ty = rowsTop + pitch * (p.rank + 0.5);
                const f = rows <= 1 ? 0.5 : p.rank / (rows - 1);
                const tLane = f;
                const tSeq = seqY + this.seqH * ((p.rank + 0.5) / rows);
                const tJ = BOARD_H / 2 + (tSeq - BOARD_H / 2) * 1.1;
                if (Number.isNaN(p.y)) {
                    p.y = ty; p.lane = tLane; p.seqPin = tSeq; p.jPin = tJ;
                }
                p.y = follow(p.y, ty, dt, GLIDE, GLIDE);
                p.lane = follow(p.lane, tLane, dt, GLIDE, GLIDE);
                p.seqPin = follow(p.seqPin, tSeq, dt, GLIDE, GLIDE);
                p.jPin = follow(p.jPin, tJ, dt, GLIDE, GLIDE);
            }
            const spec = PACKAGES[p.kind];
            p.w = spec.w * this.base;
            p.h = spec.h * this.base;
            p.x = BOARD_W * 0.5 - p.w / 2;
            p.top = p.y - p.h / 2;
            const inY = p.top + p.h * ((spec.inPin + 0.5) / spec.ends);
            const outY = p.top + p.h * ((spec.outPin + 0.5) / spec.ends);
            const inX = p.x - (spec.tab ? spec.pinLen * this.base : 0);
            setRoute(p.in, this.seqX + this.seqW, p.seqPin,
                inLane0 + (inLane1 - inLane0) * p.lane, inX, inY);
            setRoute(p.out, p.x + p.w, outY,
                outLane1 - (outLane1 - outLane0) * p.lane, this.jX, p.jPin);
        }
        this.parts.sort(this.backToFront);
    }

    private readonly onOnset = (track: VizTrack): void => {
        if (instrumentFamily(track.name) === 'kick') this.rail = 1;
        const p = this.byKey.get(track.name);
        if (!p || !p.alive) return;
        p.flash = 1;
        this.launchOut(p);
    };

    private launchOut(p: Part): void {
        const k = this.oNext;
        this.oNext = (k + 1) % MAX_PULSES;
        this.oPart[k] = p;
        this.oT[k] = 0;
    }

    private launchIdle(i: number): void {
        const p = this.byKey.get(`#idle:${i}`);
        if (!p) return;
        const k = this.iNext;
        this.iNext = (k + 1) % MAX_PULSES;
        this.iPart[k] = p;
        this.iT[k] = 0;
    }

    update(dt: number, s: VizServices): void {
        if (!(this.w > 0 && this.h > 0)) return;
        this.ensureTheme(s.theme);
        const sync: TrackSync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.playing = sync.pattern !== null;
        this.phase = sync.phase;
        this.bar = Math.floor(s.cycle);
        this.travel = Math.max(0.01, IN_SECONDS * currentBpm() / 240);
        this.syncParts(dt);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        const low = Number.isFinite(s.low) ? Math.max(0, s.low) : 0;
        const mid = Number.isFinite(s.mid) ? Math.max(0, s.mid) : 0;
        const high = Number.isFinite(s.high) ? Math.max(0, s.high) : 0;
        const hits = this.transients.update(dt, low, mid, high);
        if (!this.playing) {
            if (hits.kick) {
                this.launchIdle(1);
                this.rail = Math.max(this.rail, 0.6);
            }
            if (hits.snare) this.launchIdle(2);
            if (hits.hat) this.launchIdle(3);
            this.idleTimer += dt;
            if (this.idleTimer >= IDLE_CLOCK) {
                this.idleTimer = 0;
                this.launchIdle(0);
            }
        } else {
            this.idleTimer = 0;
        }

        const fk = Math.exp(-dt * 5);
        const vk = Math.exp(-dt * 6);
        for (const p of this.parts) {
            p.flash *= fk;
            p.viaIn[0] *= vk; p.viaIn[1] *= vk;
            p.viaOut[0] *= vk; p.viaOut[1] *= vk;
        }
        this.rail *= Math.exp(-dt * 3.5);

        // Idle inbound pulses run on time; arriving fires the part.
        for (let k = 0; k < MAX_PULSES; k++) {
            const p = this.iPart[k];
            if (!p) continue;
            const t = this.iT[k] + dt / IN_SECONDS;
            if (t >= 1 || !p.alive) {
                this.iPart[k] = null;
                if (t >= 1 && p.alive) {
                    p.flash = 1;
                    this.launchOut(p);
                }
                continue;
            }
            this.iT[k] = t;
            this.touchVias(p.in, p.viaIn, t);
        }
        for (let k = 0; k < MAX_PULSES; k++) {
            const p = this.oPart[k];
            if (!p) continue;
            const t = this.oT[k] + dt / OUT_SECONDS;
            if (t >= 1 || p.presence < 0.05) { this.oPart[k] = null; continue; }
            this.oT[k] = t;
            this.touchVias(p.out, p.viaOut, t);
        }

        // Scheduled inbound pulses: stateless, placed by the time left to the onset.
        if (this.playing) {
            for (const p of this.parts) {
                const tr = p.track;
                if (!tr || !p.alive) continue;
                for (let e = 0; e < tr.count; e++) {
                    const left = tr.begins[e] - this.phase;
                    if (left > 0 && left <= this.travel) this.touchVias(p.in, p.viaIn, 1 - left / this.travel);
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
        if (!(this.w > 0 && this.h > 0) || !this.theme) return;
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
        this.drawBoardPlane(ctx, labels);
        ctx.restore();

        // Packages, back to front: SEQ is furthest back, then the parts by
        // row, then J1 at the front.
        ctx.save();
        ctx.lineJoin = 'miter';
        const n = Math.max(1, this.liveCount);
        const seqY = BOARD_H / 2 - this.seqH / 2;
        this.drawPackage(ctx, this.seqX, seqY, this.seqW, this.seqH, SEQ_Z, this.seqFaces, 0,
            'SEQ', 'U0', n, 0, 7 * UNIT, 6, false, false, false, null, labels);
        for (let i = 0; i < this.parts.length; i++) {
            const p = this.parts[i];
            const spec = PACKAGES[p.kind];
            const rise = easeOut(p.presence);
            ctx.globalAlpha = clamp01(p.presence * 1.4);
            this.drawPackage(ctx, p.x, p.top, p.w, p.h, spec.z * this.base * rise, p.faces, p.flash,
                p.label, `U${p.rank + 1}`, spec.ends, spec.sides, spec.pinLen * this.base,
                spec.pinZ * this.base * rise, spec.notch, spec.tab, spec.metal, p, labels);
        }
        ctx.globalAlpha = 1;
        this.drawHeader(ctx, labels);
        ctx.restore();
    }

    private drawBoardPlane(ctx: CanvasRenderingContext2D, labels: boolean): void {
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

        // Power rails along the long edges, stubs to SEQ.
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
        const seqY = BOARD_H / 2 - this.seqH / 2;
        ctx.moveTo(seqMid, railA);
        ctx.lineTo(seqMid, seqY);
        ctx.moveTo(seqMid, seqY + this.seqH);
        ctx.lineTo(seqMid, railB);
        ctx.stroke();

        // Copper, per part, faded with its presence. Bottom layer first.
        ctx.lineWidth = tr;
        for (const p of this.parts) {
            if (!p.in.vias && !p.out.vias) continue;
            ctx.globalAlpha = p.presence;
            ctx.strokeStyle = rampAt(this.bottomRamp, 0.75);
            ctx.beginPath();
            if (p.in.vias) this.leg(ctx, p.in, 1);
            if (p.out.vias) this.leg(ctx, p.out, 1);
            ctx.stroke();
        }
        for (const p of this.parts) {
            ctx.strokeStyle = p.color;
            ctx.globalAlpha = (0.34 + p.flash * 0.3) * p.presence;
            ctx.beginPath();
            this.leg(ctx, p.in, 0);
            this.leg(ctx, p.in, 2);
            this.leg(ctx, p.out, 0);
            this.leg(ctx, p.out, 2);
            if (!p.in.vias) this.leg(ctx, p.in, 1);
            if (!p.out.vias) this.leg(ctx, p.out, 1);
            ctx.stroke();
        }

        // Vias: annular ring, drill hole, the track's colour while a pulse passes.
        for (const p of this.parts) {
            ctx.globalAlpha = p.presence;
            this.drawVias(ctx, p.in, p.viaIn, p.color);
            this.drawVias(ctx, p.out, p.viaOut, p.color);
        }

        // Pulses.
        if (this.playing) {
            for (const p of this.parts) {
                const track = p.track;
                if (!track || !p.alive) continue;
                ctx.globalAlpha = p.presence;
                for (let e = 0; e < track.count; e++) {
                    const left = track.begins[e] - this.phase;
                    if (left > 0 && left <= this.travel) this.drawPulse(ctx, p.in, 1 - left / this.travel, p.color);
                }
            }
        }
        for (let k = 0; k < MAX_PULSES; k++) {
            const pi = this.iPart[k];
            if (pi) {
                ctx.globalAlpha = pi.presence;
                this.drawPulse(ctx, pi.in, this.iT[k], pi.color);
            }
            const po = this.oPart[k];
            if (po) {
                ctx.globalAlpha = po.presence;
                this.drawPulse(ctx, po.out, this.oT[k], po.color);
            }
        }
        ctx.globalAlpha = 1;

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
        const alpha = ctx.globalAlpha;
        for (let v = 0; v < 2; v++) {
            const x = r.xs[v + 1];
            const y = r.ys[v + 1];
            ctx.beginPath();
            ctx.arc(x, y, viaR, 0, Math.PI * 2);
            ctx.fillStyle = this.padCss;
            ctx.fill();
            if (glow[v] > 0.02) {
                ctx.globalAlpha = alpha * clamp01(glow[v]);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.globalAlpha = alpha;
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
        if (z1 - z0 > 0.2) {
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
        }
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
     * A package: pins behind the body first (back edge, back quad side), the
     * lit body, then pins in front; a heat tab or notch where the package has
     * one; reference, name and pin-1 dot engraved on the top face, or
     * silkscreened beside a part too small to carry them.
     */
    private drawPackage(
        ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, z: number,
        faces: Faces, flash: number, name: string, ref: string, ends: number, sides: number,
        pinLen: number, pinZ: number, notch: boolean, tab: boolean, metal: boolean,
        part: Part | null, labels: boolean,
    ): void {
        const lvl = Math.min(FLASH_LEVELS - 1, Math.round(clamp01(flash) * (FLASH_LEVELS - 1)));
        const pinW = Math.max(3, Math.min(h / (ends * 2.2), 7 * UNIT));
        const pinSide = faces.left[0];
        const liveIn = part ? part.in.ys[3] : NaN;
        const liveOut = part ? part.out.ys[0] : NaN;
        const pinColor = (py: number, live: number): string =>
            part !== null && Math.abs(py - live) < 0.5 ? part.color : this.padCss;

        if (tab) {
            // TO-220 heat tab: a metal plate behind the body with a mounting hole.
            const f = this.tabFaces;
            this.box(ctx, x - pinLen, y + h * 0.08, pinLen, h * 0.84, 0, Math.max(0.5, pinZ * 0.7),
                f.top[0], f.left[0], f.right[0], f.stroke);
            ctx.save();
            this.enterPlane(ctx, Math.max(0.5, pinZ * 0.7));
            ctx.beginPath();
            ctx.arc(x - pinLen * 0.5, y + h / 2, Math.min(pinLen, h) * 0.22, 0, Math.PI * 2);
            ctx.fillStyle = this.holeCss;
            ctx.fill();
            ctx.restore();
        } else {
            for (let p = 0; p < ends; p++) {
                const py = y + h * ((p + 0.5) / ends);
                const c = pinColor(py, liveIn);
                this.box(ctx, x - pinLen, py - pinW / 2, pinLen, pinW, 0, pinZ, c, pinSide, c, faces.stroke);
            }
        }
        for (let p = 0; p < sides; p++) {
            const px = x + w * ((p + 0.5) / sides);
            this.box(ctx, px - pinW / 2, y - pinLen, pinW, pinLen, 0, pinZ,
                this.padCss, pinSide, this.padCss, faces.stroke);
        }

        this.box(ctx, x, y, w, h, 0, z, faces.top[lvl], faces.left[lvl], faces.right[lvl], faces.stroke);

        for (let p = 0; p < sides; p++) {
            const px = x + w * ((p + 0.5) / sides);
            this.box(ctx, px - pinW / 2, y + h, pinW, pinLen, 0, pinZ,
                this.padCss, pinSide, this.padCss, faces.stroke);
        }
        for (let p = 0; p < ends; p++) {
            const py = y + h * ((p + 0.5) / ends);
            const c = pinColor(py, liveOut);
            this.box(ctx, x + w, py - pinW / 2, pinLen, pinW, 0, pinZ, c, pinSide, c, faces.stroke);
        }

        // Engraving on the top face.
        ctx.save();
        this.enterPlane(ctx, z);
        if (notch) {
            ctx.beginPath();
            ctx.arc(x, y + h / 2, h * 0.14, -Math.PI / 2, Math.PI / 2);
            ctx.fillStyle = faces.left[lvl];
            ctx.fill();
        }
        if (!metal) {
            const dotR = Math.min(3.2 * UNIT, h * 0.08);
            ctx.beginPath();
            ctx.arc(x + dotR * 2.4, y + dotR * 2.4, dotR, 0, Math.PI * 2);
            ctx.fillStyle = rampAt(this.silkRamp, 0.6);
            ctx.fill();
        }
        const fs = Math.min(15, h * 0.3);
        const maxChars = Math.floor((w - 10) / (fs * 0.62));
        const engrave = labels && maxChars >= 3;
        if (engrave) {
            const text = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name;
            drawLabel(ctx, text, x + w / 2, y + h * 0.56, rampAt(this.silkRamp, 0.62 + flash * 0.38), fs, 'center');
            if (maxChars >= 6) drawLabel(ctx, ref, x + w - 6, y + fs * 0.75, rampAt(this.silkRamp, 0.5), fs * 0.75, 'right');
        }
        ctx.restore();
        if (labels && !engrave) {
            // Too small to engrave: silkscreen the name on the board in front.
            ctx.save();
            this.enterPlane(ctx, 0);
            drawLabel(ctx, name, x + w / 2, y + h + pinLen + 14, rampAt(this.silkRamp, 0.6 + flash * 0.4), 12, 'center');
            ctx.restore();
        }
    }

    /** J1: a black plastic header with a pin standing in each hole. */
    private drawHeader(ctx: CanvasRenderingContext2D, labels: boolean): void {
        const pins = this.parts;
        if (pins.length === 0) return;
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of pins) {
            if (p.jPin < lo) lo = p.jPin;
            if (p.jPin > hi) hi = p.jPin;
        }
        const hw = 26 * UNIT;
        const top = lo - hw / 2 - 4;
        const len = hi - lo + hw + 8;
        const f = this.j1Faces;
        this.box(ctx, this.jX - hw / 2, top, hw, len, 0, J1_Z, f.top[0], f.left[0], f.right[0], f.stroke);
        const pin = hw * 0.26;
        for (const p of pins) {
            const col = p.flash > 0.08 ? p.color : this.padCss;
            ctx.globalAlpha = p.presence;
            this.box(ctx, this.jX - pin / 2, p.jPin - pin / 2, pin, pin, J1_Z, J1_Z + 10 * easeOut(p.presence),
                col, f.left[0], col, f.stroke);
        }
        ctx.globalAlpha = 1;
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
