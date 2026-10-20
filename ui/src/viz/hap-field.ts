/**
 * Scheduled haps as persistent objects, for modes where distance is musical
 * time (TANK FIELD, STAR ROAD): every hap in the next `lookahead` bars becomes
 * one object keyed by its absolute onset, so it keeps its shape across bar
 * lines and live edits, and a held note continuing over a bar line extends its
 * object rather than firing again.
 *
 * The field also owns the clock. `cycle` follows the scheduler while playing
 * and coasts at an idle rate when stopped; a start or a seek clears the field
 * and rebuilds at the destination. A hap is crossed when `cycle` passes its
 * onset during ordinary playback, never on a jump.
 *
 * Buffer discipline as in `tracks.ts`: parse the shared cycle-view buffer
 * synchronously right after our own query, recreating the view after any
 * call that can grow WASM memory.
 */

import type {PatternHandle} from '../../pkg';
import type {PatternSource, Theme, VizServices} from './types.js';
import {MAX_TRACKS, VIEW_CAPACITY, instrumentFamily, type InstrumentFamily} from './tracks.js';
import {hash32, rgbOf} from './util.js';

export type Rgb = [number, number, number];

/** A track: its color and how recently it played. */
export interface FieldTeam {
    name: string;
    slot: number;
    family: InstrumentFamily;
    /** True when the track has a `.color()` hint. */
    hinted: boolean;
    /** True when the track's first hap this bar carries a note. */
    pitched: boolean;
    rgb: Rgb;
    css: string;
    /** Onset envelope: bumped by the mode on crossings, decays here. */
    activity: number;
    present: boolean;
    fade: number;
}

/** One hap. `begin` and `end` are absolute cycles. */
export interface FieldHap<T extends FieldTeam> {
    team: T;
    note: number;
    key: string;
    seed: number;
    begin: number;
    end: number;
    /** Still scheduled; false starts the fade-out, and a fading hap can't fire. */
    seen: boolean;
    fade: number;
    /** Set by the mode once the hap has fired. */
    done: boolean;
}

export interface HapFieldConfig<T extends FieldTeam, H extends FieldHap<T>> {
    lookahead: number;
    maxHaps: number;
    maxPerTrack: number;
    /** Cycles per second the clock coasts while stopped. */
    idleRate: number;
    team(base: FieldTeam): T;
    hap(base: FieldHap<T>): H;
    /** Lower per-track cap for some haps, e.g. tanks. */
    cap?(team: T, note: number, dur: number): number;
    /** Override the track color; the default is the hint or the accent pool. */
    recolor?(team: T): Rgb | null;
    /** Keep a hap alive at `cycle`; it is dropped once this is false. */
    keep(h: H, cycle: number): boolean;
}

export class HapField<T extends FieldTeam, H extends FieldHap<T>> {
    readonly haps: H[] = [];
    readonly teams: T[] = [];
    /** Absolute cycle this frame and last frame. */
    cycle = 0;
    prevCycle = 0;
    /** Locked to a playing pattern. */
    locked = false;
    /** True for the frame a start or seek rebuilt the field. */
    restarted = false;

    private sane = false;
    private lastBar = -1;
    private lastPattern: PatternHandle | null = null;
    private registryVersion = -1;
    private themeKey = '';
    private nextSlot = 0;
    private readonly names: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private readonly byKey = new Map<string, H>();
    private readonly byName = new Map<string, T>();
    private readonly seenKeys = new Set<string>();

    constructor(private readonly config: HapFieldConfig<T, H>) {}

    /** Force a fresh query on the next update (after a resize, say). */
    invalidate(): void {
        this.lastBar = -1;
    }

    update(dt: number, s: VizServices): void {
        const source = s.patternSource;
        const pattern = source?.scheduler.pattern ?? null;
        const bar = Math.floor(s.cycle);
        const themeKey = s.theme.bg + s.theme.neon + s.theme.neonSecondary;
        const paletteChanged = themeKey !== this.themeKey;
        this.themeKey = themeKey;

        this.restarted = false;
        this.prevCycle = this.cycle;
        if (pattern) {
            const target = s.cycle;
            if (!this.locked || target < this.cycle || target - this.cycle >= 2) {
                // Start or seek: rebuild the field at the destination.
                this.haps.length = 0;
                this.byKey.clear();
                this.lastBar = -1;
                this.cycle = target;
                this.prevCycle = target - 1e-7;
                this.locked = true;
                this.restarted = true;
            } else {
                this.cycle = target;
            }
        } else {
            this.locked = false;
            this.cycle += dt * this.config.idleRate;
        }

        if (pattern && source && (pattern !== this.lastPattern || bar !== this.lastBar || paletteChanged)) {
            const crossedBar = pattern === this.lastPattern && bar !== this.lastBar;
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern, source, bar, s.theme, crossedBar);
        }
        if (!pattern) {
            this.lastPattern = null;
            this.lastBar = -1;
            for (const h of this.haps) h.seen = false;
            for (const t of this.teams) t.present = false;
        }

        const travelled = this.cycle - this.prevCycle;
        this.sane = pattern !== null && travelled > 0 && travelled < 2;

        for (let n = this.haps.length - 1; n >= 0; n--) {
            const h = this.haps[n];
            if (!h.seen) h.fade -= dt * 2.5;
            if (h.fade <= 0 || !this.config.keep(h, this.cycle)) {
                this.haps.splice(n, 1);
                this.byKey.delete(h.key);
            }
        }
        const k = Math.exp(-dt * 2.5);
        for (let n = this.teams.length - 1; n >= 0; n--) {
            const t = this.teams[n];
            t.activity *= k;
            if (!t.present) {
                t.fade -= dt * 2.5;
                if (t.fade <= 0) {
                    this.teams.splice(n, 1);
                    this.byName.delete(t.name);
                }
            } else {
                t.fade = Math.min(1, t.fade + dt * 4);
            }
        }
    }

    /** True when `h` reached its onset this frame during ordinary playback. */
    crossed(h: H): boolean {
        return this.sane && h.seen && !h.done && h.begin > this.prevCycle && h.begin <= this.cycle;
    }

    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme, crossedBar: boolean): void {
        const {config} = this;
        pattern.queryCycleViewData(bar, config.lookahead);
        const view = () => new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);
        let data = view();
        const trackCount = data[0];
        if (data[2] !== this.registryVersion) {
            this.registryVersion = data[2];
            this.names.fill(undefined);
        }

        this.seenKeys.clear();
        for (const t of this.teams) t.present = false;
        const budget = Math.min(config.maxPerTrack, Math.max(1, Math.floor(config.maxHaps / Math.max(1, trackCount))));
        const pool = theme.accentPool;

        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];
            let name = this.names[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.names[trackId] = name;
            }
            const hint = pattern.getTrackColor(trackId);
            // Name and color lookups can grow WASM memory, detaching the view.
            data = view();
            const team = this.teamFor(name);
            team.present = true;
            team.hinted = hint !== undefined;
            team.pitched = eventCount > 0 && Number.isFinite(data[idx + 2]);
            const fallback = pool[team.slot % pool.length];
            team.rgb = (hint === undefined ? config.recolor?.(team) : null) ?? (hint !== undefined ? rgbOf(hint, fallback) : fallback);
            team.css = `rgb(${team.rgb[0]}, ${team.rgb[1]}, ${team.rgb[2]})`;

            const base = idx;
            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            let kept = 0;
            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= config.lookahead) continue;
                const absBegin = bar + Math.max(0, begin);
                const absEnd = bar + Math.min(end, config.lookahead);

                // A query-clipped part continuing a known hap across the bar
                // line extends it rather than appearing as a fresh onset.
                if (begin <= 0) {
                    const cont = this.haps.find((h) => h.team === team && Object.is(h.note, note) &&
                        h.begin < bar && h.end > bar + 1e-6);
                    if (cont) {
                        cont.end = Math.max(cont.end, absEnd);
                        cont.seen = true;
                        this.seenKeys.add(cont.key);
                        kept++;
                        continue;
                    }
                }
                if (absEnd < Math.min(this.cycle - 0.1, this.prevCycle)) continue;

                const pitched = Number.isFinite(note);
                const seed = hash32(team.slot * 977 + (pitched ? note * 131 : 0), Math.round(absBegin * 4096));
                const key = seed + '|' + absBegin.toFixed(6);
                this.seenKeys.add(key);
                const existing = this.byKey.get(key);
                if (existing) {
                    existing.seen = true;
                    existing.fade = 1;
                    existing.end = Math.max(existing.end, absEnd);
                    kept++;
                    continue;
                }
                const cap = config.cap ? Math.min(budget, config.cap(team, note, absEnd - absBegin)) : budget;
                if (this.haps.length >= config.maxHaps || kept >= cap) continue;
                kept++;
                const hap = config.hap({team, note, key, seed, begin: absBegin, end: absEnd,
                    seen: true, fade: 1, done: absBegin <= this.prevCycle});
                this.haps.push(hap);
                this.byKey.set(key, hap);
            }
            idx = base + eventCount * 3;
        }

        // Anything no longer scheduled fades out and can no longer fire.
        for (const h of this.haps) {
            h.seen = this.seenKeys.has(h.key) || (crossedBar && h.begin > this.prevCycle && h.begin <= this.cycle);
        }
    }

    private teamFor(name: string): T {
        let t = this.byName.get(name);
        if (t) return t;
        t = this.config.team({name, slot: this.nextSlot++, family: instrumentFamily(name), hinted: false, pitched: false,
            rgb: [71, 246, 255], css: 'rgb(71, 246, 255)', activity: 0, present: true, fade: 1});
        this.byName.set(name, t);
        this.teams.push(t);
        return t;
    }
}
