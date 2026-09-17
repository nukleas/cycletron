/**
 * COCKPIT — a vector flight display driven by the pattern schedule.
 * Distance is musical time: objects sit at onset × Z_PER_CYCLE and the
 * camera advances at cycle × Z_PER_CYCLE. Targets are intercepted ahead of
 * the canopy: lasers arrive and targets break apart on their musical onset.
 * The scheduler already applies BPM.
 *
 * Kicks form armored targets; snares are winged craft; hats are small markers;
 * percussion is faceted debris. Pitched notes are diamonds, with sustained
 * notes drawn as orbital targets or compact capital ships. Track colors connect
 * the flight view, onset envelopes, and polar cycle scan.
 *
 * Flat surfaces and CSS-pixel strokes keep the instruments crisp at any DPR.
 * The signal bank shows scheduled activity; the band meters show measured FFT
 * energy. Rests are never diagnosed as audio dropouts.
 *
 * Like ISO CITY, this mode synchronously parses its own shared WASM cycle-view
 * query (two bars ahead), recreating the memory view after every query.
 */

import type {PatternHandle} from '../../../pkg';
import type {PatternSource, Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {MAX_TRACKS, VIEW_CAPACITY} from '../tracks.js';
import {TAU, TransientDetector, rgbOf} from '../util.js';
import {currentBpm} from '../../bpm.js';

/** World units per cycle. FOREST DRIVE uses 52 m of road; space is faster. */
const Z_PER_CYCLE = 80;
/** Cycles queried ahead — 2 keeps a full bar of sky in front at all times. */
const LOOKAHEAD = 2;

const NEAR = 0.8;        // nothing is drawn closer than this
const FAR = 160;         // draw distance
const IDLE_DRIFT = 18;   // world units/s the ship coasts when nothing plays

/** Reference depth at which a bearing angle lands exactly where it says. */
const REF_Z = 40;
const MAX_HEROES = 420;
/** Per-track share of the budget, so one `s("hh*512")` cannot starve the rest. */
const MAX_PER_TRACK = 64;
const STAR_COUNT = 360;

/** Reference scale for flight objects; instrument text stays in CSS pixels. */
const REFERENCE_HEIGHT = 1080;

/** Canopy fan: how far off the nose a track lane can sit. */
const AZ_MAX = (28 * Math.PI) / 180;
const EL_LOW = (-18 * Math.PI) / 180;
const EL_HIGH = (22 * Math.PI) / 180;
/** Unpitched material sits just under the horizon — "the road". */
const EL_FLAT = (-6 * Math.PI) / 180;

/** Sustains at or beyond this become orbital contours or capital ships. */
const LONG_DUR = 0.35;
/** Split between a dark capital hull below and a bright nebula above. */
const MASS_NOTE = 48;
/** Intercept ahead of the glass, keeping targets visible on their onset. */
const INTERCEPT_Z = 52;
const LASER_FLIGHT_SECONDS = 0.16;
const MAX_BURSTS = 40;
const MAX_LASERS = 16;
const BURST_LIFETIME = 0.55;

/** Density controls flight trails; cycle position alone controls distance. */
const DENSITY_FULL = 64;
const SPACE = '#070e17';
const HULL = '#101e2a';
const HULL_LOW = '#0b1520';
const HULL_HI = '#385263';
const COAMING = '#08121c';
const DEAD_SEG = '#203441';
const AMBER = '#efbd73';
const INK = '#d7e9ed';
const MUTED = '#7899aa';
const CYAN = '#80d9df';
const WARN_RED = '#ef7e82';
const CAPITAL_HULL = '#132637';

const FONT = "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, ui-monospace, monospace";

/** 70% cool, 20% warm, 10% blue — the starfield's whole colour language. */
const STAR_COLORS = ['#91b7c8', '#dac5a0', '#77b5cb'] as const;

type HeroKind = 'kick' | 'hat' | 'snare' | 'perc' | 'buoy' | 'nebula' | 'capital';

interface Hero {
    kind: HeroKind;
    note: number;
    /** Absolute world z — never rebased, so identity survives bar lines. */
    z: number;
    /** Length in z for the sustained kinds; 0 for a point event. */
    zLen: number;
    /** Fixed world offsets: the object flies out along this ray from the VP. */
    wx: number;
    wy: number;
    /** Lateral drift, world units/s — only the snare ships cross the view. */
    drift: number;
    seed: number;
    accent: [number, number, number];
    accentCss: string;
    /** Onset envelope: 1 as the camera crosses it, exponential decay. */
    flash: number;
    /** Retain destroyed sustain metadata for bar reconciliation, never redraw it. */
    destroyed: boolean;
    /** 1 = present; falls to 0 once the hap vanishes from the pattern. */
    fade: number;
    /** Scratch flag during rebuild: still scheduled in the queried span. */
    seen: boolean;
    /** Owning track, so a crossing can light the right telltale. */
    track: Telltale;
}

interface Burst {
    wx: number;
    wy: number;
    seed: number;
    css: string;
    age: number;
    power: number;
    twin: boolean;
}

/** One dash row: a track, its level, and how long it has been silent. */
interface Telltale {
    name: string;
    slot: number;
    accent: [number, number, number];
    accentCss: string;
    /** Smoothed onset envelope — bumped on crossings, exponential decay. */
    activity: number;
    /** Seconds since this track last fired. */
    silent: number;
    /** Still in the pattern; false starts the fade-out. */
    present: boolean;
    /** 1 → 0 fade-out once edited away. */
    fade: number;
}

/** A hap in the current bar, as the radar sees it. */
interface Blip {
    /** Bar phase 0..1 — the angle the sweep finds it at. */
    at: number;
    /** 0 (inner) .. 1 (outer) — kick low, hat high. */
    radius: number;
    css: string;
}

/** Deterministic 32-bit mix keeps event shapes stable across rebuilds. */
function hash32(a: number, b: number): number {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
    return (h ^ (h >>> 16)) >>> 0;
}

/** 0..1 from a hash, taking the high bits. */
function rand01(h: number): number {
    return (h >>> 8) / 0x1000000;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Recognizable forms by instrument family, as in ISO CITY and FOREST DRIVE.
 * Pitch and duration separate small note markers from extended structures.
 */
function heroKindFor(name: string, note: number, dur: number): HeroKind {
    if (Number.isFinite(note)) {
        if (dur < LONG_DUR) return 'buoy';
        return note < MASS_NOTE ? 'capital' : 'nebula';
    }
    const n = name.toLowerCase();
    if (/^(bd|kick|808)/.test(n)) return 'kick';
    if (/^(sd|sn|cp|clap|rim|lt|mt|ht)/.test(n)) return 'snare';
    if (/^(hh|oh|hat|shaker|cb|rd|cr)/.test(n)) return 'hat';
    return 'perc';
}

/** Where a kind's blips sit on the radar face. */
function blipRadiusFor(kind: HeroKind): number {
    switch (kind) {
        case 'kick': return 0.25;
        case 'capital': return 0.38;
        case 'snare': return 0.55;
        case 'perc': return 0.62;
        case 'nebula': return 0.7;
        case 'buoy': return 0.78;
        default: return 0.9;
    }
}

/** Chamfered flight glass above a responsive instrument rail. */
interface Frame {
    poly: Array<[number, number]>;
    sillY: number;
    vpX: number;
    vpY: number;
}

function computeFrame(w: number, h: number): Frame {
    const inset = Math.max(10, Math.min(42, w * 0.035));
    const top = Math.min(62, Math.max(36, h * 0.075));
    const dash = Math.min(h * 0.4, Math.max(146, Math.min(244, h * 0.28)));
    const sill = h - dash;
    const cut = Math.min(w * 0.12, h * 0.095);
    return {
        poly: [[inset + cut, top], [w - inset - cut, top],
            [w - inset, top + cut * 0.58], [w - inset, sill - 24],
            [w - inset - 24, sill], [inset + 24, sill],
            [inset, sill - 24], [inset, top + cut * 0.58]],
        sillY: sill,
        vpX: w * 0.5,
        vpY: top + (sill - top) * 0.46,
    };
}

class CockpitMode implements VizMode {
    // --- camera -----------------------------------------------------------
    /** Absolute world z of the camera. */
    private camZ = 0;
    private prevCamZ = 0;
    private camLocked = false;

    // --- schedule ---------------------------------------------------------
    private lastBar = -1;
    private lastPattern: PatternHandle | null = null;
    private registryVersion = -1;
    private readonly trackNames: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private nextSlot = 0;

    // --- world ------------------------------------------------------------
    private readonly heroes: Hero[] = [];
    private readonly heroByKey = new Map<string, Hero>();
    private drawList: Hero[] = [];
    private readonly bursts: Burst[] = [];
    /** wx, wy, z, size, colour index — 5 floats per star, never reallocated. */
    private stars = new Float32Array(0);
    private starsReady = false;
    private starSalt = 0;

    // --- tracks / dash ----------------------------------------------------
    private readonly telltales = new Map<string, Telltale>();
    private readonly telltaleList: Telltale[] = [];
    private visibleRows: Telltale[] = [];
    private barBlips: Blip[] = [];
    private onsetsThisBar = 0;

    // --- state ------------------------------------------------------------
    private warp = 0;
    /** Kick envelope accents the canopy sill and gently widens the FOV. */
    private impact = 0;
    /** Bumped when a pitched note passes — the reticle acknowledges it. */
    private melodyPulse = 0;
    private clipPeak = 0;
    private time = 0;
    private readonly transients = new TransientDetector(0.12, 0.1, 0.05);

    private readonly seenKeys = new Set<string>();

    // --- viewport ---------------------------------------------------------
    private vw = 0;
    private vh = 0;
    /** Keep fixed 1440p/4K Stage output proportional to the 1080p design. */
    private renderScale = 1;
    /** Dash scale against the 1080 reference — Stage Mode locks dpr to 1. */
    private sc = 1;
    private focal = 800;
    private frame!: Frame;
    private themeKey = '';
    private spaceCss = SPACE;

    layout(s: VizServices): void {
        // Viewport only — the flight itself must survive a resize untouched.
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.sc = Math.max(0.7, this.vh / REFERENCE_HEIGHT);
        this.focal = this.vh * 0.78;
        this.frame = computeFrame(this.vw, this.vh);
        this.ensurePalette(s.theme);
        // Stars need viewport dimensions, so they are seeded on first layout and
        // never again: a resize mid-performance must not redraw the universe.
        if (!this.starsReady) this.seedStars();
        // Force a fresh query; the world model is deliberately left alone.
        this.lastBar = -1;
    }

    update(dt: number, s: VizServices): void {
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.time += dt;
        for (let i = this.bursts.length - 1; i >= 0; i--) {
            this.bursts[i].age += dt;
            if (this.bursts[i].age >= BURST_LIFETIME) this.bursts.splice(i, 1);
        }
        const paletteChanged = this.themeKey !== s.theme.bg + s.theme.neon + s.theme.neonSecondary;
        this.ensurePalette(s.theme);

        const source = s.patternSource;
        const pattern = source?.scheduler.pattern ?? null;
        const bar = Math.floor(s.cycle);

        // --- camera: locked to musical time while playing, coasting otherwise.
        // Tempo scales the approach: 160 BPM material arrives faster than 80.
        this.prevCamZ = this.camZ;
        if (pattern) {
            // The scheduler already includes tempo. Multiplying by BPM here
            // moved existing objects off their onsets whenever tempo changed.
            const target = s.cycle * Z_PER_CYCLE;
            if (!this.camLocked || target < this.camZ || target - this.camZ >= Z_PER_CYCLE * 2) {
                this.heroes.length = 0;
                this.bursts.length = 0;
                this.heroByKey.clear();
                this.lastBar = -1;
                // Re-entering playback: snap. There are no heroes yet and the
                // starfield is uniform, so the jump is invisible.
                this.camZ = target;
                this.prevCamZ = target - 1e-5;
                this.camLocked = true;
            } else {
                this.camZ = target;
            }
        } else {
            this.camLocked = false;
            this.bursts.length = 0;
            this.camZ += dt * IDLE_DRIFT;
        }

        // Rebuild on live edit (each evaluate makes a new handle) or bar line.
        if (pattern && source && (pattern !== this.lastPattern || bar !== this.lastBar || paletteChanged)) {
            const crossedBar = pattern === this.lastPattern && bar !== this.lastBar;
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern, source, bar, s.theme, crossedBar);
        }
        if (!pattern) {
            this.lastPattern = null;
            this.lastBar = -1;
            this.onsetsThisBar = 0;
            this.barBlips.length = 0;
            for (const h of this.heroes) h.seen = false;
            for (const t of this.telltaleList) t.present = false;
        }

        const travelled = this.camZ - this.prevCamZ;
        // A seek or a restart can jump the playhead; don't machine-gun onsets.
        const sane = pattern !== null && travelled > 0 && travelled < Z_PER_CYCLE * 2;

        this.advanceStars(travelled);
        this.fireCrossings(dt, sane);
        this.updateTelltales(dt);
        this.updateWarp(dt, s);

        // --- instruments and atmosphere
        const hits = this.transients.update(dt, s.low, s.mid, s.high);
        // The FFT is a second opinion, not the clock: it fills in when a pattern
        // is silent or the schedule has nothing on this beat.
        if (hits.kick) this.impact = Math.max(this.impact, 0.7);

        this.impact *= Math.exp(-dt * 11);
        this.melodyPulse *= Math.exp(-dt * 5);

        this.clipPeak = Math.max(0, this.clipPeak - dt * 1.5);
        if (s.timeData) {
            let peak = 0;
            const td = s.timeData;
            // Every 4th sample is plenty to catch a clip and a quarter the work.
            for (let i = 0; i < td.length; i += 4) {
                const v = Math.abs(td[i] - 128) / 128;
                if (v > peak) peak = v;
            }
            this.clipPeak = Math.max(peak, this.clipPeak);
        }
    }

    // ---------------------------------------------------------------------
    // Starfield — scenery, never signal. Heroes are the things that differ.
    // ---------------------------------------------------------------------

    private seedStars(): void {
        this.stars = new Float32Array(STAR_COUNT * 5);
        for (let i = 0; i < STAR_COUNT; i++) {
            // Spread evenly through the depth range on the first fill so the
            // field starts full rather than arriving as a wall from the front.
            const z = NEAR + rand01(hash32(i, 7)) * (FAR - NEAR);
            this.placeStar(i, z);
        }
        this.starsReady = true;
    }

    /**
     * Put star `i` at depth `z` somewhere on the glass. Offsets are drawn
     * proportional to the star's own depth, which is what makes screen density
     * uniform from the vanishing point out to the frame.
     */
    private placeStar(i: number, z: number): void {
        const h = hash32(i, this.starSalt);
        const u = rand01(h) * 2.3 - 1.15;
        const v = rand01(hash32(h, 3)) * 2.3 - 1.15;
        const r = rand01(hash32(h, 11));
        const o = i * 5;
        this.stars[o] = u * (this.vw * 0.5) * z / this.focal;
        this.stars[o + 1] = v * (this.vh * 0.5) * z / this.focal;
        this.stars[o + 2] = z;
        // 8% of the field is a magnitude brighter; the rest is a single pixel.
        this.stars[o + 3] = r > 0.92 ? 2 : 1;
        this.stars[o + 4] = r < 0.7 ? 0 : r < 0.9 ? 1 : 2;
    }

    private advanceStars(travelled: number): void {
        if (!this.starsReady) return;
        const span = FAR - NEAR;
        const step = travelled > 0 && travelled < span ? travelled : 0;
        for (let i = 0; i < STAR_COUNT; i++) {
            const o = i * 5;
            let z = this.stars[o + 2] - step;
            if (z < NEAR) {
                // Wrapped past the canopy — recycle it to the back of the field
                // with a fresh bearing so the sky never visibly repeats.
                this.starSalt++;
                z += span;
                this.placeStar(i, z);
                continue;
            }
            this.stars[o + 2] = z;
        }
    }

    // ---------------------------------------------------------------------
    // Schedule
    // ---------------------------------------------------------------------

    private keyOf(h: Hero): string {
        return h.seed + '|' + h.z.toFixed(4);
    }

    /**
     * Query `[bar, bar + LOOKAHEAD)` and reconcile the heroes with it. Objects
     * are keyed by absolute onset, so the same hap seen from two different bars
     * is the same object and keeps its shape, bearing and flash across the bar
     * line — and a live edit re-uses what is already in flight rather than
     * respawning the universe.
     */
    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme, crossedBar: boolean): void {
        pattern.queryCycleViewData(bar, LOOKAHEAD);
        // Fresh view per query — WASM memory growth detaches cached views.
        const data = new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);

        const trackCount = data[0];
        const registryVersion = data[2];
        if (registryVersion !== this.registryVersion) {
            this.registryVersion = registryVersion;
            this.trackNames.fill(undefined);
        }

        this.seenKeys.clear();
        for (const t of this.telltaleList) t.present = false;
        this.barBlips.length = 0;
        this.onsetsThisBar = 0;

        const trackBudget = Math.min(MAX_PER_TRACK, Math.max(1, Math.floor(MAX_HEROES / Math.max(1, trackCount))));
        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];

            let name = this.trackNames[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.trackNames[trackId] = name;
            }

            const track = this.telltaleFor(name);
            track.present = true;
            // Accent recomputed each rebuild so `.color()` edits and theme
            // changes both land. Cheap — a handful of strings per track.
            const pool = theme.accentPool;
            const fallback = pool[track.slot % pool.length];
            const hint = pattern.getTrackColor(trackId);
            const accent = hint !== undefined ? rgbOf(hint, fallback) : fallback;
            track.accent = accent;
            track.accentCss = `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`;

            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            const base = idx;
            let kept = 0;

            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= LOOKAHEAD) continue;

                const absBegin = bar + Math.max(0, begin);
                const z = absBegin * Z_PER_CYCLE;
                const dur = Math.max(0.02, Math.min(end, LOOKAHEAD) - Math.max(0, begin));
                const kind = heroKindFor(name, note, dur);

                // WASM reports query-clipped parts. A known sustain crossing
                // this bar is a continuation, not a new onset at phase zero.
                const continuation = begin === 0 ? this.heroes.find(h =>
                    h.track === track && Object.is(h.note, note) &&
                    h.z < bar * Z_PER_CYCLE && h.z + h.zLen > bar * Z_PER_CYCLE + 1e-4) : undefined;
                if (continuation) {
                    continuation.zLen = (bar + end) * Z_PER_CYCLE - continuation.z;
                    continuation.accent = accent;
                    continuation.accentCss = track.accentCss;
                    this.seenKeys.add(this.keyOf(continuation));
                    kept++;
                    continue;
                }

                // The bar the radar shows is the bar we are in, not the lookahead.
                if (begin >= 0 && begin < 1) {
                    this.onsetsThisBar++;
                    this.barBlips.push({
                        at: begin,
                        radius: blipRadiusFor(kind),
                        css: track.accentCss,
                    });
                }

                // Count the whole current bar even when entering mid-bar.
                // Keep sustains until their end, and recent crossings until fired.
                if ((bar + end) * Z_PER_CYCLE < Math.min(this.camZ - 4, this.prevCamZ)) continue;
                const seed = hash32(track.slot * 977 + (Number.isFinite(note) ? note * 131 : 0), Math.round(absBegin * 4096));
                const key = seed + '|' + z.toFixed(4);
                this.seenKeys.add(key);

                const existing = this.heroByKey.get(key);
                if (existing) {
                    kept++;
                    existing.seen = true;
                    existing.fade = 1;
                    existing.accent = accent;
                    existing.accentCss = track.accentCss;
                    existing.kind = kind;
                    existing.zLen = kind === 'nebula' || kind === 'capital' ? dur * Z_PER_CYCLE : 0;
                    continue;
                }
                if (this.heroes.length >= MAX_HEROES || kept >= trackBudget) continue;
                kept++;

                const hero = this.makeHero(kind, z, seed, note, dur, track, accent);
                this.heroes.push(hero);
                this.heroByKey.set(key, hero);
            }
            idx = base + eventCount * 3;
        }

        // Anything not in this span has been edited away; let it fade rather
        // than pop. `fireCrossings` does the actual removal.
        for (const h of this.heroes) {
            h.seen = this.seenKeys.has(this.keyOf(h)) ||
                (crossedBar && h.z > this.prevCamZ && h.z <= this.camZ);
        }
    }

    private telltaleFor(name: string): Telltale {
        let t = this.telltales.get(name);
        if (t) return t;
        t = {
            name,
            slot: this.nextSlot++,
            accent: [71, 246, 255],
            accentCss: 'rgb(71, 246, 255)',
            activity: 0,
            silent: 0,
            present: true,
            fade: 1,
        };
        this.telltales.set(name, t);
        this.telltaleList.push(t);
        return t;
    }

    /**
     * Build one hap object. The track owns a bearing lane; pitch owns the
     * elevation; the hash decides everything cosmetic, so an object is
     * individual but never twitches between rebuilds.
     */
    private makeHero(
        kind: HeroKind,
        z: number,
        seed: number,
        note: number,
        dur: number,
        track: Telltale,
        accent: [number, number, number],
    ): Hero {
        // Tracks fan left to right in slot order. The jitter is what turns a
        // 16th-note run into a stream down a corridor instead of one point.
        // Stable bearings independent of how many tracks have been parsed.
        const lane = [-0.65, 0.65, -0.9, -0.32, 0.32, 0.9, 0][track.slot % 7];
        const jitter = (rand01(hash32(seed, 41)) - 0.5) * 2 * ((4 * Math.PI) / 180);
        let az = lane * AZ_MAX + jitter;

        let el: number;
        if (Number.isFinite(note)) {
            // The C1-C7 range the piano roll and FOREST DRIVE already use.
            const n = Math.min(96, Math.max(24, note));
            el = EL_LOW + ((n - 24) / 72) * (EL_HIGH - EL_LOW);
        } else {
            el = EL_FLAT + (rand01(hash32(seed, 53)) - 0.5) * 0.06;
        }

        // Hats are peripheral texture — they live out at the frame, never near
        // the nose, or a dense hi-hat part buries everything else on the glass.
        if (kind === 'hat') {
            const side = (seed & 1) === 0 ? -1 : 1;
            az = side * (AZ_MAX * (1.15 + rand01(hash32(seed, 61)) * 0.5));
            el = (rand01(hash32(seed, 67)) - 0.45) * 0.6;
        }

        return {
            kind,
            note,
            z,
            // Duration is retained for continuity; it never stretches the geometry.
            zLen: kind === 'nebula' || kind === 'capital' ? dur * Z_PER_CYCLE : 0,
            wx: Math.tan(az) * REF_Z,
            wy: Math.tan(el) * REF_Z,
            // Only the snare ships cross the view; everything else holds bearing.
            drift: kind === 'snare' ? (rand01(hash32(seed, 71)) - 0.5) * 26 : 0,
            seed,
            accent,
            accentCss: track.accentCss,
            flash: 0,
            destroyed: false,
            fade: 1,
            seen: true,
            track,
        };
    }

    // ---------------------------------------------------------------------
    // Onsets — reaching the intercept plane fires the hit and destroys the target.
    // ---------------------------------------------------------------------

    private fireCrossings(dt: number, sane: boolean): void {
        for (let n = this.heroes.length - 1; n >= 0; n--) {
            const h = this.heroes[n];
            if (sane && h.seen && !h.destroyed && h.z > this.prevCamZ && h.z <= this.camZ) {
                h.flash = 1;
                h.destroyed = true;
                const twin = h.kind === 'kick' || h.kind === 'capital';
                this.bursts.push({wx: h.wx, wy: h.wy, seed: h.seed, css: h.accentCss,
                    age: 0, power: h.kind === 'hat' ? 0.4 : twin ? 1.25 : 0.8, twin});
                if (this.bursts.length > MAX_BURSTS) this.bursts.shift();
                h.track.activity = Math.min(1, h.track.activity + 0.55);
                h.track.silent = 0;
                // Heavy hits also accent the fixed canopy rim.
                if (h.kind === 'kick') this.impact = 1;
                if (h.kind === 'buoy' || h.kind === 'nebula') this.melodyPulse = 1;
            }
            h.flash *= Math.exp(-dt * 7);
            // A bounded crossing avoids long lookaheads drifting targets offscreen.
            if (h.drift !== 0 && !h.destroyed) {
                h.wx = Math.sin((h.z - this.camZ) / Z_PER_CYCLE * 1.7 + (h.seed % 7)) * 17;
            }
            if (!h.seen) h.fade -= dt * 2.5;
            // Drop once safely past the glass, or once faded out ahead of it.
            if (h.z + h.zLen < this.camZ - 4 || h.fade <= 0) {
                this.heroes.splice(n, 1);
                this.heroByKey.delete(this.keyOf(h));
            }
        }
    }

    /**
     * Decay the level bars, age the silence timers, and pick the eight rows the
     * bank has room for — the most recently active, shown in slot order so the
     * bank does not reshuffle while you are reading it.
     */
    private updateTelltales(dt: number): void {
        const k = Math.exp(-dt * 2.5);
        for (let n = this.telltaleList.length - 1; n >= 0; n--) {
            const t = this.telltaleList[n];
            t.activity *= k;
            t.silent += dt;
            if (!t.present) {
                t.fade -= dt * 2.5;
                if (t.fade <= 0) {
                    this.telltaleList.splice(n, 1);
                    this.telltales.delete(t.name);
                }
            } else if (t.fade < 1) {
                t.fade = Math.min(1, t.fade + dt * 4);
            }
        }

        const rows = this.telltaleList.slice();
        if (rows.length > 8) {
            rows.sort((a, b) => a.silent - b.silent);
            rows.length = 8;
        }
        rows.sort((a, b) => a.slot - b.slot);
        this.visibleRows = rows;
    }

    /** The DRIVE arc blends scheduled density with measured band energy. */
    private updateWarp(dt: number, s: VizServices): void {
        const density = clamp01(this.onsetsThisBar / DENSITY_FULL);
        const energy = 0.5 * s.low + 0.35 * s.mid + 0.15 * s.high;
        const target = clamp01(0.65 * density + 0.35 * energy);

        this.warp += (target - this.warp) * (1 - Math.exp(-dt * 1.8));
    }

    /** Re-derive the mixes only when the theme actually changes. */
    private ensurePalette(t: Theme): void {
        const key = t.bg + t.neon + t.neonSecondary;
        if (key === this.themeKey) return;
        this.themeKey = key;
        // A blue-black glass bed, lightly tinted by the app palette.
        const [r, g, b] = t.bgRgb;
        this.spaceCss = `rgb(${Math.round(r * 0.4 + 5)}, ${Math.round(g * 0.4 + 10)}, ${Math.round(b * 0.4 + 16)})`;
    }

    // ---------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);
        ctx.lineJoin = 'miter';
        ctx.lineCap = 'butt';
        ctx.fillStyle = HULL_LOW;
        ctx.fillRect(0, 0, this.vw, this.vh);
        ctx.save();
        this.pathCanopy(ctx);
        ctx.clip();
        ctx.fillStyle = this.spaceCss;
        ctx.fillRect(0, 0, this.vw, this.vh);
        this.drawStars(ctx);
        this.drawFlightGrid(ctx);
        this.buildDrawList();
        for (const h of this.drawList) this.drawHero(ctx, h);
        this.drawWeapons(ctx);
        this.drawLasers(ctx);
        this.drawBursts(ctx);
        this.drawNavigation(ctx, s);
        this.drawReticle(ctx);
        ctx.restore();
        this.drawHull(ctx);
        this.drawDash(ctx, s);
        ctx.restore();
    }

    private pathCanopy(ctx: CanvasRenderingContext2D): void {
        const p = this.frame.poly;
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
        ctx.closePath();
    }

    /** Focal length, with the kick's field-of-view bump folded in. */
    private focalNow(): number {
        return this.focal * (1 + 0.04 * this.impact);
    }

    /**
     * Streaks are simply last position to this position — no textures, and it
     * stays honest at every speed because it *is* the motion.
     */
    private drawStars(ctx: CanvasRenderingContext2D): void {
        if (!this.starsReady) return;
        const {vpX, vpY} = this.frame;
        const fl = this.focalNow();
        // At rest a star is a dot; under warp it stretches toward the frame.
        const trail = (1 + this.warp * 9) * Math.max(0.35, this.camZ - this.prevCamZ);

        for (let c = 0; c < STAR_COLORS.length; c++) {
            ctx.fillStyle = STAR_COLORS[c];
            ctx.strokeStyle = STAR_COLORS[c];
            ctx.beginPath();
            for (let i = 0; i < STAR_COUNT; i++) {
                const o = i * 5;
                if (this.stars[o + 4] !== c) continue;
                const z = this.stars[o + 2];
                const wx = this.stars[o];
                const wy = this.stars[o + 1];
                const k = fl / z;
                const x = vpX + wx * k;
                const y = vpY - wy * k;
                if (x < -40 || x > this.vw + 40 || y < -40 || y > this.vh + 40) continue;

                const size = this.stars[o + 3];
                const back = z + trail;
                const k2 = fl / back;
                const x2 = vpX + wx * k2;
                const y2 = vpY - wy * k2;
                const dx = x - x2;
                const dy = y - y2;
                if (dx * dx + dy * dy > 4) {
                    ctx.moveTo(x2, y2);
                    ctx.lineTo(x, y);
                } else {
                    ctx.rect(x, y, size, size);
                }
            }
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.48;
            ctx.fill();
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    /** Heroes in range, far to near — painter's algorithm, reusing one array. */
    private buildDrawList(): void {
        const list = this.drawList;
        list.length = 0;
        for (const h of this.heroes) {
            const depth = h.z - this.camZ;
            if (!h.destroyed && depth >= 0 && depth < FAR) list.push(h);
        }
        list.sort((a, b) => b.z - a.z);
    }

    /** Shared projection for targets, laser endpoints and impact fragments. */
    private projectTarget(wx: number, wy: number, depth: number): {x: number; y: number; k: number} {
        const f = this.frame;
        const fx = Math.min(this.focalNow(), this.vw * 0.52);
        const fy = Math.min(this.focalNow(), (f.sillY - f.poly[0][1]) * 0.85);
        return {x: f.vpX + wx * fx / depth, y: f.vpY - wy * fy / depth, k: Math.min(fx, fy) / depth};
    }

    private drawHero(ctx: CanvasRenderingContext2D, h: Hero): void {
        const depth = Math.max(0, h.z - this.camZ);
        const {x, y, k} = this.projectTarget(h.wx, h.wy, depth + INTERCEPT_Z);
        // Everything dissolves into the distance rather than popping in at FAR.
        const far = 1 - clamp01((depth - FAR * 0.55) / (FAR * 0.45));
        const a = h.fade * far;
        if (a <= 0.01) return;

        switch (h.kind) {
            case 'kick': this.drawArmored(ctx, h, x, y, k, a); break;
            case 'hat': this.drawHat(ctx, h, x, y, depth, a); break;
            case 'snare': this.drawShip(ctx, h, x, y, k, a); break;
            case 'perc': this.drawAsteroid(ctx, h, x, y, k, a); break;
            case 'buoy': this.drawBuoy(ctx, h, x, y, k, a); break;
            case 'nebula': this.drawNebula(ctx, h, x, y, k, a); break;
            case 'capital': this.drawCapital(ctx, h, x, y, k, a); break;
        }
    }

    /** Small percussion targets must read as targets, not background stars. */
    private drawHat(
        ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, depth: number, a: number,
    ): void {
        const near = clamp01(1 - depth / FAR);
        const r = Math.max(3.5, (3 + near * 2) * this.sc);
        ctx.save();
        ctx.globalAlpha = a * (0.5 + near * 0.4);
        ctx.strokeStyle = h.accentCss;
        ctx.fillStyle = this.spaceCss;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x, y - r); ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = h.accentCss;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        ctx.restore();
    }

    /** A snare is traffic — something that crosses the view and you track it. */
    private drawShip(
        ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number,
    ): void {
        const L = Math.min(34 * this.sc, 1.6 * k);
        if (L < 2) return;
        const w = L * 0.62;
        ctx.save();
        ctx.translate(x, y);
        // Banked into its own crossing velocity — a craft under power, not a
        // sprite being translated across the frame.
        ctx.rotate(Math.atan2(h.drift, 30) * 0.8);
        ctx.globalAlpha = a;

        ctx.beginPath();
        ctx.moveTo(L * 0.62, 0);
        ctx.lineTo(-L * 0.3, -w);
        ctx.lineTo(-L * 0.52, -w * 0.5);
        ctx.lineTo(-L * 0.38, 0);
        ctx.lineTo(-L * 0.52, w * 0.5);
        ctx.lineTo(-L * 0.3, w);
        ctx.closePath();
        ctx.fillStyle = CAPITAL_HULL;
        ctx.fill();
        ctx.strokeStyle = h.accentCss;
        ctx.lineWidth = 1.25;
        ctx.lineJoin = 'miter';
        ctx.globalAlpha = a * 0.85;
        ctx.stroke();

        // Running lights remain visible as the target approaches.
        ctx.fillStyle = h.accentCss;
        ctx.fillRect(-L * 0.3 - 1, -w - 1, 2, 2);
        ctx.fillRect(-L * 0.3 - 1, w - 1, 2, 2);
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    private drawAsteroid(
        ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number,
    ): void {
        const r = Math.min(46 * this.sc, 1.6 * k);
        if (r < 1) return;
        const verts = 3 + (h.seed % 3);
        const spin = this.time * (0.2 + rand01(hash32(h.seed, 83)) * 0.5);
        ctx.globalAlpha = a;
        ctx.beginPath();
        for (let i = 0; i < verts; i++) {
            const ang = spin + (i / verts) * TAU;
            const rr = r * (0.6 + rand01(hash32(h.seed, i * 13 + 5)) * 0.55);
            const px = x + Math.cos(ang) * rr;
            const py = y + Math.sin(ang) * rr;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        const [rr, gg, bb] = h.accent;
        ctx.fillStyle = `rgb(${Math.round(rr * 0.22)}, ${Math.round(gg * 0.22)}, ${Math.round(bb * 0.24)})`;
        ctx.fill();
        ctx.strokeStyle = h.accentCss;
        ctx.globalAlpha = a * (0.7 + h.flash * 0.3);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    /** A pitched note: the thing a musician actually watches in the glass. */
    private drawBuoy(
        ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number,
    ): void {
        const r = Math.min(34 * this.sc, (0.55 + h.flash * 0.5) * k * 0.65);
        if (r < 0.6) return;
        ctx.globalAlpha = a * (0.55 + h.flash * 0.45);
        ctx.fillStyle = h.accentCss;
        // Hollow navigation diamond with a small solid core.
        ctx.strokeStyle = h.accentCss;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.8);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r * 1.8);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.stroke();
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.globalAlpha = 1;
    }

    /** A held high note is a set of flat orbital contours. */
    private drawNebula(
        ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number,
    ): void {
        const r = Math.min(38 * this.sc, k * 2.2);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.38);
        ctx.strokeStyle = h.accentCss;
        ctx.fillStyle = h.accentCss;
        ctx.lineWidth = 1.25;
        for (let ring = 0; ring < 3; ring++) {
            ctx.beginPath();
            ctx.ellipse(0, 0, r * (1 + ring * 0.25), r * (1 + ring * 0.25), 0, 0, TAU);
            ctx.globalAlpha = a * 0.65 / (1 + ring * 0.4);
            ctx.stroke();
        }
        ctx.globalAlpha = a * 0.07;
        ctx.fill();
        ctx.restore();
    }

    /** Compact cruiser: duration no longer extrudes a ribbon across the glass. */
    private drawCapital(ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number): void {
        const r = Math.min(54 * this.sc, k * 3.4);
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha = a;
        ctx.fillStyle = CAPITAL_HULL;
        ctx.strokeStyle = h.accentCss;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.65); ctx.lineTo(r, r * 0.25);
        ctx.lineTo(r * 0.7, r * 0.55); ctx.lineTo(-r * 0.7, r * 0.55);
        ctx.lineTo(-r, r * 0.25); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.65); ctx.lineTo(0, r * 0.3);
        ctx.moveTo(-r, r * 0.25); ctx.lineTo(0, r * 0.3); ctx.lineTo(r, r * 0.25);
        ctx.moveTo(-r * 0.35, -r * 0.2); ctx.lineTo(r * 0.35, -r * 0.2);
        ctx.stroke();
        ctx.fillStyle = h.accentCss;
        for (const t of [-0.5, 0, 0.5]) ctx.fillRect(r * t - 2, r * 0.4, 4, 2);
        ctx.restore();
    }

    private drawArmored(ctx: CanvasRenderingContext2D, h: Hero, x: number, y: number, k: number, a: number): void {
        const r = Math.min(34 * this.sc, k * 2.4);
        ctx.save(); ctx.translate(x, y);
        ctx.strokeStyle = h.accentCss; ctx.fillStyle = CAPITAL_HULL;
        ctx.globalAlpha = a; ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = i * TAU / 6;
            const px = Math.cos(angle) * r, py = Math.sin(angle) * r;
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, TAU); ctx.stroke();
        ctx.fillStyle = h.accentCss; ctx.fillRect(-2, -2, 4, 4);
        ctx.restore();
    }

    private muzzle(side: number): {x: number; y: number} {
        return {x: this.vw * (side < 0 ? 0.18 : 0.82), y: this.frame.sillY - 28 * this.sc};
    }

    /** Two visible forward cannons anchor the shots to the player's ship. */
    private drawWeapons(ctx: CanvasRenderingContext2D): void {
        for (const side of [-1, 1]) {
            const {x, y} = this.muzzle(side);
            const size = 22 * this.sc;
            ctx.save(); ctx.translate(x, y);
            ctx.rotate(Math.atan2(this.frame.vpY - y, this.frame.vpX - x) + Math.PI / 2);
            ctx.fillStyle = HULL; ctx.strokeStyle = HULL_HI; ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.lineTo(7, size * 0.8);
            ctx.lineTo(14, size * 1.1); ctx.lineTo(18, size * 3);
            ctx.lineTo(-18, size * 3); ctx.lineTo(-14, size * 1.1);
            ctx.lineTo(-7, size * 0.8); ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.strokeStyle = CYAN;
            ctx.beginPath(); ctx.moveTo(-3, 2); ctx.lineTo(3, 2); ctx.stroke();
            for (let i = 0; i < 3; i++) {
                ctx.strokeStyle = HULL_HI;
                ctx.beginPath(); ctx.moveTo(-8, size * (1.3 + i * 0.35));
                ctx.lineTo(8, size * (1.3 + i * 0.35)); ctx.stroke();
            }
            ctx.restore();
        }
    }

    /** Cycle-based travel catches the note even if BPM changes mid-shot. */
    private laserProgress(h: Hero): number {
        if (!this.camLocked || !h.seen || h.destroyed) return -1;
        const remaining = (h.z - this.camZ) / Z_PER_CYCLE;
        const lead = LASER_FLIGHT_SECONDS * currentBpm() / 240;
        return remaining >= 0 && remaining <= lead ? 1 - remaining / lead : -1;
    }

    private bolt(ctx: CanvasRenderingContext2D, x: number, y: number, side: number,
        progress: number, css: string, alpha: number, contact = false): void {
        const muzzle = this.muzzle(side);
        const head = progress;
        const tail = contact ? 0 : Math.max(0, head - 0.28);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = css; ctx.lineWidth = 3 * this.sc;
        ctx.beginPath();
        ctx.moveTo(muzzle.x + (x - muzzle.x) * tail, muzzle.y + (y - muzzle.y) * tail);
        ctx.lineTo(muzzle.x + (x - muzzle.x) * head, muzzle.y + (y - muzzle.y) * head);
        ctx.stroke();
        ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.7, this.sc);
        ctx.stroke();
        if (progress < 0.35 || contact) {
            ctx.fillStyle = css;
            ctx.beginPath();
            ctx.moveTo(muzzle.x, muzzle.y - 8 * this.sc);
            ctx.lineTo(muzzle.x + 4 * this.sc, muzzle.y);
            ctx.lineTo(muzzle.x, muzzle.y + 8 * this.sc);
            ctx.lineTo(muzzle.x - 4 * this.sc, muzzle.y); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
    }

    private drawLasers(ctx: CanvasRenderingContext2D): void {
        let count = 0;
        // Nearest targets first, with a hard ceiling for pathological patterns.
        for (let i = this.drawList.length - 1; i >= 0 && count < MAX_LASERS; i--) {
            const h = this.drawList[i];
            const progress = this.laserProgress(h);
            if (progress < 0) continue;
            const {x, y} = this.projectTarget(h.wx, h.wy, INTERCEPT_Z + h.z - this.camZ);
            // Draw acquisition marks after every target: the destination stays
            // legible even when another object overlaps its small silhouette.
            const r = Math.max(8, 11 * this.sc);
            const corner = r * 0.4;
            ctx.save();
            ctx.strokeStyle = h.accentCss;
            ctx.globalAlpha = h.fade * 0.8;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                ctx.moveTo(x + sx * (r - corner), y + sy * r);
                ctx.lineTo(x + sx * r, y + sy * r);
                ctx.lineTo(x + sx * r, y + sy * (r - corner));
            }
            ctx.stroke();
            ctx.restore();
            const side = h.seed & 1 ? -1 : 1;
            this.bolt(ctx, x, y, side, progress, h.accentCss, h.kind === 'hat' ? 0.45 : 0.9);
            if (h.kind === 'kick' || h.kind === 'capital') this.bolt(ctx, x, y, -side, progress, h.accentCss, 0.9);
            count++;
        }
    }

    /** Brief contact beams, expanding shock rings, and deterministic vector shards. */
    private drawBursts(ctx: CanvasRenderingContext2D): void {
        for (const b of this.bursts) {
            const {x, y} = this.projectTarget(b.wx, b.wy, INTERCEPT_Z);
            const t = b.age / BURST_LIFETIME;
            const fade = (1 - t) * (1 - t);
            const size = (10 + 62 * t) * b.power * this.sc;
            if (b.age < 0.075) {
                const alpha = (1 - b.age / 0.075) * 0.85;
                this.bolt(ctx, x, y, b.seed & 1 ? -1 : 1, 1, b.css, alpha, true);
                if (b.twin) this.bolt(ctx, x, y, b.seed & 1 ? 1 : -1, 1, b.css, alpha, true);
            }
            ctx.save(); ctx.translate(x, y);
            ctx.strokeStyle = b.css; ctx.fillStyle = b.css;
            ctx.globalAlpha = fade * 0.85; ctx.lineWidth = 1.25;
            ctx.beginPath(); ctx.arc(0, 0, size, 0, TAU); ctx.stroke();
            const shards = b.power < 0.5 ? 4 : 8;
            for (let i = 0; i < shards; i++) {
                const a = i * TAU / shards + rand01(hash32(b.seed, i)) * 0.6;
                const r = size * (0.7 + rand01(hash32(b.seed, i + 17)) * 0.8);
                const px = Math.cos(a) * r, py = Math.sin(a) * r;
                const length = (3 + b.power * 5) * this.sc * (1 - t * 0.6);
                ctx.beginPath();
                ctx.moveTo(px, py);
                ctx.lineTo(px + Math.cos(a + 0.7) * length, py + Math.sin(a + 0.7) * length);
                ctx.lineTo(px + Math.cos(a) * length * 2, py + Math.sin(a) * length * 2);
                ctx.closePath(); ctx.stroke();
            }
            if (b.age < 0.12) {
                ctx.globalAlpha = (1 - b.age / 0.12) * 0.9;
                ctx.fillStyle = INK;
                const r = (3 + b.power * 5) * this.sc;
                ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, 0);
                ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath(); ctx.fill();
            }
            ctx.restore();
        }
    }

    /** Drafting guides make depth legible without filling the glass with haze. */
    private drawFlightGrid(ctx: CanvasRenderingContext2D): void {
        const {vpX, vpY, sillY} = this.frame;
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.1;
        ctx.beginPath();
        for (const lane of [-1, -0.5, 0.5, 1]) {
            ctx.moveTo(vpX + lane * 18, vpY + 16);
            ctx.lineTo(vpX + lane * this.vw * 0.8, sillY);
        }
        ctx.stroke();
        ctx.setLineDash([3, 9]);
        ctx.beginPath();
        ctx.moveTo(0, vpY);
        ctx.lineTo(this.vw, vpY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

    }

    private drawNavigation(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.vw < 600 || this.vh < 420) return;
        const {vpX, vpY} = this.frame;
        const x = this.vw * 0.16;
        const y = this.frame.poly[0][1] + 42;
        this.label(ctx, 'FLIGHT / SEQUENCER', x, y, MUTED, 10);
        this.label(ctx, this.camLocked ? 'PATTERN LOCK' : 'FREE FLIGHT', x, y + 20, CYAN, 12);
        this.label(ctx, 'LOOK AHEAD  /  02 CYC', this.vw - x, y, MUTED, 10, 'right');
        this.label(ctx, `${String(this.onsetsThisBar).padStart(2, '0')} EVENTS / CYCLE`, this.vw - x, y + 20, INK, 12, 'right');
        // Fixed attitude marks bracket the navigation reticle.
        ctx.strokeStyle = CYAN;
        ctx.globalAlpha = 0.35;
        for (let n = -2; n <= 2; n++) {
            const yy = vpY + n * 27 * this.sc;
            const xx = vpX + Math.min(170, this.vw * 0.17);
            ctx.beginPath();
            ctx.moveTo(xx, yy); ctx.lineTo(xx + (n === 0 ? 22 : 12), yy);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        this.label(ctx, 'CYCLE', vpX, vpY + 70 * this.sc, MUTED, 9, 'center');
        this.label(ctx, this.camLocked ? s.cycle.toFixed(2).padStart(6, '0') : 'STANDBY', vpX, vpY + 88 * this.sc, INK, 12, 'center');
    }

    private drawReticle(ctx: CanvasRenderingContext2D): void {
        const {vpX: x, vpY: y} = this.frame;
        const r = 28 * this.sc;
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1.25;
        ctx.globalAlpha = 0.7 + this.melodyPulse * 0.3;
        ctx.beginPath();
        ctx.moveTo(x - r * 1.8, y); ctx.lineTo(x - r * 0.6, y);
        ctx.lineTo(x - r * 0.3, y + r * 0.3);
        ctx.moveTo(x + r * 1.8, y); ctx.lineTo(x + r * 0.6, y);
        ctx.lineTo(x + r * 0.3, y + r * 0.3);
        ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x, y - r * 0.85);
        ctx.moveTo(x, y + r * 0.8); ctx.lineTo(x, y + r * 1.1);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 0.25;
        for (let i = 0; i < 4; i++) {
            ctx.beginPath(); ctx.arc(x, y, r, i * TAU / 4 + 0.18, (i + 1) * TAU / 4 - 0.18); ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
        color = MUTED, size = 10, align: CanvasTextAlign = 'left'): void {
        ctx.fillStyle = color;
        ctx.font = `${size}px ${FONT}`;
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);
    }

    private drawHull(ctx: CanvasRenderingContext2D): void {
        const {sillY, poly} = this.frame;
        ctx.strokeStyle = HULL;
        ctx.lineWidth = 12;
        this.pathCanopy(ctx); ctx.stroke();
        ctx.strokeStyle = HULL_HI;
        ctx.lineWidth = 1;
        this.pathCanopy(ctx); ctx.stroke();
        // Structural corner plates: flat facets, a precise edge, no bevel blur.
        for (const side of [-1, 1]) {
            ctx.save();
            ctx.translate(side < 0 ? 0 : this.vw, 0);
            ctx.scale(side < 0 ? 1 : -1, 1);
            const inset = poly[7][0];
            const y = poly[7][1];
            ctx.fillStyle = HULL;
            ctx.beginPath();
            ctx.moveTo(inset - 6, y - 7); ctx.lineTo(inset + 24, y + 12);
            ctx.lineTo(inset + 24, y + 72); ctx.lineTo(inset - 6, y + 96);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = HULL_HI; ctx.lineWidth = 1; ctx.stroke();
            ctx.strokeStyle = CYAN;
            ctx.beginPath(); ctx.moveTo(inset + 9, y + 20); ctx.lineTo(inset + 9, y + 52); ctx.stroke();
            ctx.restore();
        }
        ctx.strokeStyle = CYAN;
        ctx.globalAlpha = 0.3 + this.impact * 0.65;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(poly[5][0] + 12, sillY); ctx.lineTo(this.vw * 0.4, sillY);
        ctx.moveTo(this.vw * 0.6, sillY); ctx.lineTo(poly[4][0] - 12, sillY);
        ctx.stroke(); ctx.globalAlpha = 1;

        const header = Math.min(29, poly[0][1] * 0.48);
        this.label(ctx, 'C / 07', 24, header, CYAN, 11);
        if (this.vw > 480) this.label(ctx, 'COCKPIT', 102, header, INK, 11);
        if (this.vw > 760) this.label(ctx, 'AUDIO NAVIGATION SYSTEM', this.vw / 2, header, MUTED, 10, 'center');
        this.label(ctx, this.camLocked ? '●  SYNC / LIVE' : '○  STANDBY', this.vw - 24, header,
            this.camLocked ? CYAN : MUTED, 10, 'right');
        if (this.vh > 400) this.label(ctx, this.warp > 0.55 ? 'HIGH DENSITY' : 'CRUISE', this.vw / 2, sillY, AMBER, 9, 'center');
        // Keep the clip indicator factual: this is a signal-peak warning.
        if (this.clipPeak > 0.95) this.label(ctx, 'PEAK', this.vw - 24, header + 17, WARN_RED, 9, 'right');
    }

    private panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, num: string): void {
        ctx.fillStyle = COAMING;
        ctx.strokeStyle = HULL_HI;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 7, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h - 7);
        ctx.lineTo(x + w - 7, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + 7);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        this.label(ctx, title, x + 12, y + 17, MUTED, 9);
        this.label(ctx, num, x + w - 12, y + 17, CYAN, 9, 'right');
        ctx.strokeStyle = DEAD_SEG;
        ctx.beginPath(); ctx.moveTo(x + 12, y + 31); ctx.lineTo(x + w - 12, y + 31); ctx.stroke();
    }

    private drawDash(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const pad = Math.max(10, Math.min(24, this.vw * 0.02));
        const gap = 10;
        const y = this.frame.sillY + 16;
        const h = this.vh - y - 16;
        if (h < 54 || this.vw < 220) return;
        const width = this.vw - pad * 2;
        const full = this.vw >= 860;
        const scan = this.vw >= 580;
        const bankW = (width - gap * (full ? 3 : scan ? 2 : 1)) * (full ? 0.34 : scan ? 0.43 : 0.55);
        const transportW = full ? (width - gap * 3) * 0.23 : scan ? (width - gap * 2) * 0.3 : width - gap - bankW;
        this.panel(ctx, pad, y, bankW, h, 'SIGNAL BANK', String(this.telltaleList.length).padStart(2, '0'));
        this.drawTelltales(ctx, pad + 12, y + 42, bankW - 24, h - 50);
        let x = pad + bankW + gap;
        this.panel(ctx, x, y, transportW, h, 'TRANSPORT', '01');
        this.drawTransport(ctx, s, x, y + 36, transportW, h - 40);
        x += transportW + gap;
        if (full) {
            const bandsW = (width - gap * 3) * 0.2;
            this.panel(ctx, x, y, bandsW, h, 'BAND ENERGY', '02');
            this.drawBands(ctx, s, x + 14, y + 45, bandsW - 28, h - 56);
            x += bandsW + gap;
        }
        if (scan) {
            const scanW = this.vw - pad - x;
            this.panel(ctx, x, y, scanW, h, 'CYCLE SCAN', '03');
            const r = Math.min((scanW - 36) / 2, (h - 48) / 2);
            if (r > 8) this.drawScan(ctx, s, x + scanW / 2, y + 37 + (h - 42) / 2, r);
        }
    }

    private drawTelltales(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
        if (this.visibleRows.length === 0) {
            this.label(ctx, 'AWAITING SIGNAL', x, y + 12, MUTED, Math.min(10, w / 10));
            if (h > 56 && w > 180) this.label(ctx, 'Play a pattern to navigate', x, y + 34, MUTED, 9);
            return;
        }
        const count = Math.min(8, Math.max(1, Math.floor(h / 16)));
        const rows = this.visibleRows.slice(0, count);
        const rowH = Math.min(24, h / rows.length);
        const nameW = Math.min(w * 0.43, 118);
        const segW = Math.max(1, (w - nameW - 28) / 12 - 2);
        rows.forEach((t, i) => {
            const yy = y + i * rowH + rowH * 0.5;
            ctx.globalAlpha = t.fade;
            ctx.fillStyle = t.accentCss;
            ctx.fillRect(x, yy - 4, 3, 8);
            const maxChars = Math.max(2, Math.floor((nameW - 12) / 6));
            const name = t.name.length > maxChars ? t.name.slice(0, maxChars - 1) + '…' : t.name;
            this.label(ctx, name.toUpperCase(), x + 10, yy, INK, 10);
            const lit = Math.round(Math.sqrt(clamp01(t.activity)) * 12);
            for (let j = 0; j < 12; j++) {
                ctx.fillStyle = j < lit ? t.accentCss : DEAD_SEG;
                ctx.fillRect(x + nameW + j * (segW + 2), yy - 3, segW, 6);
            }
            // These are scheduled onset envelopes, not measured channel VUs.
            this.label(ctx, t.activity > 0.08 ? '●' : '·', x + w - 2, yy, t.activity > 0.08 ? t.accentCss : MUTED, 10, 'right');
        });
        ctx.globalAlpha = 1;
        if (this.telltaleList.length > count && h > 32) {
            this.label(ctx, `+${this.telltaleList.length - count}`, x + w, y - 8, MUTED, 8, 'right');
        }
    }

    private drawTransport(ctx: CanvasRenderingContext2D, s: VizServices, x: number, y: number, w: number, h: number): void {
        if (h < 38) return;
        const compact = h < 105 || w < 150;
        const cx = x + w / 2;
        if (!compact) {
            const r = Math.min(w * 0.34, h * 0.43);
            const cy = y + h * 0.52;
            const start = Math.PI * 0.82;
            const sweep = Math.PI * 1.36;
            ctx.strokeStyle = DEAD_SEG;
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(cx, cy, r, start, start + sweep); ctx.stroke();
            ctx.strokeStyle = CYAN;
            ctx.beginPath(); ctx.arc(cx, cy, r, start, start + sweep * this.warp); ctx.stroke();
            ctx.strokeStyle = MUTED; ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i <= 20; i++) {
                const a = start + sweep * i / 20;
                const r0 = r + 5;
                const r1 = r0 + (i % 5 === 0 ? 5 : 2);
                ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
                ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
            }
            ctx.stroke();
        }
        this.label(ctx, String(Math.round(currentBpm())), cx, y + h * 0.43, INK, Math.min(34, h * 0.35, w * 0.23), 'center');
        this.label(ctx, 'BPM', cx, y + h * 0.43 + Math.min(26, h * 0.26), AMBER, 9, 'center');
        if (!compact) this.label(ctx, `DRIVE ${Math.round(this.warp * 100).toString().padStart(2, '0')}`, cx, y + h - 25, MUTED, 8, 'center');
        if (h > 82) {
            const step = (w - 32) / 4;
            const beat = Math.floor((s.cycle % 1) * 4);
            for (let i = 0; i < 4; i++) {
                ctx.fillStyle = this.camLocked && i === beat ? CYAN : DEAD_SEG;
                ctx.fillRect(x + 16 + i * step, y + h - 11, step - 4, 3);
            }
        }
    }

    private drawBands(ctx: CanvasRenderingContext2D, s: VizServices, x: number, y: number, w: number, h: number): void {
        const bands: Array<[string, number, string]> = [['LOW', s.low, AMBER], ['MID', s.mid, CYAN], ['HIGH', s.high, INK]];
        const row = h / 3;
        bands.forEach(([name, value, color], i) => {
            const yy = y + row * i;
            this.label(ctx, name, x, yy + 7, MUTED, 9);
            this.label(ctx, String(Math.round(clamp01(value) * 100)).padStart(2, '0'), x + w, yy + 7, color, 10, 'right');
            const bw = (w - 22) / 12;
            for (let j = 0; j < 12; j++) {
                ctx.fillStyle = j < Math.round(clamp01(value) * 12) ? color : DEAD_SEG;
                ctx.fillRect(x + j * (bw + 2), yy + Math.min(22, row * 0.65), bw, Math.min(7, row * 0.15));
            }
        });
    }

    /** Draw directly at display resolution: crisp at every size and DPR. */
    private drawScan(ctx: CanvasRenderingContext2D, s: VizServices, cx: number, cy: number, r: number): void {
        const phase = this.camLocked ? s.cycle - Math.floor(s.cycle) : 0;
        ctx.save();
        ctx.strokeStyle = HULL_HI; ctx.lineWidth = 1;
        for (const ring of [0.35, 0.68, 1]) {
            ctx.beginPath(); ctx.arc(cx, cy, r * ring, 0, TAU); ctx.stroke();
        }
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.stroke(); ctx.setLineDash([]);
        for (const b of this.barBlips) {
            const a = b.at * TAU - Math.PI / 2;
            const rr = r * (0.2 + b.radius * 0.72);
            const age = (phase - b.at + 1) % 1;
            ctx.globalAlpha = 0.25 + 0.75 * Math.exp(-age * 5);
            ctx.fillStyle = b.css;
            const x = cx + Math.cos(a) * rr;
            const y = cy + Math.sin(a) * rr;
            ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
        ctx.globalAlpha = 1;
        if (this.camLocked) {
            const a = phase * TAU - Math.PI / 2;
            ctx.strokeStyle = CYAN;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.stroke();
        }
        ctx.fillStyle = CYAN; ctx.fillRect(cx - 2, cy - 2, 4, 4);
        ctx.restore();
    }
}

export const cockpitDef: VizModeDef = {
    id: 'cockpit',
    name: 'COCKPIT',
    create: () => new CockpitMode(),
};
