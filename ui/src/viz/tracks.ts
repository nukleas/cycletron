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
export const MAX_TRACKS = 128;
/** Per-track hap cap — `note("c*2048")`-proofing. */
export const MAX_EVENTS_PER_TRACK = 64;

export interface VizTrack {
    name: string;
    /** Assignment order — accent-pool rotation for tracks without `.color()`. */
    slot: number;
    accent: [number, number, number];
    accentCss: string;
    /** Bar-relative hap data, parallel arrays truncated to the cap. */
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

export interface TrackSync {
    pattern: PatternHandle | null;
    /** Bar phase pair for onset scanning: fire haps with begin ∈ (prev, phase]. */
    phase: number;
    prevPhase: number;
}

export class TrackModel {
    readonly tracks: VizTrack[] = [];
    private readonly byName = new Map<string, VizTrack>();
    private readonly names: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private lastPattern: PatternHandle | null = null;
    private lastBar = -1;
    private prevPhase = 0;
    private nextSlot = 0;
    private registryVersion = -1;

    /**
     * Query/reconcile for the current bar; rebuilds on live edit (each
     * evaluate creates a new handle) and on bar boundaries. The stored handle
     * is for identity comparison only — never call methods on it.
     */
    sync(source: PatternSource | null, cycle: number, theme: Theme): TrackSync {
        const pattern = source?.scheduler.pattern ?? null;
        const bar = Math.floor(cycle);

        if (pattern && source && (pattern !== this.lastPattern || bar !== this.lastBar)) {
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern, source, bar, theme);
            // Let begin=0 haps fire on the downbeat we just crossed.
            this.prevPhase = -1e-6;
        }
        if (!pattern) this.lastPattern = null;

        const phase = cycle - bar;
        const prevPhase = this.prevPhase;
        this.prevPhase = phase;
        return { pattern, phase, prevPhase };
    }

    /** Decay all track activity envelopes; call once per frame. */
    decay(dt: number): void {
        const k = Math.exp(-dt * 2.5);
        for (const t of this.tracks) t.activity *= k;
    }

    private rebuild(pattern: PatternHandle, source: PatternSource, bar: number, theme: Theme): void {
        pattern.queryCycleViewData(bar, 1);
        // Fresh view per query — WASM memory growth detaches cached views.
        const data = new Float32Array(source.memory.buffer, source.cycleViewPtr, VIEW_CAPACITY);

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
                    begins: new Float32Array(MAX_EVENTS_PER_TRACK),
                    ends: new Float32Array(MAX_EVENTS_PER_TRACK),
                    notes: new Float32Array(MAX_EVENTS_PER_TRACK),
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
            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= 1) continue;
                if (n < MAX_EVENTS_PER_TRACK) {
                    track.begins[n] = begin < 0 ? 0 : begin;
                    track.ends[n] = Math.min(end, 1);
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
