/**
 * MATRIX RAIN — glyph streams on a persistent phosphor layer, one stream per
 * scheduled note.
 *
 *   lane          → each track owns an equal band of columns (in track
 *                   order); pitched notes sit by pitch within the band,
 *                   drums hash to a column. Small track labels head each band.
 *   onset         → a stream spawns exactly on the hap, in the track accent
 *                   (the theme's green for FFT and idle streams).
 *   duration      → longer notes fall slower and further; hats are quick.
 *   activity      → glyph brightness follows the track's onset envelope.
 *   no pattern    → FFT transients spawn streams in kick / snare / hat
 *                   thirds of the screen.
 *   quiet         → a sparse, slow drizzle so the screen never goes blank.
 *
 * The layer is opaque and faded by painting translucent bg over it, so trails
 * converge to exactly the background colour. Streams live in normalized
 * coordinates and the layer is rescaled on resize, so a resize never restarts
 * the rain. Layer lives in device pixels.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import {
    MONO_FONT, SeededRandom, TransientDetector, alphaRamp, clamp01, drawLabel, hash32, mixRgb, rampAt, rand01,
} from '../util.js';

/** Glyph pool — katakana + digits + latin, pre-split so picking never slices. */
const RAIN_GLYPHS = Array.from(
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEFGHJKLMNPQRSTUVWXYZ$+*:;.<>=');

const MAX_STREAMS = 192;
/** Grid rows: ~16 px cells, capped so a 4K stage gets bigger glyphs, not more. */
const MIN_ROWS = 8;
const MAX_ROWS = 60;
const CELL_TARGET = 16;
/** Trail decay rate (1/s); applied in chunks of at least MIN_FADE_STEP so
 *  8-bit rounding can't leave a permanent ghost of old glyphs. */
const TRAIL_DECAY = 2.0;
const MIN_FADE_STEP = 0.08;
/** Seconds without a spawn before the idle drizzle starts, and its interval. */
const DRIZZLE_AFTER = 0.8;
const DRIZZLE_EVERY = 0.45;

/** Base fall speed (screen heights/s) by instrument family. */
const FAMILY_SPEED = {kick: 0.85, snare: 1.0, hat: 1.35, perc: 0.9} as const;
const PITCHED_SPEED = 0.7;

interface RainColor {
    body: string[];
    head: string[];
}

interface RainStream {
    alive: boolean;
    /** Column centre as a fraction of the width. */
    x: number;
    /** Head position as a fraction of the height. */
    y: number;
    /** Screen heights per second. */
    speed: number;
    /** Heights left to travel before the stream stops. */
    remaining: number;
    color: RainColor;
    /** Owning track — brightness follows its activity; null for FFT/idle. */
    track: VizTrack | null;
    /** Brightness when not track-driven (0..1). */
    level: number;
}

class MatrixRainMode implements VizMode {
    private layer: HTMLCanvasElement | null = null;
    private layerCtx: CanvasRenderingContext2D | null = null;
    private cellW = 0;
    private cellH = 0;
    private cols = 0;
    private rows = 0;
    private bgCss = '#05060a';
    private labelColor = '';
    private labelSize = 10;

    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    private readonly rng = new SeededRandom(0x6d61);
    private readonly streams: RainStream[] = [];
    private cursor = 0;
    private readonly colors = new Map<string, RainColor>();
    private base: RainColor = {body: [], head: []};
    private pendingFade = 0;
    private sinceSpawn = 0;
    private drizzleClock = 0;
    private drizzleCount = 0;
    private bar = 0;
    private laneCount = 0;

    constructor() {
        for (let i = 0; i < MAX_STREAMS; i++) {
            this.streams.push({
                alive: false, x: 0, y: 0, speed: 0, remaining: 0,
                color: this.base, track: null, level: 0,
            });
        }
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const lanes = this.tracks.tracks;
        const lane = Math.max(0, lanes.indexOf(track));
        const n = Math.max(1, lanes.length);
        const note = track.notes[e];
        const h = hash32(track.slot * 131 + e, this.bar);
        // Pitched: low notes left of the band, high notes right, with a
        // little jitter so repeated notes don't share one column.
        const within = Number.isFinite(note)
            ? clamp01((note - 36) / 60) * 0.8 + 0.1 + (rand01(h) - 0.5) * 0.08
            : rand01(h);
        const dur = Math.max(0, track.ends[e] - track.begins[e]);
        const base = Number.isFinite(note) ? PITCHED_SPEED : FAMILY_SPEED[instrumentFamily(track.name)];
        this.spawn(
            (lane + clamp01(within)) / n,
            base / (0.7 + dur * 1.5) * (0.9 + rand01(h >>> 3) * 0.2),
            Math.min(1.3, 0.35 + dur * 3),
            this.colorFor(track.accentCss, track.accent),
            track, 1,
        );
    };

    layout(s: VizServices): void {
        if (!(s.width > 0 && s.height > 0)) return;

        const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(s.height / CELL_TARGET)));
        const cellH = s.height / rows;
        const cellW = cellH * 0.62;
        this.cellW = cellW;
        this.cellH = cellH;
        this.rows = rows;
        this.cols = Math.max(4, Math.floor(s.width / cellW));
        this.labelSize = Math.max(9, Math.min(11, cellH * 0.6));

        const t = s.theme;
        this.bgCss = `rgb(${t.bgRgb[0]}, ${t.bgRgb[1]}, ${t.bgRgb[2]})`;
        this.labelColor = rampAt(alphaRamp(t.textRgb, 16), 0.4);
        // Theme changes only arrive with a re-layout — drop stale ramps.
        this.colors.clear();
        const green = t.accentPool[2] ?? t.accentPool[0];
        this.base = this.colorFor('base', green);

        // Resize keeps the rain: the old layer is scaled into the new one.
        const lw = Math.max(1, Math.ceil(s.width * s.dpr));
        const lh = Math.max(1, Math.ceil(s.height * s.dpr));
        const old = this.layer;
        if (!old || old.width !== lw || old.height !== lh) {
            const layer = document.createElement('canvas');
            layer.width = lw;
            layer.height = lh;
            const ctx = layer.getContext('2d', {alpha: false})!;
            ctx.fillStyle = this.bgCss;
            ctx.fillRect(0, 0, lw, lh);
            if (old) ctx.drawImage(old, 0, 0, lw, lh);
            this.layer = layer;
            this.layerCtx = ctx;
        }
        // Device-pixel space; font state persists across frames.
        const ctx = this.layerCtx!;
        ctx.font = `${(cellH * 0.9 * s.dpr).toFixed(2)}px ${MONO_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
    }

    /** Cached body/head alpha ramps per colour; heads are a pale tint. */
    private colorFor(key: string, rgb: readonly [number, number, number]): RainColor {
        let c = this.colors.get(key);
        if (!c) {
            c = {body: alphaRamp(rgb, 16), head: alphaRamp(mixRgb(rgb, [255, 255, 255], 0.55), 16)};
            this.colors.set(key, c);
        }
        return c;
    }

    private spawn(x: number, speed: number, travel: number, color: RainColor, track: VizTrack | null, level: number): void {
        // Prefer a free slot; when the pool is full, recycle the next in turn.
        let slot = this.cursor;
        for (let k = 0; k < MAX_STREAMS; k++) {
            const i = (this.cursor + k) % MAX_STREAMS;
            if (!this.streams[i].alive) {
                slot = i;
                break;
            }
        }
        this.cursor = (slot + 1) % MAX_STREAMS;
        const st = this.streams[slot];
        st.alive = true;
        st.x = Math.min(0.999, Math.max(0, x));
        st.y = -1 / Math.max(1, this.rows);
        st.speed = speed;
        st.remaining = travel;
        st.color = color;
        st.track = track;
        st.level = level;
        this.sinceSpawn = 0;
    }

    update(dt: number, s: VizServices): void {
        if (!this.layerCtx) this.layout(s);
        const rctx = this.layerCtx;
        if (!rctx || !this.layer) return;

        this.bar = Math.floor(s.cycle);
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.laneCount = sync.pattern ? this.tracks.tracks.length : 0;
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        if (!sync.pattern) {
            const hits = this.transients.update(dt, s.low, s.mid, s.high);
            const r = this.rng;
            if (hits.kick) this.spawn(r.range(0, 0.33), 0.85 * r.range(0.9, 1.1), 1.1, this.base, null, 0.9);
            if (hits.snare) this.spawn(r.range(0.33, 0.66), 1.0 * r.range(0.9, 1.1), 0.7, this.base, null, 0.75);
            if (hits.hat) this.spawn(r.range(0.66, 1), 1.35 * r.range(0.9, 1.1), 0.45, this.base, null, 0.6);
        }

        // Idle drizzle: sparse, slow, dim — whenever nothing has fallen lately.
        this.sinceSpawn += dt;
        if (this.sinceSpawn > DRIZZLE_AFTER) {
            this.drizzleClock += dt;
            if (this.drizzleClock >= DRIZZLE_EVERY) {
                this.drizzleClock = 0;
                const h = hash32(0x64727a, this.drizzleCount++);
                this.spawn(rand01(h), 0.08 + rand01(h >>> 5) * 0.06, 1.2, this.base, null, 0.4);
                this.sinceSpawn = DRIZZLE_AFTER;
            }
        } else {
            this.drizzleClock = DRIZZLE_EVERY;
        }

        // Trail fade toward exactly the background.
        this.pendingFade += dt;
        const fade = 1 - Math.exp(-this.pendingFade * TRAIL_DECAY);
        if (fade >= MIN_FADE_STEP) {
            this.pendingFade = 0;
            rctx.globalAlpha = fade;
            rctx.fillStyle = this.bgCss;
            rctx.fillRect(0, 0, this.layer.width, this.layer.height);
            rctx.globalAlpha = 1;
        }

        // Advance streams, stamping a body glyph into each newly entered
        // cell and restamping the bright head.
        const rows = this.rows;
        const cellWDev = this.cellW * s.dpr;
        const cellHDev = this.cellH * s.dpr;
        const glyphs = RAIN_GLYPHS;
        for (let i = 0; i < MAX_STREAMS; i++) {
            const st = this.streams[i];
            if (!st.alive) continue;
            const prevRow = Math.floor(st.y * rows);
            const advance = st.speed * dt;
            st.y += advance;
            st.remaining -= advance;
            const headRow = Math.floor(st.y * rows);
            const x = (Math.min(this.cols - 1, Math.floor(st.x * this.cols)) + 0.5) * cellWDev;
            const level = st.track ? 0.45 + st.track.activity * 0.55 : st.level;

            rctx.fillStyle = rampAt(st.color.body, 0.2 + level * 0.35);
            for (let r = Math.max(0, prevRow + 1); r <= headRow && r < rows; r++) {
                rctx.fillText(glyphs[Math.floor(this.rng.next() * glyphs.length)], x, (r + 0.55) * cellHDev);
            }
            if (headRow >= 0 && headRow < rows) {
                rctx.fillStyle = rampAt(st.color.head, 0.3 + level * 0.6);
                rctx.fillText(glyphs[Math.floor(this.rng.next() * glyphs.length)], x, (headRow + 0.55) * cellHDev);
            }

            if (st.remaining <= 0 || headRow >= rows) {
                st.alive = false;
                st.track = null;
            }
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (!this.layer) return;
        ctx.drawImage(this.layer, 0, 0, s.width, s.height);

        // Lane labels — which band of columns belongs to which track.
        const n = this.laneCount;
        if (n === 0) return;
        const laneW = s.width / n;
        if (laneW < 48) return;
        ctx.save();
        const pad = Math.max(6, this.cellW * 0.5);
        const lanes = this.tracks.tracks;
        for (let i = 0; i < n && i < lanes.length; i++) {
            drawLabel(ctx, lanes[i].name, i * laneW + pad, pad + this.labelSize * 0.5,
                this.labelColor, this.labelSize);
        }
        ctx.restore();
    }
}

export const matrixRainDef: VizModeDef = {
    id: 'matrix-rain',
    name: 'MATRIX RAIN',
    create: () => new MatrixRainMode(),
};
