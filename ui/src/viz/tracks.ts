/**
 * Shared pattern → track model for schedule-driven modes (LENS BENCH,
 * SPOT FIELD). Reconciles "which tracks exist this bar and when do their haps
 * fire" from the WASM cycle-view query; modes with a spatial model of their
 * own (ISO CITY) parse the buffer themselves but share these constants.
 *
 * Buffer discipline: the cycle-view buffer is a single shared static in WASM
 * memory — parse it fully and synchronously, immediately after your own
 * query, and recreate the Float32Array view on every call (memory growth
 * detaches cached views).
 */

import type {PatternHandle} from '../../pkg';
import type {PatternSource, Theme} from './types.js';
import {rgbOf} from './util.js';

/** Must match CYCLE_VIEW_CAPACITY in strudel-audio-wasm — bounds all reads. */
export const VIEW_CAPACITY = 4096;
/** Must match CYCLE_VIEW_EVENTS_CAPACITY, the engine's pre-packing scratch cap. */
const VIEW_EVENT_CAPACITY = 1024;
export const MAX_TRACKS = 128;
/** Per-track, per-bar hap cap — `note("c*2048")`-proofing. */
export const MAX_EVENTS_PER_TRACK = 64;

export interface VizTrack {
    name: string;
    /** Assignment order — accent-pool rotation for tracks without `.color()`. */
    slot: number;
    accent: [number, number, number];
    accentCss: string;
    /**
     * Bar-relative hap data, parallel arrays truncated to the cap. Begins run
     * 0..1 for the current bar, and on up to the model's `bars` span when it
     * looks ahead (1..2 = the next bar).
     */
    begins: Float32Array;
    ends: Float32Array;
    /** MIDI note 0-127, or NaN for unpitched haps. */
    notes: Float32Array;
    count: number;
    /** Smoothed onset envelope — bumped on hap onsets, exponential decay. */
    activity: number;
    /** Scratch flag during rebuild: still present in the queried bar. */
    seen: boolean;
}

/** Drum family read from a track's sound name; `perc` for anything else. */
export type InstrumentFamily = 'kick' | 'snare' | 'hat' | 'perc';

export function instrumentFamily(name: string): InstrumentFamily {
    const n = name.toLowerCase();
    if (/^(bd|kick|808)/.test(n)) return 'kick';
    if (/^(sd|sn|cp|clap|rim|lt|mt|ht)/.test(n)) return 'snare';
    if (/^(hh|oh|hat|shaker|cb|rd|cr)/.test(n)) return 'hat';
    return 'perc';
}

/** Called once per hap whose onset was crossed this frame; `e` indexes the track's arrays. */
export type OnsetHandler = (track: VizTrack, e: number) => void;

export interface TrackSync {
    pattern: PatternHandle | null;
    bar: number;
    /** Query again on a new pattern handle or bar. */
    rebuild: boolean;
    /** Bar phase pair for onset scanning: fire haps with begin ∈ (prev, phase]. */
    phase: number;
    prevPhase: number;
}

/** Shared onset window for flat tracks and modes with their own spatial model. */
export class PatternTimeline {
    // Handles are retained for identity only; never call methods on them here.
    private lastPattern: PatternHandle | null = null;
    private lastBar = -1;
    private prevPhase = 0;

    sync(pattern: PatternHandle | null, cycle: number): TrackSync {
        const bar = Math.floor(cycle);
        const phase = cycle - bar;
        const rebuild = pattern !== null && (pattern !== this.lastPattern || bar !== this.lastBar);
        let prevPhase = this.prevPhase;
        if (rebuild) {
            const nextBar = this.lastPattern !== null && bar === this.lastBar + 1;
            const sameBar = this.lastPattern !== null && bar === this.lastBar;
            // Keep the window on live edits. Entering mid-bar or seeking must
            // not replay past haps, but a fresh start at zero includes its hit.
            if (nextBar || (!sameBar && cycle === 0)) prevPhase = -1e-6;
            else if (!sameBar) prevPhase = phase;
        }
        this.lastPattern = pattern;
        this.lastBar = bar;
        this.prevPhase = phase;
        return {pattern, bar, rebuild, phase, prevPhase};
    }
}

export class TrackModel {
    readonly tracks: VizTrack[] = [];
    private readonly byName = new Map<string, VizTrack>();
    private readonly names: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private readonly timeline = new PatternTimeline();
    private nextSlot = 0;
    private registryVersion = -1;
    /** Scratch counts: each queried bar gets its own per-track budget. */
    private readonly barCounts: Uint16Array;

    /**
     * @param bars How many bars each rebuild reads, starting at the current
     *   one. Modes that draw notes approaching before they sound pass 2;
     *   onsets still fire only for the current bar.
     */
    constructor(private readonly bars = 1) {
        this.barCounts = new Uint16Array(bars);
    }

    /**
     * Query/reconcile for the current bar; rebuilds on live edit (each
     * evaluate creates a new handle) and on bar boundaries. The stored handle
     * is for identity comparison only — never call methods on it.
     */
    sync(source: PatternSource | null, cycle: number, theme: Theme): TrackSync {
        const pattern = source?.scheduler.pattern ?? null;
        const sync = this.timeline.sync(pattern, cycle);
        if (sync.rebuild && pattern && source) this.rebuild(pattern, source, sync.bar, theme);
        return sync;
    }

    /**
     * Visit every hap whose onset lies in (prevPhase, phase] of this frame's
     * sync, bumping the track's activity envelope by `bump`. No-op when
     * stopped or when the phase wrapped backwards (seek / bar rebuild).
     */
    forEachOnset(sync: TrackSync, fn: OnsetHandler, bump = 0.5): void {
        if (!sync.pattern || sync.phase < sync.prevPhase) return;
        for (const track of this.tracks) {
            for (let e = 0; e < track.count; e++) {
                const begin = track.begins[e];
                if (begin > sync.prevPhase && begin <= sync.phase) {
                    track.activity = Math.min(1, track.activity + bump);
                    fn(track, e);
                }
            }
        }
    }

    /** Decay all track activity envelopes; call once per frame. */
    decay(dt: number): void {
        const k = Math.exp(-dt * 2.5);
        for (const t of this.tracks) t.activity *= k;
    }

    private queryData(pattern: PatternHandle, source: PatternSource, bar: number, span: number): Float32Array {
        pattern.queryCycleViewData(bar, span);
        // Fresh view per query — WASM memory growth detaches cached views.
        return new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);
    }

    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme): void {
        let span = this.bars;
        let data = this.queryData(pattern, source, bar, span);
        if (span > 1) {
            let used = 3;
            let events = 0;
            for (let t = 0; t < data[0] && used + 2 <= VIEW_CAPACITY; t++) {
                const count = data[used + 1];
                events += count;
                used += 2 + count * 3;
            }
            // A full shared buffer may have omitted current-bar haps behind
            // future ones. Drop lookahead for this rebuild and query only the
            // current bar. Normally keep a single multi-bar query: separate
            // queries clip held notes and turn them into false future onsets.
            if (events >= VIEW_EVENT_CAPACITY || used + 5 > VIEW_CAPACITY) {
                span = 1;
                data = this.queryData(pattern, source, bar, span);
            }
        }

        const trackCount = data[0];
        const registryVersion = data[2];
        if (registryVersion !== this.registryVersion) {
            this.registryVersion = registryVersion;
            this.names.fill(undefined);
        }

        for (const t of this.tracks) t.seen = false;

        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];

            let name = this.names[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.names[trackId] = name;
            }

            let track = this.byName.get(name);
            if (!track) {
                track = {
                    name,
                    slot: this.nextSlot++,
                    accent: [71, 246, 255],
                    accentCss: 'rgb(71, 246, 255)',
                    begins: new Float32Array(MAX_EVENTS_PER_TRACK * this.bars),
                    ends: new Float32Array(MAX_EVENTS_PER_TRACK * this.bars),
                    notes: new Float32Array(MAX_EVENTS_PER_TRACK * this.bars),
                    count: 0,
                    activity: 0,
                    seen: true,
                };
                this.byName.set(name, track);
                this.tracks.push(track);
            } else {
                track.seen = true;
            }

            // Accent recomputed each rebuild: tracks theme changes and edits
            // to the pattern's `.color()` hint. Cheap — a handful of strings.
            const pool = theme.accentPool;
            const fallback = pool[track.slot % pool.length];
            const hint = pattern.getTrackColor(trackId);
            const accent = hint !== undefined ? rgbOf(hint, fallback) : fallback;
            track.accent = accent;
            track.accentCss = `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`;

            let n = 0;
            this.barCounts.fill(0);
            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= span) continue;
                const onset = Math.max(0, begin);
                const eventBar = Math.floor(onset);
                if (this.barCounts[eventBar] < MAX_EVENTS_PER_TRACK) {
                    this.barCounts[eventBar]++;
                    track.begins[n] = onset;
                    track.ends[n] = Math.min(end, span);
                    track.notes[n] = note;
                    n++;
                }
            }
            idx += (eventCount - nEvents) * 3;
            track.count = n;
        }

        // Tracks gone from the pattern go quiet and drop once faded.
        for (let n = this.tracks.length - 1; n >= 0; n--) {
            const t = this.tracks[n];
            if (!t.seen) {
                t.count = 0;
                if (t.activity < 0.02) {
                    this.tracks.splice(n, 1);
                    this.byName.delete(t.name);
                }
            }
        }
    }
}
