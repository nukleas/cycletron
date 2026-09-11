/**
 * FOREST DRIVE — a country road through a forest at dusk. First-person, the
 * road receding to a vanishing point, and every tree on the near verge is one
 * scheduled hap.
 *
 * The whole mode rests on one idea: **distance is musical time.** A hap's tree
 * is planted at `absoluteBegin * Z_PER_CYCLE` metres down the road and the
 * camera advances at `cycle * Z_PER_CYCLE`, so each trunk reaches the
 * windshield exactly on its onset. Nothing is spawned "when a note fires" —
 * the forest ahead of you *is* the next two bars, laid out in space, and the
 * beat is the whoosh as a trunk goes past. That also means onsets need no
 * phase bookkeeping: a tree flashes when the camera crosses its z.
 *
 * Behind the hap trees sits a procedural forest keyed to absolute world z, so
 * a sparse pattern still reads as woodland (and the drive stays alive when the
 * transport is stopped) without inventing anything that claims to be a note.
 *
 * Like ISO CITY this mode parses the shared cycle-view buffer itself rather
 * than using `TrackModel`, because it needs a two-cycle lookahead and
 * `TrackModel` queries exactly one bar. Same buffer discipline applies: parse
 * fully and synchronously right after our own query, fresh `Float32Array` view
 * every call.
 */

import type {PatternHandle} from '../../../pkg';
import type {PatternSource, Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {MAX_TRACKS, VIEW_CAPACITY} from '../tracks.js';
import {TAU, TransientDetector, lerpRgb, rgbOf} from '../util.js';

/** Metres of road per cycle. With 1 cycle = 1 bar this sets the driving speed. */
const Z_PER_CYCLE = 52;
/** Cycles queried ahead. 2 keeps a full bar of forest in front at all times. */
const LOOKAHEAD = 2;

const EYE = 1.45;        // camera height above the road, m
/** The road has to reach the bottom of the frame, so it clips closer than
 *  anything else; trees clip further out or they fill the screen as they pass. */
const ROAD_NEAR = 1.3;
const NEAR = 5.5;        // tree near clip, m
const FAR = 135;         // draw distance, m
const ROAD_HALF = 3.6;   // carriageway half-width, m
const VERGE = 7.5;       // nearest a hap tree plants to the centreline, m
const IDLE_SPEED = 14;   // m/s the camera coasts when nothing is playing

/** Fog is quantized into bands so colour mixing stays out of the hot path. */
const FOG_BANDS = 10;
const FOG_NEAR = 16;     // m — fog starts biting
const MAX_TREES = 320;   // hap trees kept alive at once

const SLAB = 3.4;        // ambient forest is seeded per slab of road, m
const AMBIENT_PER_SLAB = 3;
/** Beyond this, trees drop to a single-path silhouette. */
const LOD_DEPTH = 46;

type TreeKind = 'conifer' | 'birch' | 'sapling' | 'oak' | 'shrub';

/** Fog-banded canvas colours, mixed once per track per rebuild. */
interface TreeColors {
    trunk: string[];
    foliage: string[];
    lit: string[];
}

interface Tree {
    kind: TreeKind;
    /** True for a hap tree; false for the procedural forest behind it. */
    hero: boolean;
    /** Absolute world z in metres — never rebased, so identity survives bars. */
    z: number;
    /** Signed lateral offset from the road centreline. */
    off: number;
    h: number;
    spread: number;
    lean: number;
    seed: number;
    colors: TreeColors;
    /** Onset envelope: 1 as the camera crosses it, exponential decay. */
    flash: number;
    /** 1 = present; falls to 0 when the hap vanishes from the pattern. */
    fade: number;
    /** Scratch flag during rebuild: still scheduled in the queried span. */
    seen: boolean;
}

/**
 * Species from the track's sound name — the same archetype idiom ISO CITY uses
 * (`cityKindFor`). Anything with a pitch this span becomes an oak, so the
 * melody gets the broad reactive trees.
 */
function treeKindFor(name: string, hasPitch: boolean): TreeKind {
    if (hasPitch) return 'oak';
    const n = name.toLowerCase();
    if (/^(bd|kick|808)/.test(n)) return 'conifer';
    if (/^(sd|sn|cp|clap|rim|lt|mt|ht)/.test(n)) return 'birch';
    if (/^(hh|oh|hat|shaker|cb|rd|cr)/.test(n)) return 'sapling';
    return 'shrub';
}

/** Deterministic 32-bit mix — `ui/src/viz` has no RNG, and we need stability. */
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

/** Road centreline offset at a given distance — a slow sum of sines. */
function curveAt(z: number): number {
    return Math.sin(z * 0.0121) * 8.5 + Math.sin(z * 0.0043 + 1.7) * 15;
}

/** Road surface height — crests and dips, much slower than the bends. */
function hillAt(z: number): number {
    return Math.sin(z * 0.0075 + 0.6) * 1.5 + Math.sin(z * 0.0031) * 2.3;
}

function mix3(
    a: [number, number, number],
    b: [number, number, number],
    t: number,
): [number, number, number] {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

/** Rebuild scratch — module-level so a bar boundary allocates nothing. */
const seenKeys = new Set<string>();

class ForestDriveMode implements VizMode {
    // --- camera -----------------------------------------------------------
    /** Absolute world z of the camera, metres. */
    private camZ = 0;
    private prevCamZ = 0;
    private camLocked = false;
    private yaw = 0;

    // --- schedule ---------------------------------------------------------
    private lastBar = -1;
    private lastPattern: PatternHandle | null = null;
    private registryVersion = -1;
    private readonly trackNames: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private readonly trackSlots = new Map<string, number>();
    private nextSlot = 0;

    // --- world ------------------------------------------------------------
    private readonly heroes: Tree[] = [];
    private readonly heroByKey = new Map<string, Tree>();
    /** Reused ambient records — regenerated per frame, never allocated per frame. */
    private readonly ambientPool: Tree[] = [];
    private drawList: Tree[] = [];

    // --- palette ----------------------------------------------------------
    private fogRgb: [number, number, number] = [20, 20, 30];
    private ambientColors!: TreeColors;
    private duskRgb: [number, number, number] = [40, 30, 60];
    private shoulderRgb: [number, number, number] = [20, 26, 24];
    private themeKey = '';

    // --- atmosphere -------------------------------------------------------
    private readonly transients = new TransientDetector(0.12, 0.1, 0.05);
    private headlight = 0;
    /** Bumped whenever the camera crosses a hap tree — the on-beat light cue. */
    private onsetPulse = 0;
    private starSeed = 0;

    // --- viewport ---------------------------------------------------------
    private vw = 0;
    private vh = 0;
    private cx = 0;
    private horizon = 0;
    private focal = 900;
    private theme!: Theme;

    layout(s: VizServices): void {
        // Viewport only — the drive itself must survive a resize untouched.
        this.vw = s.width;
        this.vh = s.height;
        this.cx = s.width * 0.5;
        this.horizon = s.height * 0.5;
        this.focal = s.height * 0.5;
        this.theme = s.theme;
        this.ensurePalette(s.theme);
        // Force a fresh query; the world model is deliberately left alone.
        this.lastBar = -1;
    }

    update(dt: number, s: VizServices): void {
        this.vw = s.width;
        this.vh = s.height;
        this.theme = s.theme;
        this.ensurePalette(s.theme);

        const source = s.patternSource;
        const pattern = source?.scheduler.pattern ?? null;
        const bar = Math.floor(s.cycle);

        // --- camera: locked to musical time while playing, coasting otherwise
        this.prevCamZ = this.camZ;
        if (pattern) {
            const target = s.cycle * Z_PER_CYCLE;
            if (!this.camLocked) {
                // Re-entering playback: snap. Fog hides the far edge and there
                // are no hap trees yet, so the jump is invisible.
                this.camZ = target;
                this.prevCamZ = target;
                this.camLocked = true;
            } else {
                this.camZ = target;
            }
        } else {
            this.camLocked = false;
            this.camZ += dt * IDLE_SPEED;
        }

        // Rebuild on live edit (each evaluate makes a new handle) or bar line.
        if (pattern && source && (pattern !== this.lastPattern || bar !== this.lastBar)) {
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern, source, bar, s.theme);
        }
        if (!pattern) {
            this.lastPattern = null;
            this.lastBar = -1;
        }

        // --- onsets: the camera crossing a tree IS the hap firing.
        const travelled = this.camZ - this.prevCamZ;
        // A seek or a restart can jump the playhead; don't machine-gun flashes.
        const sane = travelled > 0 && travelled < Z_PER_CYCLE;
        for (let n = this.heroes.length - 1; n >= 0; n--) {
            const t = this.heroes[n];
            if (sane && t.z > this.prevCamZ && t.z <= this.camZ) {
                t.flash = 1;
                this.onsetPulse = Math.min(1, this.onsetPulse + 0.55);
            }
            t.flash *= Math.exp(-dt * 6);
            if (!t.seen) t.fade -= dt * 2.5;
            // Drop once safely behind the camera, or once faded out ahead of it.
            if (t.z < this.camZ - 6 || t.fade <= 0) {
                this.heroes.splice(n, 1);
                this.heroByKey.delete(this.keyOf(t));
            }
        }

        // --- atmosphere
        const hits = this.transients.update(dt, s.low, s.mid, s.high);
        if (hits.kick) this.headlight = 1;
        this.headlight *= Math.exp(-dt * 5);
        this.onsetPulse *= Math.exp(-dt * 7);

        // Yaw eases toward the bend a little way ahead — the car leans in.
        const bend = curveAt(this.camZ + 26) - curveAt(this.camZ);
        this.yaw += (bend * 0.012 - this.yaw) * Math.min(1, dt * 2.2);

        this.starSeed = Math.floor(this.camZ * 0.02);
    }

    // ---------------------------------------------------------------------
    // Schedule
    // ---------------------------------------------------------------------

    private keyOf(t: Tree): string {
        return t.seed + '|' + t.z.toFixed(4);
    }

    /**
     * Query `[bar, bar + LOOKAHEAD)` and reconcile the hap trees with it. Trees
     * are keyed by absolute onset, so the same hap seen from two different bars
     * is the same tree and keeps its shape, side and flash.
     */
    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme): void {
        pattern.queryCycleViewData(bar, LOOKAHEAD);
        // Fresh view per query — WASM memory growth detaches cached views.
        const data = new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);

        const trackCount = data[0];
        const registryVersion = data[2];
        if (registryVersion !== this.registryVersion) {
            this.registryVersion = registryVersion;
            this.trackNames.fill(undefined);
        }

        seenKeys.clear();

        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];

            let name = this.trackNames[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.trackNames[trackId] = name;
            }

            let slot = this.trackSlots.get(name);
            if (slot === undefined) {
                slot = this.nextSlot++;
                this.trackSlots.set(name, slot);
            }

            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            const base = idx;

            // Does this track carry pitch in this span? Decides the archetype,
            // so it has to be known before any tree is built.
            let hasPitch = false;
            for (let e = 0; e < nEvents; e++) {
                if (Number.isFinite(data[base + e * 3 + 2])) { hasPitch = true; break; }
            }
            const kind = treeKindFor(name, hasPitch);

            // Accent recomputed each rebuild so `.color()` edits and theme
            // changes both land. Cheap — a handful of strings per track.
            const pool = theme.accentPool;
            const fallback = pool[slot % pool.length];
            const hint = pattern.getTrackColor(trackId);
            const accent = hint !== undefined ? rgbOf(hint, fallback) : fallback;
            const colors = this.colorsFor(accent, kind);

            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= LOOKAHEAD) continue;

                const absBegin = bar + Math.max(0, begin);
                const z = absBegin * Z_PER_CYCLE;
                // Already behind us — the hap has been and gone.
                if (z < this.camZ - 6) continue;

                const seed = hash32(slot * 977, Math.round(absBegin * 4096));
                const key = seed + '|' + z.toFixed(4);
                seenKeys.add(key);

                const existing = this.heroByKey.get(key);
                if (existing) {
                    existing.seen = true;
                    existing.fade = 1;
                    existing.colors = colors;
                    continue;
                }
                if (this.heroes.length >= MAX_TREES) continue;

                const dur = Math.max(0.02, Math.min(end, LOOKAHEAD) - Math.max(0, begin));
                this.heroes.push(this.makeTree(kind, z, seed, note, dur, colors));
                this.heroByKey.set(key, this.heroes[this.heroes.length - 1]);
            }
            idx = base + eventCount * 3;
        }

        // Anything not in this span has been edited away; let it fade rather
        // than pop. `update` does the actual removal.
        for (const t of this.heroes) t.seen = seenKeys.has(this.keyOf(t));
    }

    /**
     * Build one hap tree. Note drives height (the sidebar's C1–C7 range, as in
     * ISO CITY), duration drives canopy spread, and the hash decides everything
     * cosmetic so the tree is individual but never twitches between rebuilds.
     */
    private makeTree(
        kind: TreeKind,
        z: number,
        seed: number,
        note: number,
        dur: number,
        colors: TreeColors,
    ): Tree {
        const r1 = rand01(seed);
        const r2 = rand01(hash32(seed, 11));
        const r3 = rand01(hash32(seed, 23));

        // Pitched trees get their height from the note; the rest from species.
        let h: number;
        let spread: number;
        switch (kind) {
            case 'conifer':
                h = 13 + r1 * 7;
                spread = 1.7 + r2 * 0.7;
                break;
            case 'birch':
                h = 8.5 + r1 * 4;
                spread = 1.5 + r2 * 0.6;
                break;
            case 'sapling':
                h = 2.6 + r1 * 2.2;
                spread = 0.8 + r2 * 0.5;
                break;
            case 'oak': {
                const n = Number.isFinite(note) ? Math.min(96, Math.max(24, note)) : 54;
                h = 5.5 + ((n - 24) / 72) * 11;
                spread = 2.2 + r2 * 1.1;
                break;
            }
            default:
                h = 1.4 + r1 * 1.2;
                spread = 1.1 + r2 * 0.7;
                break;
        }
        // Sustained notes are fuller; a staccato hit is a thin one.
        spread *= 0.85 + Math.min(1.4, dur * 2.4) * 0.35;

        const side = (seed & 1) === 0 ? -1 : 1;
        const off = side * (VERGE + r3 * 3.6);

        return {
            kind,
            hero: true,
            z,
            off,
            h,
            spread,
            lean: (r2 - 0.5) * 0.16,
            seed,
            colors,
            flash: 0,
            fade: 1,
            seen: true,
        };
    }

    // ---------------------------------------------------------------------
    // Palette
    // ---------------------------------------------------------------------

    /** Re-derive the dusk mixes only when the theme actually changes. */
    private ensurePalette(t: Theme): void {
        const key = t.bg + t.violet + t.neonSecondary + t.neon;
        if (key === this.themeKey) return;
        this.themeKey = key;

        const violet = rgbOf(t.violet, [157, 124, 255]);
        const magenta = rgbOf(t.neonSecondary, [255, 43, 214]);
        // Dusk band at the horizon: the app's own violet/magenta, heavily
        // darkened so it reads as last light rather than neon.
        this.duskRgb = mix3(mix3(t.bgLightRgb, violet, 0.42), magenta, 0.18);
        // Fog target sits between the dusk band and the sky.
        this.fogRgb = mix3(t.bgLightRgb, this.duskRgb, 0.62);

        const leaf = mix3(t.bgLighterRgb, rgbOf(t.neon, [71, 246, 255]), 0.16);
        // Verge grass: the leaf tint dropped well below the canopy, so the
        // shoulder never competes with the trees standing on it.
        this.shoulderRgb = mix3(t.bgRgb, leaf, 0.5);
        this.ambientColors = this.bandsFor(
            mix3(t.bgRgb, this.duskRgb, 0.18),
            leaf,
            mix3(leaf, this.duskRgb, 0.3),
        );
    }

    private colorsFor(accent: [number, number, number], kind: TreeKind): TreeColors {
        const t = this.theme;
        const trunk = kind === 'birch'
            ? mix3(t.bgLighterRgb, [235, 238, 246], 0.55)
            : mix3(t.bgRgb, accent, 0.14);
        const foliage = mix3(t.bgLighterRgb, accent, 0.34);
        const lit = mix3(accent, [255, 255, 255], 0.22);
        return this.bandsFor(trunk, foliage, lit);
    }

    /** Pre-mix each colour across the fog ramp — never mix while drawing. */
    private bandsFor(
        trunk: [number, number, number],
        foliage: [number, number, number],
        lit: [number, number, number],
    ): TreeColors {
        const out: TreeColors = {trunk: [], foliage: [], lit: []};
        for (let k = 0; k < FOG_BANDS; k++) {
            const f = k / (FOG_BANDS - 1);
            out.trunk.push(lerpRgb(trunk, this.fogRgb, f));
            out.foliage.push(lerpRgb(foliage, this.fogRgb, f));
            out.lit.push(lerpRgb(lit, this.fogRgb, f * 0.75));
        }
        return out;
    }

    /** Depth → fog band index. */
    private bandOf(depth: number): number {
        if (depth <= FOG_NEAR) return 0;
        const f = Math.min(1, (depth - FOG_NEAR) / (FAR - FOG_NEAR));
        return Math.min(FOG_BANDS - 1, Math.round(f * (FOG_BANDS - 1)));
    }

    // ---------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {vw, vh, horizon} = this;
        const camY0 = hillAt(this.camZ) + EYE;
        const camX = curveAt(this.camZ);

        this.drawSky(ctx);
        this.drawStars(ctx, s);
        this.drawSun(ctx, s);
        this.drawGround(ctx);
        this.drawTreeline(ctx);
        this.drawRoad(ctx, camX, camY0);
        this.drawHeadlights(ctx, camX, camY0);

        // Painter's algorithm over both tree layers at once.
        this.buildDrawList();
        for (const t of this.drawList) {
            this.drawTree(ctx, t, camX, camY0);
        }

        // Near haze — pulls the foreground together and softens the verge.
        const haze = ctx.createLinearGradient(0, horizon, 0, vh);
        haze.addColorStop(0, `rgba(${this.fogRgb.map(Math.round).join(',')}, 0.18)`);
        haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = haze;
        ctx.fillRect(0, horizon, vw, vh - horizon);
    }

    /**
     * Hap trees plus the procedural forest behind them, sorted far→near. The
     * ambient records are pooled — this runs every frame.
     */
    private buildDrawList(): void {
        const list = this.drawList;
        list.length = 0;

        for (const t of this.heroes) {
            const depth = t.z - this.camZ;
            if (depth > NEAR && depth < FAR) list.push(t);
        }

        const first = Math.floor((this.camZ + NEAR) / SLAB);
        const last = Math.floor((this.camZ + FAR) / SLAB);
        let used = 0;
        for (let k = first; k <= last; k++) {
            for (let n = 0; n < AMBIENT_PER_SLAB; n++) {
                const seed = hash32(k, n * 31 + 7);
                // Thin the forest out a little so it isn't a solid wall.
                if (rand01(hash32(seed, 3)) > 0.82) continue;

                let rec = this.ambientPool[used];
                if (!rec) {
                    rec = {
                        kind: 'conifer', hero: false, z: 0, off: 0, h: 0, spread: 0, lean: 0,
                        seed: 0, colors: this.ambientColors, flash: 0, fade: 1, seen: true,
                    };
                    this.ambientPool[used] = rec;
                }
                used++;

                const r1 = rand01(seed);
                const r2 = rand01(hash32(seed, 17));
                const r3 = rand01(hash32(seed, 29));
                const side = (seed & 2) === 0 ? -1 : 1;

                rec.z = (k + r1) * SLAB;
                // Ambient trees stand behind the verge, thinning with distance
                // from the road so the corridor stays readable.
                rec.off = side * (VERGE + 6 + r2 * 40);
                rec.kind = r3 > 0.55 ? 'conifer' : (r3 > 0.22 ? 'oak' : 'shrub');
                rec.h = rec.kind === 'shrub' ? 1.5 + r2 * 1.4 : 8 + r3 * 12;
                rec.spread = rec.kind === 'conifer' ? 1.6 + r2 * 0.8 : 2 + r2 * 1.3;
                rec.lean = (r2 - 0.5) * 0.12;
                rec.seed = seed;
                rec.colors = this.ambientColors;
                rec.flash = 0;
                rec.fade = 1;

                const depth = rec.z - this.camZ;
                if (depth > NEAR && depth < FAR) list.push(rec);
            }
        }

        list.sort((a, b) => b.z - a.z);
    }

    private drawSky(ctx: CanvasRenderingContext2D): void {
        const {vw, horizon} = this;
        const t = this.theme;
        const g = ctx.createLinearGradient(0, 0, 0, horizon);
        g.addColorStop(0, `rgb(${t.bgRgb.map(Math.round).join(',')})`);
        g.addColorStop(0.55, lerpRgb(t.bgRgb, this.duskRgb, 0.45));
        g.addColorStop(1, `rgb(${this.duskRgb.map(Math.round).join(',')})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, vw, horizon + 1);
    }

    private drawStars(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {vw, horizon} = this;
        const twinkle = 0.35 + s.high * 0.5;
        ctx.fillStyle = `rgba(226, 234, 255, ${0.5 * twinkle})`;
        for (let i = 0; i < 90; i++) {
            const h = hash32(i, this.starSeed);
            const x = rand01(h) * vw;
            const y = rand01(hash32(h, 5)) * horizon * 0.78;
            // Fade out toward the horizon where the dusk band takes over.
            const a = 1 - y / (horizon * 0.78);
            const r = 0.5 + rand01(hash32(h, 9)) * 0.9;
            ctx.globalAlpha = a * a * twinkle;
            ctx.fillRect(x, y, r, r);
        }
        ctx.globalAlpha = 1;
    }

    /** Last light at the vanishing point; the only place FFT touches the scene. */
    private drawSun(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const vx = this.cx - this.yaw * this.focal;
        const r = this.vh * (0.26 + s.low * 0.1);
        const g = ctx.createRadialGradient(vx, this.horizon, 0, vx, this.horizon, r);
        const glow = mix3(this.duskRgb, [255, 214, 170], 0.5);
        g.addColorStop(0, `rgba(${glow.map(Math.round).join(',')}, ${0.5 + s.low * 0.25})`);
        g.addColorStop(0.45, `rgba(${this.duskRgb.map(Math.round).join(',')}, 0.28)`);
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(vx - r, this.horizon - r, r * 2, r * 2);
    }

    private drawGround(ctx: CanvasRenderingContext2D): void {
        const {vw, vh, horizon} = this;
        const t = this.theme;
        const g = ctx.createLinearGradient(0, horizon, 0, vh);
        g.addColorStop(0, `rgb(${this.fogRgb.map(Math.round).join(',')})`);
        g.addColorStop(0.35, lerpRgb(t.bgRgb, this.fogRgb, 0.3));
        g.addColorStop(1, `rgb(${t.bgRgb.map(Math.round).join(',')})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, horizon, vw, vh - horizon);
    }

    /** Cheap parallax band of far hills/treetops sitting on the horizon. */
    private drawTreeline(ctx: CanvasRenderingContext2D): void {
        const {vw, horizon} = this;
        const drift = (this.camZ * 0.12) % 40;
        ctx.fillStyle = lerpRgb(this.fogRgb, this.theme.bgRgb, 0.42);
        ctx.beginPath();
        ctx.moveTo(-10, horizon + 2);
        const step = vw / 90;
        for (let i = -1; i < 110; i++) {
            const h = hash32(i, 91);
            const x = i * step - drift - this.yaw * this.focal * 0.15;
            const peak = horizon - (1.5 + rand01(h) * 7);
            ctx.lineTo(x, horizon + 2);
            ctx.lineTo(x + step * 0.5, peak);
            ctx.lineTo(x + step, horizon + 2);
        }
        ctx.lineTo(vw + 10, horizon + 2);
        ctx.closePath();
        ctx.fill();
    }

    /** Screen x for a world point. */
    private sx(worldX: number, camX: number, scale: number): number {
        return this.cx + (worldX - camX) * scale - this.yaw * this.focal;
    }

    private drawRoad(ctx: CanvasRenderingContext2D, camX: number, camY0: number): void {
        const STEPS = 48;
        const left: number[] = [];
        const right: number[] = [];
        const vergeL: number[] = [];
        const vergeR: number[] = [];
        const ys: number[] = [];

        for (let i = 0; i <= STEPS; i++) {
            // Quadratic spacing — more samples near the camera, where the
            // road's shape actually reads.
            const f = i / STEPS;
            const depth = ROAD_NEAR + (FAR - ROAD_NEAR) * f * f;
            const z = this.camZ + depth;
            const scale = this.focal / depth;
            const cxw = curveAt(z);
            const y = this.horizon + (camY0 - hillAt(z)) * scale;
            left.push(this.sx(cxw - ROAD_HALF, camX, scale));
            right.push(this.sx(cxw + ROAD_HALF, camX, scale));
            vergeL.push(this.sx(cxw - ROAD_HALF - 1.8, camX, scale));
            vergeR.push(this.sx(cxw + ROAD_HALF + 1.8, camX, scale));
            ys.push(y);
        }

        // Grass shoulder first — the road is laid on top of it, which gives
        // the carriageway a defined edge without a second outline pass.
        ctx.beginPath();
        ctx.moveTo(vergeL[0], ys[0]);
        for (let i = 1; i <= STEPS; i++) ctx.lineTo(vergeL[i], ys[i]);
        for (let i = STEPS; i >= 0; i--) ctx.lineTo(vergeR[i], ys[i]);
        ctx.closePath();
        ctx.fillStyle = lerpRgb(this.shoulderRgb, this.fogRgb, 0.35);
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(left[0], ys[0]);
        for (let i = 1; i <= STEPS; i++) ctx.lineTo(left[i], ys[i]);
        for (let i = STEPS; i >= 0; i--) ctx.lineTo(right[i], ys[i]);
        ctx.closePath();
        const rg = ctx.createLinearGradient(0, ys[STEPS], 0, ys[0]);
        rg.addColorStop(0, `rgb(${this.fogRgb.map(Math.round).join(',')})`);
        rg.addColorStop(1, lerpRgb(this.theme.bgRgb, this.fogRgb, 0.22));
        ctx.fillStyle = rg;
        ctx.fill();

        // Verge lines.
        ctx.strokeStyle = lerpRgb(this.theme.borderRgb, this.fogRgb, 0.4);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left[0], ys[0]);
        for (let i = 1; i <= STEPS; i++) ctx.lineTo(left[i], ys[i]);
        ctx.moveTo(right[0], ys[0]);
        for (let i = 1; i <= STEPS; i++) ctx.lineTo(right[i], ys[i]);
        ctx.stroke();

        // Centre dashes, anchored in world space so they stream past correctly.
        const DASH = 7;
        const firstDash = Math.ceil((this.camZ + ROAD_NEAR) / DASH);
        ctx.fillStyle = lerpRgb(this.theme.textRgb, this.fogRgb, 0.6);
        for (let d = firstDash; ; d++) {
            const z0 = d * DASH;
            const depth = z0 - this.camZ;
            if (depth > FAR * 0.55) break;
            const z1 = z0 + 3.2;
            const s0 = this.focal / Math.max(ROAD_NEAR, depth);
            const s1 = this.focal / Math.max(ROAD_NEAR, z1 - this.camZ);
            const w0 = 0.07 * s0;
            const y0 = this.horizon + (camY0 - hillAt(z0)) * s0;
            const y1 = this.horizon + (camY0 - hillAt(z1)) * s1;
            const x0 = this.sx(curveAt(z0), camX, s0);
            const x1 = this.sx(curveAt(z1), camX, s1);
            ctx.globalAlpha = Math.max(0, 1 - depth / (FAR * 0.55)) * 0.55;
            ctx.beginPath();
            ctx.moveTo(x0 - w0, y0);
            ctx.lineTo(x0 + w0, y0);
            ctx.lineTo(x1 + w0 * 0.35, y1);
            ctx.lineTo(x1 - w0 * 0.35, y1);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    /** Twin cones on the tarmac, flaring on kicks. */
    private drawHeadlights(ctx: CanvasRenderingContext2D, camX: number, camY0: number): void {
        const reach = 34;
        const scale = this.focal / reach;
        const zf = this.camZ + reach;
        const yFar = this.horizon + (camY0 - hillAt(zf)) * scale;
        const yNear = this.vh;
        const xFar = this.sx(curveAt(zf), camX, scale);

        const g = ctx.createLinearGradient(0, yNear, 0, yFar);
        const warm = mix3(this.fogRgb, [255, 236, 198], 0.7);
        const a = 0.1 + this.headlight * 0.1 + this.onsetPulse * 0.14;
        g.addColorStop(0, `rgba(${warm.map(Math.round).join(',')}, ${a})`);
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(this.cx - this.vw * 0.22, yNear);
        ctx.lineTo(xFar - 26, yFar);
        ctx.lineTo(xFar + 26, yFar);
        ctx.lineTo(this.cx + this.vw * 0.22, yNear);
        ctx.closePath();
        ctx.fill();
    }

    // ---------------------------------------------------------------------
    // Trees
    // ---------------------------------------------------------------------

    private drawTree(ctx: CanvasRenderingContext2D, t: Tree, camX: number, camY0: number): void {
        const depth = t.z - this.camZ;
        const scale = this.focal / depth;
        const ground = hillAt(t.z);
        const x = this.sx(curveAt(t.z) + t.off, camX, scale);
        const yBase = this.horizon + (camY0 - ground) * scale;
        const hPx = t.h * scale;
        if (hPx < 1.5) return;

        const band = this.bandOf(depth);
        // Hap trees bloom as they come at you — this is the sync cue the eye
        // actually reads, since the crossing itself happens off-frame. `flash`
        // rides on top for the last frames before it goes past.
        let lit = 0;
        if (t.hero) {
            const near = Math.max(0, 1 - (depth - NEAR) / 15);
            lit = Math.max(t.flash, near * near);
        }
        // Fade in at the draw distance so nothing pops at the spawn edge.
        const alpha = Math.min(1, (FAR - depth) / 26) * t.fade;
        if (alpha <= 0.01) return;
        ctx.globalAlpha = alpha;

        const wPx = t.spread * scale;
        const lean = t.lean * hPx;
        const simple = depth > LOD_DEPTH || hPx < 26;

        // Contact shadow — small, but it's the difference between a tree
        // standing on the verge and a sticker pasted on the sky.
        if (wPx > 1.5) {
            ctx.globalAlpha = alpha * 0.4;
            ctx.fillStyle = t.colors.trunk[Math.min(FOG_BANDS - 1, band + 2)];
            ctx.beginPath();
            ctx.ellipse(x, yBase, wPx * 0.95, Math.max(0.7, wPx * 0.2), 0, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = alpha;
        }

        switch (t.kind) {
            case 'conifer': this.drawConifer(ctx, t, x, yBase, hPx, wPx, lean, band, lit, simple); break;
            case 'birch':   this.drawBirch(ctx, t, x, yBase, hPx, wPx, lean, band, lit, simple); break;
            case 'sapling': this.drawSapling(ctx, t, x, yBase, hPx, wPx, lean, band, lit); break;
            case 'oak':     this.drawOak(ctx, t, x, yBase, hPx, wPx, lean, band, lit, simple); break;
            default:        this.drawShrub(ctx, t, x, yBase, hPx, wPx, band, lit); break;
        }

        ctx.globalAlpha = 1;
    }

    /** Tapered trunk as a quad — cheap and reads correctly at every scale. */
    private trunk(
        ctx: CanvasRenderingContext2D,
        x: number, yBase: number, hPx: number, lean: number, wBase: number, wTop: number,
        fill: string,
    ): void {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(x - wBase, yBase);
        ctx.lineTo(x + wBase, yBase);
        ctx.lineTo(x + lean + wTop, yBase - hPx);
        ctx.lineTo(x + lean - wTop, yBase - hPx);
        ctx.closePath();
        ctx.fill();
    }

    private drawConifer(
        ctx: CanvasRenderingContext2D, t: Tree,
        x: number, yBase: number, hPx: number, wPx: number, lean: number,
        band: number, lit: number, simple: boolean,
    ): void {
        const c = t.colors;
        this.trunk(ctx, x, yBase, hPx * 0.24, lean * 0.24, Math.max(0.6, wPx * 0.1), wPx * 0.06, c.trunk[band]);

        const tiers = simple ? 1 : 4;
        const top = yBase - hPx;
        const skirt = yBase - hPx * 0.16;
        ctx.fillStyle = c.foliage[band];

        for (let i = 0; i < tiers; i++) {
            const f0 = i / tiers;
            const f1 = (i + 1) / tiers;
            const yA = skirt + (top - skirt) * f0;
            const yB = skirt + (top - skirt) * f1;
            const w = wPx * (1 - f0 * 0.72);
            const lx = lean * f0;
            // Lower tiers sit in their own shade — cheap vertical form.
            ctx.fillStyle = i === 0 ? c.trunk[band] : c.foliage[band];
            ctx.beginPath();
            ctx.moveTo(x + lx - w, yA);
            ctx.lineTo(x + lean * f1, yB);
            ctx.lineTo(x + lx + w, yA);
            ctx.closePath();
            ctx.fill();
            // Sunward edge catches the last light.
            if (!simple && i > 0) {
                ctx.globalAlpha *= 0.5;
                ctx.fillStyle = c.lit[band];
                ctx.beginPath();
                ctx.moveTo(x + lean * f1, yB);
                ctx.lineTo(x + lx + w, yA);
                ctx.lineTo(x + lx + w * 0.55, yA);
                ctx.closePath();
                ctx.fill();
                ctx.globalAlpha /= 0.5;
            }
        }

        if (lit > 0.02) this.bloom(ctx, x + lean * 0.5, (top + skirt) * 0.5, wPx * 1.5, c.lit[band], lit);
    }

    private drawBirch(
        ctx: CanvasRenderingContext2D, t: Tree,
        x: number, yBase: number, hPx: number, wPx: number, lean: number,
        band: number, lit: number, simple: boolean,
    ): void {
        const c = t.colors;
        const trunkH = hPx * 0.72;
        this.trunk(ctx, x, yBase, trunkH, lean * 0.72, Math.max(0.6, wPx * 0.09), wPx * 0.045, c.trunk[band]);

        if (!simple) {
            // Dashed bark marks — the birch tell, seeded so they never crawl.
            ctx.strokeStyle = c.foliage[band];
            ctx.lineWidth = Math.max(0.5, wPx * 0.03);
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const f = 0.15 + i * 0.14;
                const yy = yBase - trunkH * f;
                const w = wPx * 0.08 * (1 - f * 0.5);
                const jitter = (rand01(hash32(t.seed, i)) - 0.5) * w;
                ctx.moveTo(x + lean * f - w + jitter, yy);
                ctx.lineTo(x + lean * f + w + jitter, yy);
            }
            ctx.stroke();
        }

        // Sparse crown.
        const cy = yBase - hPx * 0.82;
        ctx.fillStyle = lit > 0.02 ? c.lit[band] : c.foliage[band];
        const blobs = simple ? 1 : 3;
        for (let i = 0; i < blobs; i++) {
            const h = hash32(t.seed, 40 + i);
            const bx = x + lean + (rand01(h) - 0.5) * wPx * 1.5;
            const by = cy + (rand01(hash32(h, 2)) - 0.5) * hPx * 0.22;
            ctx.beginPath();
            ctx.ellipse(bx, by, wPx * 0.62, hPx * 0.16, 0, 0, TAU);
            ctx.fill();
        }
    }

    private drawSapling(
        ctx: CanvasRenderingContext2D, t: Tree,
        x: number, yBase: number, hPx: number, wPx: number, lean: number,
        band: number, lit: number,
    ): void {
        const c = t.colors;
        ctx.strokeStyle = c.foliage[band];
        ctx.lineWidth = Math.max(0.8, wPx * 0.16);
        ctx.beginPath();
        ctx.moveTo(x, yBase);
        ctx.quadraticCurveTo(x + lean * 0.5, yBase - hPx * 0.6, x + lean, yBase - hPx * 0.9);
        ctx.stroke();

        // Fronds arc outward and droop — a young tree, not a star.
        ctx.strokeStyle = lit > 0.02 ? c.lit[band] : c.foliage[band];
        ctx.lineWidth = Math.max(0.5, wPx * 0.09);
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const h = hash32(t.seed, 100 + i);
            const f = 0.5 + rand01(h) * 0.48;
            const yy = yBase - hPx * f;
            const dir = i % 2 === 0 ? 1 : -1;
            const reach = wPx * (0.7 + rand01(hash32(h, 2)) * 0.7) * dir;
            ctx.moveTo(x + lean * f, yy);
            ctx.quadraticCurveTo(
                x + lean * f + reach * 0.7, yy - hPx * 0.16,
                x + lean * f + reach, yy - hPx * 0.02,
            );
        }
        ctx.stroke();
        ctx.lineCap = 'butt';
    }

    private drawOak(
        ctx: CanvasRenderingContext2D, t: Tree,
        x: number, yBase: number, hPx: number, wPx: number, lean: number,
        band: number, lit: number, simple: boolean,
    ): void {
        const c = t.colors;
        const trunkH = hPx * 0.42;
        this.trunk(ctx, x, yBase, trunkH, lean * 0.42, Math.max(0.7, wPx * 0.13), wPx * 0.07, c.trunk[band]);

        if (!simple) {
            ctx.strokeStyle = c.trunk[band];
            ctx.lineCap = 'round';
            this.branch(ctx, x + lean * 0.42, yBase - trunkH, -Math.PI / 2, hPx * 0.3, wPx * 0.11, 3, t.seed);
            ctx.lineCap = 'butt';
        }

        // Canopy masses.
        const cy = yBase - hPx * 0.72;
        ctx.fillStyle = c.foliage[band];
        const blobs = simple ? 1 : 4;
        for (let i = 0; i < blobs; i++) {
            const h = hash32(t.seed, 60 + i);
            const bx = x + lean + (rand01(h) - 0.5) * wPx * 1.4;
            const by = cy + (rand01(hash32(h, 3)) - 0.5) * hPx * 0.26;
            const rr = wPx * (0.55 + rand01(hash32(h, 7)) * 0.35);
            ctx.beginPath();
            ctx.ellipse(bx, by, rr, rr * 0.78, 0, 0, TAU);
            ctx.fill();
        }
        if (!simple) {
            // Shaded underside, then a rim of last light along the top.
            ctx.globalAlpha *= 0.45;
            ctx.fillStyle = c.trunk[band];
            ctx.beginPath();
            ctx.ellipse(x + lean, cy + hPx * 0.12, wPx * 0.92, hPx * 0.16, 0, 0, TAU);
            ctx.fill();
            ctx.fillStyle = c.lit[band];
            ctx.beginPath();
            ctx.ellipse(x + lean - wPx * 0.15, cy - hPx * 0.16, wPx * 0.55, hPx * 0.1, 0, 0, TAU);
            ctx.fill();
            ctx.globalAlpha /= 0.45;
        }

        if (lit > 0.02) this.bloom(ctx, x + lean, cy, wPx * 1.7, c.lit[band], lit);
    }

    /**
     * Soft glow for a hap tree on its approach. A radial gradient rather than a
     * flat fill, so a lit tree reads as catching light instead of being
     * repainted. Only ever a handful of trees are lit at once.
     */
    private bloom(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, r: number, color: string, amount: number,
    ): void {
        if (r < 2) return;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, color);
        g.addColorStop(0.45, color);
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * amount * 0.5;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = prev;
    }

    /** Recursive branch stroke — depth-limited, seeded, no allocation. */
    private branch(
        ctx: CanvasRenderingContext2D,
        x: number, y: number, angle: number, len: number, width: number,
        depth: number, seed: number,
    ): void {
        if (depth <= 0 || len < 1.2) return;
        const x2 = x + Math.cos(angle) * len;
        const y2 = y + Math.sin(angle) * len;
        ctx.lineWidth = Math.max(0.5, width);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        const s1 = hash32(seed, depth * 13 + 1);
        const s2 = hash32(seed, depth * 13 + 2);
        const spreadA = 0.42 + rand01(s1) * 0.34;
        this.branch(ctx, x2, y2, angle - spreadA, len * 0.68, width * 0.6, depth - 1, s1);
        this.branch(ctx, x2, y2, angle + spreadA * 0.85, len * 0.66, width * 0.6, depth - 1, s2);
    }

    private drawShrub(
        ctx: CanvasRenderingContext2D, t: Tree,
        x: number, yBase: number, hPx: number, wPx: number,
        band: number, lit: number,
    ): void {
        const c = t.colors;
        ctx.fillStyle = lit > 0.02 ? c.lit[band] : c.foliage[band];
        for (let i = 0; i < 3; i++) {
            const h = hash32(t.seed, 80 + i);
            const bx = x + (rand01(h) - 0.5) * wPx * 1.6;
            const rr = wPx * (0.45 + rand01(hash32(h, 5)) * 0.35);
            ctx.beginPath();
            ctx.ellipse(bx, yBase - hPx * 0.4, rr, Math.max(1, hPx * 0.45), 0, 0, TAU);
            ctx.fill();
        }
    }
}

export const forestDriveDef: VizModeDef = {
    id: 'forest-drive',
    name: 'FOREST DRIVE',
    create: () => new ForestDriveMode(),
};
