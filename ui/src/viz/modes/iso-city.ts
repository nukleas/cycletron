/**
 * ISO CITY — isometric city of sounds. 2:1 dimetric projection ported from
 * cyberdesign iso.js (TILE 72×36, 22px/z). Each track (= sound name) owns a
 * district pad on a spiral plot grid; each hap in the current bar is a
 * building on that pad, flashing as the playhead crosses its onset.
 *
 * Traffic follows the schedule too: kick-district onsets flood the avenues
 * with freight and flash the floor grid, hat-district onsets send a courier
 * along the flyover lane, and the mid band sets ambient street traffic. FFT
 * kick/hat transients stand in only when nothing is scheduled.
 *
 * Flat faces and fine outlines, source-over throughout; stroke widths and car
 * sizes are CSS pixels scaled modestly with the canvas, the camera fits the
 * city to the canvas, and labels stay screen-space mono.
 *
 * This mode parses the shared cycle-view buffer itself (it needs per-slot
 * dedup, not the flat track model) but follows the same buffer discipline:
 * parse fully + synchronously right after its own query, fresh Float32Array
 * view each call.
 */

import type {PatternHandle} from '../../../pkg';
import type {PatternSource, Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {MAX_TRACKS, VIEW_CAPACITY, instrumentFamily} from '../tracks.js';
import {
    MONO_FONT, SeededRandom, TAU, TransientDetector, alphaRamp, beatEnv, lerpRgb, mixRgb, rampAt, rgbOf,
} from '../util.js';

const ISO_W = 36;   // px per unit along (i - j)
const ISO_H = 18;   // px per unit along (i + j)
const ISO_Z = 22;   // px per unit of height

const CITY_PAD_TILES = 4;      // district pad is 4×4 tiles
const CITY_PLOT_STRIDE = 5.5;  // pad + street gap, in tiles
const CITY_SLOTS = 16;         // hap onsets quantize to 16ths of the bar
const CITY_MAX_PLOTS = 32;
const CITY_DEMOLISH_SECS = 0.6;
const MAX_TRAFFIC = 96;
/** Traffic stream seed — deterministic spawns, stable across re-entry. */
const TRAFFIC_SEED = 0x1c17c0de;
/** World-unit dash rhythms for the two street classes (scale with the camera). */
const DASH_MAGENTA = [3, 17];
const DASH_CYAN = [8, 12];
const NO_DASH: number[] = [];

/**
 * Deterministic diamond-spiral plot table: index → (plotI, plotJ). Ring 0 is
 * the origin, then outward shells ordered front-to-back, so the city grows in
 * rings and a given plot index always lands on the same spot.
 */
const CITY_PLOT_OFFSETS: Array<[number, number]> = (() => {
    const out: Array<[number, number]> = [[0, 0]];
    for (let r = 1; out.length < CITY_MAX_PLOTS; r++) {
        const ring: Array<[number, number]> = [];
        for (let di = -r; di <= r; di++) {
            const dj = r - Math.abs(di);
            ring.push([di, dj]);
            if (dj !== 0) ring.push([di, -dj]);
        }
        ring.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);
        for (const o of ring) {
            if (out.length < CITY_MAX_PLOTS) out.push(o);
        }
    }
    return out;
})();

type CityKind = 'kick' | 'snare' | 'hat' | 'perc' | 'pitched';

/** Precomputed canvas colors per district — mixed once, never in the hot path. */
interface CityColors {
    top: string;
    left: string;
    right: string;
    topLit: string;
    leftLit: string;
    rightLit: string;
    strokeTop: string;
    strokeSide: string;
    accent: string;
    /** Accent rgb, kept so a theme change can recolor without a rebuild. */
    rgb: [number, number, number];
    pad: string;
    padSide: string;
    padStroke: string;
    hatch: string;
}

interface CityBuilding {
    /** Slot in the pad's 4×4 grid — building identity across bar rebuilds. */
    slot: number;
    /** Bar-relative onset/offset, 0..1. */
    begin: number;
    end: number;
    /** MIDI note or NaN for unpitched haps. */
    note: number;
    /** Footprint + height in tile units, positioned inside the pad. */
    i: number;
    j: number;
    w: number;
    d: number;
    h: number;
    /** Schedule-pulse envelope: 1 at onset, exponential decay. */
    flash: number;
}

interface CityDistrict {
    /** Track name = sound name — the stable identity across pattern edits. */
    name: string;
    label: string;
    kind: CityKind;
    plot: number;
    /** Pad origin in tile coords. */
    i0: number;
    j0: number;
    colors: CityColors;
    buildings: CityBuilding[];
    /** Seconds since each slot became occupied — drives per-building grow-in. */
    slotAge: Float32Array;
    /** Seconds since the district appeared — drives the rise-from-floor. */
    age: number;
    /** 0 = alive; > 0 = demolition countdown (sink + fade, then plot freed). */
    dying: number;
    /** Smoothed hap activity — drives pad glow. */
    activity: number;
    /** Scratch flag during rebuild: still present in the queried bar. */
    seen: boolean;
}

type TrafficKind = 'ambient' | 'kick' | 'hat';

interface CityTraffic {
    /** Tile-space position; travels along one street axis. */
    i: number;
    j: number;
    di: number;
    dj: number;
    speed: number;
    life: number;
    /** Palette index into the traffic ramps: 0 neon, 1 secondary, 2 active. */
    color: number;
    /** Height above the street — hat cars ride the flyover lane. */
    lift: number;
    size: number;
    /** Flicker phase for the broken-neon dropout; -1 = solid car. */
    flicker: number;
}

// Rebuild-time scratch (module-level to avoid per-bar allocation; only one
// mode instance is ever active).
const slotUsed = new Uint8Array(CITY_SLOTS);
const slotBegin = new Float32Array(CITY_SLOTS);
const slotEnd = new Float32Array(CITY_SLOTS);
const slotNote = new Float32Array(CITY_SLOTS);
const prevUsed = new Uint8Array(CITY_SLOTS);
const prevFlash = new Float32Array(CITY_SLOTS);

/** 2:1 dimetric projection (cyberdesign iso.js `projectIso`, canvas port). */
function isoX(i: number, j: number): number {
    return (i - j) * ISO_W;
}

function isoY(i: number, j: number, k: number): number {
    return (i + j) * ISO_H - k * ISO_Z;
}

/**
 * District archetype from the track. Any finite note this bar makes it a
 * tower district; otherwise the sound name picks a drum shape.
 */
function cityKindFor(name: string, hasPitch: boolean): CityKind {
    if (hasPitch) return 'pitched';
    return instrumentFamily(name);
}

class IsoCityMode implements VizMode {
    private districts: CityDistrict[] = [];
    private readonly plotByName = new Map<string, number>();
    private freePlots: number[] = [];
    private nextPlot = 0;
    private lastBar = -1;
    private lastPattern: PatternHandle | null = null;
    private prevPhase = 0;
    private registryVersion = -1;
    private readonly trackNames: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    /** Painter-sorted building draw list, rebuilt only on structural change. */
    private drawBuildings: Array<{ b: CityBuilding; d: CityDistrict }> = [];
    private pads: CityDistrict[] = [];
    /** Fixed pool; the first `trafficCount` entries are live. */
    private readonly traffic: CityTraffic[] = [];
    private trafficCount = 0;
    private readonly rng = new SeededRandom(TRAFFIC_SEED);
    /** City extent in tiles from the origin — grid + traffic range. */
    private extent = CITY_PAD_TILES;
    private rings = 0;
    /** Camera: current lerps toward target; 0 scale = snap on first frame. */
    private camScale = 0;
    private camTargetScale = 1;
    private camX = 0;
    private camY = 0;
    private camTargetX = 0;
    private camTargetY = 0;
    private driftT = 0;
    private floorFlash = 0;
    /** Accumulated dash scroll (world px) for the street packet trains. */
    private dashT = 0;
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    private vw = 0;
    private vh = 0;
    private theme: Theme | null = null;
    /** min(w, h) / 720 — the canvas unit. */
    private u = 1;
    /** Modest CSS-px stroke/size multiplier (1 at 720p, ≤ 1.75 at 4K). */
    private lineU = 1;
    private labelPx = 10;
    private labelFont = `10px ${MONO_FONT}`;
    // Palette caches, rebuilt in layout() when the theme changes.
    private sky: CanvasGradient | null = null;
    private skyH = 0;
    private neonRgb: [number, number, number] = [0, 229, 255];
    private bgRgb: [number, number, number] = [0, 0, 0];
    private gridRamp: string[] = [];
    /** Street lanes: [0] cyan-class, [1] magenta-class. */
    private laneRamps: string[][] = [];
    /** Traffic: neon, secondary, active — fill ramps and head outlines. */
    private carRamps: string[][] = [];
    private carOutline: string[][] = [];

    constructor() {
        for (let n = 0; n < MAX_TRAFFIC; n++) {
            this.traffic.push({
                i: 0, j: 0, di: 0, dj: 0, speed: 0, life: 0, color: 0, lift: 0, size: 0, flicker: -1,
            });
        }
    }

    layout(s: VizServices): void {
        // Resize/mode entry: rescale and refit the camera to whatever city
        // stands. The city itself is in tile space and is never reset here.
        this.vw = s.width;
        this.vh = s.height;
        const u = Math.min(s.width, s.height) / 720;
        this.u = u;
        this.lineU = Math.min(1.75, Math.max(1, Math.sqrt(u)));
        this.labelPx = Math.round(Math.min(11, Math.max(9, 10 * u)));
        this.labelFont = `${this.labelPx}px ${MONO_FONT}`;
        if (s.theme !== this.theme) {
            this.theme = s.theme;
            this.buildPalette(s.theme);
            for (const d of this.districts) d.colors = this.colorsFor(d.colors.rgb, s.theme);
            this.sky = null;
        }
        this.refit();
    }

    private buildPalette(t: Theme): void {
        const neon = rgbOf(t.neon, t.accentPool[0]);
        this.neonRgb = neon;
        this.bgRgb = t.bgRgb;
        this.gridRamp = alphaRamp(neon);
        this.laneRamps = [alphaRamp(t.accentPool[0]), alphaRamp(t.accentPool[1 % t.accentPool.length])];
        const cars: Array<[number, number, number]> = [
            neon,
            rgbOf(t.neonSecondary, [255, 43, 214]),
            rgbOf(t.active, [255, 214, 10]),
        ];
        this.carRamps = cars.map((c) => alphaRamp(c));
        this.carOutline = cars.map((c) => alphaRamp(mixRgb(c, t.textRgb, 0.55)));
    }

    /** Top-of-frame sky wash: one cached gradient at unit alpha, faded by globalAlpha. */
    private skyFor(ctx: CanvasRenderingContext2D, h: number): CanvasGradient {
        if (!this.sky || this.skyH !== h) {
            // Neon pulled toward the background — the old 40%-lightness sky.
            const [r, g, b] = mixRgb(this.neonRgb, this.bgRgb, 0.35);
            const sky = ctx.createLinearGradient(0, 0, 0, h * 0.7);
            sky.addColorStop(0, `rgb(${r}, ${g}, ${b})`);
            sky.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
            this.sky = sky;
            this.skyH = h;
        }
        return this.sky;
    }

    update(dt: number, s: VizServices): void {
        const {low, mid, high} = s;
        const source = s.patternSource;
        const pattern = source?.scheduler.pattern ?? null;
        const bar = Math.floor(s.cycle);

        // Rebuild on live edit (each evaluate creates a new handle) or on the
        // bar boundary (multi-cycle patterns change from bar to bar).
        if (pattern && source && (pattern !== this.lastPattern || bar !== this.lastBar)) {
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern, source, bar, s.theme);
            // Let begin=0 haps fire on the downbeat we just crossed.
            this.prevPhase = -1e-6;
        }
        if (!pattern) this.lastPattern = null;

        // Schedule-accurate onset flashes — latency-compensated cycle means
        // these land on the audible hits.
        const phase = s.cycle - bar;
        let kickHit = false;
        let hatHits = 0;
        if (pattern && phase >= this.prevPhase) {
            const prev = this.prevPhase;
            for (const d of this.districts) {
                if (d.dying > 0) continue;
                for (const b of d.buildings) {
                    if (b.begin > prev && b.begin <= phase) {
                        b.flash = 1;
                        d.activity = Math.min(1, d.activity + 0.45);
                        if (d.kind === 'kick') kickHit = true;
                        else if (d.kind === 'hat') hatHits++;
                    }
                }
            }
        }
        this.prevPhase = phase;

        // Envelope decay, ages, demolition.
        const flashDecay = Math.exp(-dt * 6);
        const actDecay = Math.exp(-dt * 2.5);
        let structural = false;
        for (let n = this.districts.length - 1; n >= 0; n--) {
            const d = this.districts[n];
            d.activity *= actDecay;
            d.age += dt;
            for (let sl = 0; sl < CITY_SLOTS; sl++) d.slotAge[sl] += dt;
            for (const b of d.buildings) b.flash *= flashDecay;
            if (d.dying > 0) {
                d.dying -= dt;
                if (d.dying <= 0) {
                    this.districts.splice(n, 1);
                    this.plotByName.delete(d.name);
                    this.freePlots.push(d.plot);
                    structural = true;
                }
            }
        }
        if (structural) {
            this.rebuildDrawLists();
            this.refit();
        }

        // Kicks flood the avenues + flash the floor grid; hats send a single
        // fast car each. Scheduled onsets drive this; FFT transients only
        // stand in when nothing is scheduled.
        const hits = this.transients.update(dt, low, mid, high);
        if (!pattern) {
            kickHit = hits.kick;
            hatHits = hits.hat ? 1 : 0;
        }
        if (kickHit) {
            this.floorFlash = 1;
            for (let n = 0; n < 4; n++) this.spawnTraffic(this.rng.range(1.5, 2.3), 'kick');
        }
        // A catch-up frame (dt clamp) can cross several hats; two cars is plenty.
        for (let n = Math.min(2, hatHits); n > 0; n--) this.spawnTraffic(2.4, 'hat');
        this.floorFlash *= Math.exp(-dt * 8);

        // Street packet trains scroll with musical time: a linear crawl that
        // surges on every quarter note (the cyberdesign dash-offset trick,
        // tempo-locked).
        this.dashT += dt * (14 + beatEnv(s.cycle * 4) * 30 + Math.min(1.5, mid) * 20);

        // Ambient traffic — mid band drives street activity.
        const midC = Math.min(1.5, mid);
        if (this.districts.length > 0 && this.rng.next() < (0.4 + midC * 5) * dt) {
            this.spawnTraffic(1 + midC * 1.5, 'ambient');
        }
        // Swap-remove keeps the pool dense; draw order among cars is free.
        for (let n = this.trafficCount - 1; n >= 0; n--) {
            const t = this.traffic[n];
            t.i += t.di * t.speed * dt;
            t.j += t.dj * t.speed * dt;
            t.life -= dt;
            if (t.life <= 0) {
                const last = --this.trafficCount;
                this.traffic[n] = this.traffic[last];
                this.traffic[last] = t;
            }
        }

        // Camera eases toward the fit; drift clock for the lissajous pan.
        const cl = 1 - Math.exp(-dt * 2.5);
        this.camScale += (this.camTargetScale - this.camScale) * cl;
        this.camX += (this.camTargetX - this.camX) * cl;
        this.camY += (this.camTargetY - this.camY) * cl;
        this.driftT += dt;
    }

    /**
     * Query the current bar and reconcile the city model with it. The shared
     * cycle-view buffer is parsed synchronously, immediately after our own
     * query — never between another caller's query and its reads.
     */
    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme): void {
        pattern.queryCycleViewData(bar, 1);
        // Fresh view per query — WASM memory growth detaches cached views.
        const data = new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);

        const trackCount = data[0];
        const registryVersion = data[2];
        if (registryVersion !== this.registryVersion) {
            this.registryVersion = registryVersion;
            this.trackNames.fill(undefined);
        }

        for (const d of this.districts) d.seen = false;

        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];

            let name = this.trackNames[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.trackNames[trackId] = name;
            }

            // Quantize this track's haps into the 16-slot pad grid. Dedupe per
            // slot (earliest onset, highest note) — this is also the density
            // cap that neutralizes `note("c*2048")`-style patterns.
            slotUsed.fill(0);
            let hasPitch = false;
            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= 1) continue;
                const cb = begin < 0 ? 0 : begin;
                const slot = Math.min(CITY_SLOTS - 1, Math.floor(cb * CITY_SLOTS));
                const pitched = Number.isFinite(note);
                if (pitched) hasPitch = true;
                if (!slotUsed[slot]) {
                    slotUsed[slot] = 1;
                    slotBegin[slot] = cb;
                    slotEnd[slot] = Math.min(end, 1);
                    slotNote[slot] = pitched ? note : NaN;
                } else {
                    if (cb < slotBegin[slot]) slotBegin[slot] = cb;
                    if (end > slotEnd[slot]) slotEnd[slot] = Math.min(end, 1);
                    if (pitched && (!Number.isFinite(slotNote[slot]) || note > slotNote[slot])) {
                        slotNote[slot] = note;
                    }
                }
            }
            idx += (eventCount - nEvents) * 3;

            const kind = cityKindFor(name, hasPitch);
            let district = this.plotByName.has(name)
                ? this.districts.find((d) => d.name === name)
                : undefined;

            if (!district) {
                const plot = this.freePlots.length > 0
                    ? this.freePlots.pop()!
                    : (this.nextPlot < CITY_MAX_PLOTS ? this.nextPlot++ : -1);
                if (plot === -1) continue; // city full — overflow tracks dropped
                this.plotByName.set(name, plot);
                const [pi, pj] = CITY_PLOT_OFFSETS[plot];
                district = {
                    name,
                    label: name.toUpperCase(),
                    kind,
                    plot,
                    i0: pi * CITY_PLOT_STRIDE - CITY_PAD_TILES / 2,
                    j0: pj * CITY_PLOT_STRIDE - CITY_PAD_TILES / 2,
                    colors: null as unknown as CityColors, // set below
                    buildings: [],
                    slotAge: new Float32Array(CITY_SLOTS),
                    age: 0,
                    dying: 0,
                    activity: 0,
                    seen: true,
                };
                this.districts.push(district);
            } else {
                district.seen = true;
                district.kind = kind;
                if (district.dying > 0) {
                    // Revived mid-demolition — rise again.
                    district.dying = 0;
                    district.age = 0;
                }
            }

            // Colors recomputed each rebuild: tracks theme changes and edits
            // to the pattern's `.color()` hint. Cheap — a dozen strings.
            const hint = pattern.getTrackColor(trackId);
            const fallback = theme.accentPool[district.plot % theme.accentPool.length];
            const accent = hint !== undefined ? rgbOf(hint, fallback) : fallback;
            district.colors = this.colorsFor(accent, theme);

            // Rebuild buildings, preserving flash + grow-in age per slot so
            // nothing pops when the bar ticks over.
            prevUsed.fill(0);
            for (const b of district.buildings) {
                prevUsed[b.slot] = 1;
                prevFlash[b.slot] = b.flash;
            }
            district.buildings.length = 0;
            for (let sl = 0; sl < CITY_SLOTS; sl++) {
                if (!slotUsed[sl]) continue;
                if (!prevUsed[sl]) district.slotAge[sl] = 0;
                const note = slotNote[sl];
                let bw = 0.6;
                let bh = 1.2;
                switch (district.kind) {
                    case 'kick': bw = 0.85; bh = 0.8; break;
                    case 'snare': bw = 0.8; bh = 1.0; break;
                    case 'hat': bw = 0.3; bh = 2.2; break;
                    case 'perc': break;
                    case 'pitched': {
                        bw = 0.65;
                        // Sidebar's C1–C7 range; NaN (unpitched hap on a
                        // pitched track) gets a mid-height tower.
                        const n = Number.isFinite(note) ? Math.min(96, Math.max(24, note)) : 45;
                        bh = 0.6 + ((n - 24) / 72) * 4.4;
                        break;
                    }
                }
                district.buildings.push({
                    slot: sl,
                    begin: slotBegin[sl],
                    end: slotEnd[sl],
                    note,
                    i: district.i0 + (sl & 3) + (1 - bw) / 2,
                    j: district.j0 + (sl >> 2) + (1 - bw) / 2,
                    w: bw,
                    d: bw,
                    h: bh,
                    flash: prevUsed[sl] ? prevFlash[sl] : 0,
                });
            }
        }

        // Tracks gone from the pattern start sinking.
        for (const d of this.districts) {
            if (!d.seen && d.dying === 0) d.dying = CITY_DEMOLISH_SECS;
        }

        this.rebuildDrawLists();
        this.refit();
    }

    /** Canvas port of iso.css's color-mix face lighting, per district accent. */
    private colorsFor(accent: [number, number, number], t: Theme): CityColors {
        const a = accent;
        return {
            top: lerpRgb(t.bgLighterRgb, a, 0.10),
            left: lerpRgb(t.bgRgb, a, 0.05),
            right: lerpRgb(t.bgLighterRgb, a, 0.16),
            topLit: lerpRgb(t.bgLighterRgb, a, 0.55),
            leftLit: lerpRgb(t.bgRgb, a, 0.40),
            rightLit: lerpRgb(t.bgLighterRgb, a, 0.60),
            strokeTop: lerpRgb(t.borderRgb, a, 0.38),
            strokeSide: lerpRgb(t.borderRgb, a, 0.25),
            accent: `rgb(${a[0]}, ${a[1]}, ${a[2]})`,
            rgb: a,
            pad: lerpRgb(t.bgLightRgb, a, 0.06),
            padSide: lerpRgb(t.bgRgb, a, 0.05),
            padStroke: `rgba(${a[0]}, ${a[1]}, ${a[2]}, 0.42)`,
            hatch: `rgba(${a[0]}, ${a[1]}, ${a[2]}, 0.08)`,
        };
    }

    /**
     * Painter ordering, recomputed only on structural change — camera pan and
     * zoom never alter iso depth order. Pads draw first (flat, ground level),
     * then all buildings globally back-to-front.
     */
    private rebuildDrawLists(): void {
        this.pads = this.districts.slice()
            .sort((a, b) => (a.i0 + a.j0) - (b.i0 + b.j0));

        const items: Array<{ b: CityBuilding; d: CityDistrict }> = [];
        for (const d of this.districts) {
            for (const b of d.buildings) items.push({ b, d });
        }
        items.sort((x, y) =>
            (x.b.i + x.b.j + (x.b.w + x.b.d) * 0.5) - (y.b.i + y.b.j + (y.b.w + y.b.d) * 0.5));
        this.drawBuildings = items;

        let rings = 0;
        for (const d of this.districts) {
            const [pi, pj] = CITY_PLOT_OFFSETS[d.plot];
            const r = Math.abs(pi) + Math.abs(pj);
            if (r > rings) rings = r;
        }
        this.rings = rings;
        this.extent = rings * CITY_PLOT_STRIDE + CITY_PAD_TILES / 2 + 1.5;
    }

    /** Fit the camera target to the standing city's projected bounds. */
    private refit(): void {
        if (this.vw === 0 || this.vh === 0) return;

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let maxH = 1;
        const P = CITY_PAD_TILES;
        for (const d of this.districts) {
            // Pad diamond extremes: left (i0, j0+P), right (i0+P, j0),
            // top (i0, j0), bottom (i0+P, j0+P).
            const l = isoX(d.i0, d.j0 + P);
            const r = isoX(d.i0 + P, d.j0);
            const t = isoY(d.i0, d.j0, 0);
            const b = isoY(d.i0 + P, d.j0 + P, 0);
            if (l < minX) minX = l;
            if (r > maxX) maxX = r;
            if (t < minY) minY = t;
            if (b > maxY) maxY = b;
            for (const b of d.buildings) {
                if (b.h > maxH) maxH = b.h;
            }
        }
        if (!Number.isFinite(minX)) {
            // Empty city: frame one plot's worth of grid.
            minX = -CITY_PAD_TILES * ISO_W;
            maxX = CITY_PAD_TILES * ISO_W;
            minY = -CITY_PAD_TILES * ISO_H;
            maxY = CITY_PAD_TILES * ISO_H;
        }
        minY -= maxH * ISO_Z + ISO_Z; // headroom for towers
        maxY += ISO_H; // room for the district labels under the front pads
        // Screen margins cover the lissajous camera drift (±3% / ±2% of the
        // short side) so pads never clip mid-pan.
        const m = Math.min(this.vw, this.vh);
        const fit = Math.min(
            (this.vw - m * 0.16) / (maxX - minX + ISO_W),
            (this.vh - m * 0.14) / (maxY - minY),
        );
        this.camTargetScale = Math.min(1.4 * this.u, Math.max(0.45 * this.u, fit));
        this.camTargetX = (minX + maxX) / 2;
        this.camTargetY = (minY + maxY) / 2;
        if (this.camScale === 0) {
            this.camScale = this.camTargetScale;
            this.camX = this.camTargetX;
            this.camY = this.camTargetY;
        }
    }

    private spawnTraffic(speedMul: number, kind: TrafficKind): void {
        if (this.trafficCount >= MAX_TRAFFIC) return;
        const rng = this.rng;
        const R = this.rings;
        // Street center lines run between plot rows at m·stride + pad/2 + gap/2.
        const m = Math.floor(rng.next() * (2 * R + 2)) - R - 1;
        const lane = m * CITY_PLOT_STRIDE + CITY_PAD_TILES / 2 + 0.75;
        const ext = this.extent + 2;
        const alongI = rng.next() < 0.5;
        const dir = rng.next() < 0.5 ? 1 : -1;
        const speed = 6 * speedMul;
        const car = this.traffic[this.trafficCount++];
        car.i = alongI ? -dir * ext : lane;
        car.j = alongI ? lane : -dir * ext;
        car.di = alongI ? dir : 0;
        car.dj = alongI ? 0 : dir;
        car.speed = speed;
        car.life = (2 * ext) / speed;
        // Traffic classes (cyberdesign lane separation): kicks are big
        // magenta ground-freight, hats small cyan couriers on the flyover
        // lane, ambient cars mix the palette at street level.
        car.color = kind === 'kick' ? 1 : kind === 'hat' ? 0 : Math.min(2, Math.floor(rng.next() * 3));
        car.lift = kind === 'hat' ? 0.55 : 0.12;
        car.size = kind === 'kick' ? 3 : kind === 'hat' ? 1.8 : 2.2;
        // ~1 in 7 cars has a broken-neon flicker.
        car.flicker = rng.next() < 0.14 ? rng.next() * 3 : -1;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        if (w <= 0 || h <= 0 || !this.theme) return;
        // Bands may exceed 1; clamp so nothing scales off the palette ramps.
        const low = Math.min(1.5, s.low);
        const mid = Math.min(1.5, s.mid);
        const high = Math.min(1.5, s.high);
        const energy = Math.min(1, (low + mid + high) / 3);
        const beat = beatEnv(s.cycle * 4);
        const downbeat = beatEnv(s.cycle);
        const playing = s.patternSource?.scheduler.pattern != null;

        ctx.save();

        // Sky/horizon wash — cached gradient, faded by the overall energy.
        ctx.globalAlpha = 0.05 + energy * 0.22;
        ctx.fillStyle = this.skyFor(ctx, h);
        ctx.fillRect(0, 0, w, h * 0.7);
        ctx.globalAlpha = 1;

        const scale = this.camScale * (1 + low * 0.012);
        if (!(scale > 0)) {
            ctx.restore();
            return;
        }
        const driftX = Math.sin(this.driftT * TAU / 45) * Math.min(w, h) * 0.03;
        const driftY = Math.sin(this.driftT * TAU / 38 + 1.3) * Math.min(w, h) * 0.02;

        ctx.translate(w / 2 + driftX, h * 0.55 + driftY);
        ctx.scale(scale, scale);
        ctx.translate(-this.camX, -this.camY);
        // One (modestly canvas-scaled) CSS px in world units — crisp strokes.
        const px = this.lineU / scale;

        // Floor grid — pulses on the beat, flashes on kicks.
        const ext = Math.ceil(this.extent);
        const gridPulse = 0.6 + 0.4 * beat;
        const minorA = 0.09 * gridPulse + low * 0.05 + this.floorFlash * 0.12;
        const majorA = 0.18 * gridPulse + low * 0.08 + this.floorFlash * 0.2 + downbeat * 0.06;
        ctx.lineWidth = 0.8 * px;
        ctx.strokeStyle = rampAt(this.gridRamp, minorA);
        ctx.beginPath();
        for (let g = -ext; g <= ext; g++) {
            if (g % 2 === 0) continue;
            ctx.moveTo(isoX(g, -ext), isoY(g, -ext, 0));
            ctx.lineTo(isoX(g, ext), isoY(g, ext, 0));
            ctx.moveTo(isoX(-ext, g), isoY(-ext, g, 0));
            ctx.lineTo(isoX(ext, g), isoY(ext, g, 0));
        }
        ctx.stroke();
        ctx.lineWidth = 1.1 * px;
        ctx.strokeStyle = rampAt(this.gridRamp, majorA);
        ctx.beginPath();
        for (let g = -ext; g <= ext; g++) {
            if (g % 2 !== 0) continue;
            ctx.moveTo(isoX(g, -ext), isoY(g, -ext, 0));
            ctx.lineTo(isoX(g, ext), isoY(g, ext, 0));
            ctx.moveTo(isoX(-ext, g), isoY(-ext, g, 0));
            ctx.lineTo(isoX(ext, g), isoY(ext, g, 0));
        }
        ctx.stroke();

        // Street conduits — the cyberdesign twin-stroke + marching-packet-train
        // recipe. Each lane class is one path stroked twice: a wide flat
        // translucent band, then a thin dashed core whose dash offset scrolls
        // with musical time, so the roads visibly carry energy between cars.
        // Alternate lanes run cyan/magenta in opposite directions.
        if (this.districts.length > 0) {
            const bandA = 0.08 + low * 0.05 + this.floorFlash * 0.12;
            const coreA = 0.24 + this.floorFlash * 0.22;
            for (let cls = 0; cls < 2; cls++) {
                const magenta = cls === 1;
                this.traceLanes(ctx, ext, magenta);
                const ramp = this.laneRamps[cls];
                ctx.strokeStyle = rampAt(ramp, bandA);
                ctx.lineWidth = 4 * px;
                ctx.setLineDash(NO_DASH);
                ctx.stroke();
                ctx.strokeStyle = rampAt(ramp, coreA);
                ctx.lineWidth = 1.4 * px;
                ctx.setLineDash(magenta ? DASH_MAGENTA : DASH_CYAN);
                ctx.lineDashOffset = magenta ? -this.dashT : this.dashT * 0.7;
                ctx.stroke();
            }
            ctx.setLineDash(NO_DASH);
            ctx.lineDashOffset = 0;
        }

        // District pads, ground first.
        for (const d of this.pads) {
            this.drawPad(ctx, d, px);
        }

        // Buildings, globally back-to-front.
        const phase = s.cycle - Math.floor(s.cycle);
        for (const item of this.drawBuildings) {
            this.drawBuilding(ctx, item.b, item.d, px, high, beat, playing ? phase : -1);
        }

        // Traffic — streaked diamonds, flat: a two-step tail (bright near the
        // head, faint behind), a flat head with a fine lighter outline, and
        // a minority of cars flickering like broken neon.
        ctx.lineCap = 'round';
        for (let n = 0; n < this.trafficCount; n++) {
            const t = this.traffic[n];
            const tx = isoX(t.i, t.j);
            const ty = isoY(t.i, t.j, t.lift);
            const ramp = this.carRamps[t.color];
            let alpha = Math.min(1, t.life * 2) * 0.85;
            // Broken-neon dropout: brief dips on a 3s cycle.
            if (t.flicker >= 0 && ((this.driftT + t.flicker) % 3) < 0.07) alpha *= 0.15;

            // Flyover cars drop a faint pylon tick to the street below.
            if (t.lift > 0.3) {
                ctx.strokeStyle = rampAt(ramp, alpha * 0.14);
                ctx.lineWidth = px;
                ctx.beginPath();
                ctx.moveTo(tx, isoY(t.i, t.j, 0));
                ctx.lineTo(tx, ty);
                ctx.stroke();
            }

            // Velocity streak, length scales with speed.
            const trail = Math.min(2.4, 0.5 + t.speed * 0.11);
            const mi = t.i - t.di * trail * 0.45;
            const mj = t.j - t.dj * trail * 0.45;
            const ei = t.i - t.di * trail;
            const ej = t.j - t.dj * trail;
            ctx.lineWidth = t.size * 1.5 * px;
            ctx.strokeStyle = rampAt(ramp, alpha * 0.14);
            ctx.beginPath();
            ctx.moveTo(isoX(ei, ej), isoY(ei, ej, t.lift));
            ctx.lineTo(isoX(mi, mj), isoY(mi, mj, t.lift));
            ctx.stroke();
            ctx.strokeStyle = rampAt(ramp, alpha * 0.4);
            ctx.beginPath();
            ctx.moveTo(isoX(mi, mj), isoY(mi, mj, t.lift));
            ctx.lineTo(tx, ty);
            ctx.stroke();

            // Diamond head.
            const r = (t.size + mid * 1.5) * px;
            ctx.beginPath();
            ctx.moveTo(tx, ty - r);
            ctx.lineTo(tx + r, ty);
            ctx.lineTo(tx, ty + r);
            ctx.lineTo(tx - r, ty);
            ctx.closePath();
            ctx.fillStyle = rampAt(ramp, alpha);
            ctx.fill();
            ctx.strokeStyle = rampAt(this.carOutline[t.color], alpha);
            ctx.lineWidth = px;
            ctx.stroke();
        }

        ctx.restore();

        // District labels — screen space so the mono text stays crisp.
        ctx.save();
        ctx.font = this.labelFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const labelDy = this.labelPx * 0.6;
        for (const d of this.pads) {
            const ax = isoX(d.i0 + 0.15, d.j0 + CITY_PAD_TILES);
            const ay = isoY(d.i0 + 0.15, d.j0 + CITY_PAD_TILES, 0);
            const sx = w / 2 + driftX + (ax - this.camX) * scale;
            const sy = h * 0.55 + driftY + (ay - this.camY) * scale + labelDy;
            const life = d.dying > 0 ? d.dying / CITY_DEMOLISH_SECS : Math.min(1, d.age * 2);
            ctx.globalAlpha = (0.35 + d.activity * 0.5) * life;
            ctx.fillStyle = d.colors.accent;
            ctx.fillText(d.label, sx, sy);
        }
        ctx.restore();
    }

    /** Both axes' street centre lines of one lane class, as a single path. */
    private traceLanes(ctx: CanvasRenderingContext2D, ext: number, magenta: boolean): void {
        const R = this.rings;
        ctx.beginPath();
        for (let m = -R - 1; m <= R + 1; m++) {
            if ((((m % 2) + 2) % 2 === 0) !== magenta) continue;
            const lane = m * CITY_PLOT_STRIDE + CITY_PAD_TILES / 2 + 0.75;
            if (Math.abs(lane) > this.extent + 1) continue;
            ctx.moveTo(isoX(-ext, lane), isoY(-ext, lane, 0));
            ctx.lineTo(isoX(ext, lane), isoY(ext, lane, 0));
            ctx.moveTo(isoX(lane, -ext), isoY(lane, -ext, 0));
            ctx.lineTo(isoX(lane, ext), isoY(lane, ext, 0));
        }
    }

    private drawPad(ctx: CanvasRenderingContext2D, d: CityDistrict, px: number): void {
        const P = CITY_PAD_TILES;
        const life = d.dying > 0 ? d.dying / CITY_DEMOLISH_SECS : 1;
        const rise = Math.min(1, d.age * 2);
        const padH = Math.max(0.02, 0.18 * (d.dying > 0 ? life : rise));
        const c = d.colors;

        ctx.globalAlpha = life;
        this.drawBox(ctx, d.i0, d.j0, 0, P, P, padH,
            c.pad, c.padSide, c.padSide, c.padStroke, c.padStroke, px, 1.35);

        // Hatch lines across the pad top (cyberdesign district style).
        ctx.strokeStyle = c.hatch;
        ctx.lineWidth = 0.7 * px;
        ctx.beginPath();
        for (let g = 1; g < P; g++) {
            ctx.moveTo(isoX(d.i0 + g, d.j0), isoY(d.i0 + g, d.j0, padH));
            ctx.lineTo(isoX(d.i0 + g, d.j0 + P), isoY(d.i0 + g, d.j0 + P, padH));
        }
        ctx.stroke();

        // Activity glow — the pad breathes with its district's hits.
        if (d.activity > 0.03) {
            ctx.globalAlpha = d.activity * 0.16 * life;
            ctx.fillStyle = c.accent;
            ctx.beginPath();
            ctx.moveTo(isoX(d.i0, d.j0), isoY(d.i0, d.j0, padH));
            ctx.lineTo(isoX(d.i0 + P, d.j0), isoY(d.i0 + P, d.j0, padH));
            ctx.lineTo(isoX(d.i0 + P, d.j0 + P), isoY(d.i0 + P, d.j0 + P, padH));
            ctx.lineTo(isoX(d.i0, d.j0 + P), isoY(d.i0, d.j0 + P, padH));
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    /**
     * One building: kind-shaped body, lit overlay while its hap flashes or
     * sustains, beacon on the roof. `phase` is the bar phase, or -1 when the
     * transport is stopped (kills sustain lighting).
     */
    private drawBuilding(
        ctx: CanvasRenderingContext2D,
        b: CityBuilding,
        d: CityDistrict,
        px: number,
        high: number,
        beat: number,
        phase: number,
    ): void {
        const life = d.dying > 0 ? d.dying / CITY_DEMOLISH_SECS : 1;
        const grow = Math.min(1, d.slotAge[b.slot] * 4);
        const rise = Math.min(1, d.age * 2);
        const bh = Math.max(0.06, b.h * grow * rise * life);
        const k = 0.18; // buildings sit on the pad
        const c = d.colors;
        const sustaining = phase >= 0 && d.dying === 0 && b.begin <= phase && phase < b.end;
        const lit = Math.max(b.flash, sustaining ? 0.35 : 0);

        ctx.globalAlpha = life;
        this.drawBody(ctx, b, d.kind, k, bh, c.top, c.left, c.right, c.strokeTop, c.strokeSide, px);

        if (lit > 0.05) {
            ctx.globalAlpha = lit * life;
            this.drawBody(ctx, b, d.kind, k, bh, c.topLit, c.leftLit, c.rightLit, c.accent, c.accent, px);
        }

        // Roof beacon — on schedule flashes, and antenna tips sparkle with the
        // high band.
        const beaconA = Math.max(b.flash, d.kind === 'hat' ? (high - 0.25) * 1.5 : 0);
        if (beaconA > 0.05) {
            const bx = isoX(b.i + b.w / 2, b.j + b.d / 2);
            const by = isoY(b.i + b.w / 2, b.j + b.d / 2, k + bh);
            const r = (2.5 + beat * 1.5 + b.flash * 2.5) * px;
            ctx.globalAlpha = Math.min(1, beaconA) * life;
            ctx.fillStyle = c.accent;
            ctx.beginPath();
            ctx.moveTo(bx, by - r);
            ctx.lineTo(bx + r, by);
            ctx.lineTo(bx, by + r);
            ctx.lineTo(bx - r, by);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    /** Kind-shaped building body: kick = two slabs, snare = wedge, else box. */
    private drawBody(
        ctx: CanvasRenderingContext2D,
        b: CityBuilding,
        kind: CityKind,
        k: number,
        bh: number,
        fillTop: string,
        fillLeft: string,
        fillRight: string,
        strokeTop: string,
        strokeSide: string,
        px: number,
    ): void {
        if (kind === 'kick') {
            const slab = bh / 2;
            this.drawBox(ctx, b.i + 0.05, b.j + 0.05, k, b.w - 0.1, b.d - 0.1, slab * 0.85,
                fillTop, fillLeft, fillRight, strokeTop, strokeSide, px);
            this.drawBox(ctx, b.i, b.j, k + slab, b.w, b.d, slab * 0.85,
                fillTop, fillLeft, fillRight, strokeTop, strokeSide, px);
        } else if (kind === 'snare') {
            this.drawWedge(ctx, b.i, b.j, k, b.w, b.d, bh,
                fillTop, fillLeft, fillRight, strokeTop, strokeSide, px);
        } else {
            this.drawBox(ctx, b.i, b.j, k, b.w, b.d, bh,
                fillTop, fillLeft, fillRight, strokeTop, strokeSide, px);
        }
    }

    /** The cyberdesign box primitive: left, right, top faces (back-culled). */
    private drawBox(
        ctx: CanvasRenderingContext2D,
        i: number,
        j: number,
        k: number,
        bw: number,
        bd: number,
        bh: number,
        fillTop: string,
        fillLeft: string,
        fillRight: string,
        strokeTop: string,
        strokeSide: string,
        px: number,
        topLineW = 1.15,
    ): void {
        const t = k + bh;

        ctx.beginPath();
        ctx.moveTo(isoX(i, j + bd), isoY(i, j + bd, t));
        ctx.lineTo(isoX(i + bw, j + bd), isoY(i + bw, j + bd, t));
        ctx.lineTo(isoX(i + bw, j + bd), isoY(i + bw, j + bd, k));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, k));
        ctx.closePath();
        ctx.fillStyle = fillLeft;
        ctx.fill();
        ctx.strokeStyle = strokeSide;
        ctx.lineWidth = 1 * px;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(isoX(i + bw, j), isoY(i + bw, j, t));
        ctx.lineTo(isoX(i + bw, j + bd), isoY(i + bw, j + bd, t));
        ctx.lineTo(isoX(i + bw, j + bd), isoY(i + bw, j + bd, k));
        ctx.lineTo(isoX(i + bw, j), isoY(i + bw, j, k));
        ctx.closePath();
        ctx.fillStyle = fillRight;
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(isoX(i, j), isoY(i, j, t));
        ctx.lineTo(isoX(i + bw, j), isoY(i + bw, j, t));
        ctx.lineTo(isoX(i + bw, j + bd), isoY(i + bw, j + bd, t));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, t));
        ctx.closePath();
        ctx.fillStyle = fillTop;
        ctx.fill();
        ctx.strokeStyle = strokeTop;
        ctx.lineWidth = topLineW * px;
        ctx.stroke();
    }

    /** Triangular prism pointing +i — the cyberdesign wedge (snare districts). */
    private drawWedge(
        ctx: CanvasRenderingContext2D,
        i: number,
        j: number,
        k: number,
        bw: number,
        bd: number,
        bh: number,
        fillTop: string,
        fillLeft: string,
        fillRight: string,
        strokeTop: string,
        strokeSide: string,
        px: number,
    ): void {
        const t = k + bh;
        const ti = i + bw;
        const tj = j + bd / 2;

        ctx.lineWidth = 1 * px;

        // Back face (reads as left-lit).
        ctx.beginPath();
        ctx.moveTo(isoX(i, j), isoY(i, j, t));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, t));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, k));
        ctx.lineTo(isoX(i, j), isoY(i, j, k));
        ctx.closePath();
        ctx.fillStyle = fillLeft;
        ctx.fill();
        ctx.strokeStyle = strokeSide;
        ctx.stroke();

        // Left slope.
        ctx.beginPath();
        ctx.moveTo(isoX(i, j + bd), isoY(i, j + bd, t));
        ctx.lineTo(isoX(ti, tj), isoY(ti, tj, t));
        ctx.lineTo(isoX(ti, tj), isoY(ti, tj, k));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, k));
        ctx.closePath();
        ctx.fillStyle = fillLeft;
        ctx.fill();
        ctx.stroke();

        // Right slope.
        ctx.beginPath();
        ctx.moveTo(isoX(i, j), isoY(i, j, t));
        ctx.lineTo(isoX(ti, tj), isoY(ti, tj, t));
        ctx.lineTo(isoX(ti, tj), isoY(ti, tj, k));
        ctx.lineTo(isoX(i, j), isoY(i, j, k));
        ctx.closePath();
        ctx.fillStyle = fillRight;
        ctx.fill();
        ctx.stroke();

        // Top triangle.
        ctx.beginPath();
        ctx.moveTo(isoX(i, j), isoY(i, j, t));
        ctx.lineTo(isoX(ti, tj), isoY(ti, tj, t));
        ctx.lineTo(isoX(i, j + bd), isoY(i, j + bd, t));
        ctx.closePath();
        ctx.fillStyle = fillTop;
        ctx.fill();
        ctx.strokeStyle = strokeTop;
        ctx.lineWidth = 1.15 * px;
        ctx.stroke();
    }
}

export const isoCityDef: VizModeDef = {
    id: 'iso-city',
    name: 'ISO CITY',
    create: () => new IsoCityMode(),
};
