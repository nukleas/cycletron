/**
 * OSC output — stream the transport and every hap onset out over UDP.
 *
 * This is how Cycletron drives the rest of the live-coding ecosystem: Hydra,
 * Resolume, TouchDesigner, SuperCollider, DMX lighting. The Rust side
 * (`src-tauri/src/osc.rs`) owns the socket and documents the address space;
 * this module owns the timing and decides what counts as an onset.
 *
 * Onsets are detected the same way the schedule-driven visualizers do it: the
 * engine's cycle-view buffer is re-read once per bar, then each frame emits the
 * haps whose `begin` falls in the phase span just crossed. That puts emission
 * on a frame boundary, which is right for visuals and lighting. It is *not*
 * sample-accurate — driving a hardware sampler from this would need the engine
 * to expose full per-hap parameter maps, which it currently does not.
 *
 * Buffer discipline (same contract as `viz/tracks.ts`): the cycle-view buffer
 * is a single shared static in WASM memory. Parse it fully and synchronously
 * right after issuing your own query, and rebuild the `Float32Array` view every
 * time — memory growth detaches cached views.
 */

import type {PatternHandle} from '../pkg';
import {invoke, isTauri} from './tauri.js';

/** Must match CYCLE_VIEW_CAPACITY in strudel-audio-wasm — bounds all reads. */
const VIEW_CAPACITY = 4096;
/** Per-track hap cap, matching the visualizer's. Guards `note("c*2048")`. */
const MAX_EVENTS_PER_TRACK = 64;
const MAX_TRACKS = 128;
/** Haps held while a send is in flight. Bounds memory if IPC stalls for good. */
const MAX_PENDING = 4096;

const STORAGE_KEY = 'oscOut';

export interface OscSettings {
    enabled: boolean;
    host: string;
    port: number;
}

export const OSC_DEFAULTS: OscSettings = {enabled: false, host: '127.0.0.1', port: 57120};

interface OscTrack {
    name: string;
    begins: Float32Array;
    ends: Float32Array;
    notes: Float32Array;
    count: number;
}

/** What the frontend hands to `osc_frame`. */
interface HapPayload {
    track: string;
    note: number | null;
    dur: number;
    index: number;
}

/** Live pattern plus the WASM memory needed to read the cycle-view buffer. */
export interface OscSource {
    scheduler: {pattern: PatternHandle | null};
    memory: WebAssembly.Memory;
    cycleViewPtr: number;
}

class OscOut {
    settings: OscSettings = {...OSC_DEFAULTS};
    /** Resolved `host:port` reported by the backend, for the Preferences readout. */
    target = '';
    /** The last configure or send failure, for the Preferences readout. */
    lastError: string | null = null;

    private source: OscSource | null = null;
    private tracks: OscTrack[] = [];
    private names: (string | undefined)[] = new Array(MAX_TRACKS).fill(undefined);
    private registryVersion = -1;
    private lastPattern: PatternHandle | null = null;
    private lastBar = -1;
    private prevPhase = 0;
    private inFlight = false;
    /** Haps collected while a send was in flight; they go out with the next one. */
    private pending: HapPayload[] = [];
    /** Send failures are reported once per configuration, not once per frame. */
    private reported = false;
    private onError: ((error: string) => void) | null = null;

    /**
     * Restore the stored settings and apply them to the backend.
     *
     * `onError` hears the first send failure after each configure — wire it to
     * somewhere the user looks.
     *
     * @returns the configure error, if reopening the socket failed. The stored
     *          setting stays on, so each launch retries and reports.
     */
    async init(onError?: (error: string) => void): Promise<string | null> {
        this.onError = onError ?? null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) this.settings = {...OSC_DEFAULTS, ...JSON.parse(raw)};
        } catch {
            this.settings = {...OSC_DEFAULTS};
        }
        if (!this.settings.enabled) return null;
        return this.apply(this.settings);
    }

    attach(source: OscSource): void {
        this.source = source;
        // A re-attach means new WASM memory (first init, or crash recovery);
        // every cached read from the old instance is meaningless now.
        this.tracks.length = 0;
        this.names.fill(undefined);
        this.registryVersion = -1;
        this.lastPattern = null;
        this.lastBar = -1;
        this.prevPhase = 0;
        this.pending.length = 0;
    }

    get enabled(): boolean {
        return this.settings.enabled;
    }

    /**
     * Push settings to the backend socket. Returns an error string on failure,
     * leaving output disabled rather than silently half-configured. The choice
     * is stored before the backend answers, so a failure is retried on the
     * next launch rather than forgotten.
     */
    async apply(next: OscSettings): Promise<string | null> {
        this.settings = {...next};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
        this.reported = false;
        this.pending.length = 0;

        if (!isTauri) {
            this.target = '';
            this.lastError = this.settings.enabled ? 'OSC output needs the desktop app.' : null;
            return this.lastError;
        }

        try {
            const status = await invoke<{enabled: boolean; target: string}>('osc_configure', {
                enabled: this.settings.enabled,
                host: this.settings.host,
                port: this.settings.port,
            });
            this.target = status.target;
            this.lastError = null;
            return null;
        } catch (e) {
            this.settings.enabled = false;
            this.target = '';
            this.lastError = String(e);
            return this.lastError;
        }
    }

    /** Announce a transport change. */
    transport(state: 'playing' | 'paused' | 'stopped', bpm: number, cps: number): void {
        if (!this.settings.enabled || !isTauri) return;
        void invoke('osc_transport', {state, bpm, cps}).catch(this.sendFailed);
    }

    /**
     * Emit the frame at `cycle`: the transport position plus any hap that
     * started since the previous frame.
     *
     * Called from the render loop, so it must stay cheap and must never throw.
     */
    frame(cycle: number): void {
        if (!this.settings.enabled || !isTauri || !this.source) return;

        const haps = this.collectOnsets(cycle);
        if (this.pending.length + haps.length <= MAX_PENDING) this.pending.push(...haps);

        // One request in flight at a time: a stalled IPC round-trip must not
        // queue up frames faster than they drain. What this frame found waits
        // in `pending` and goes out with the next send.
        if (this.inFlight) return;
        this.inFlight = true;
        const batch = this.pending;
        this.pending = [];
        void invoke('osc_frame', {cycle, haps: batch})
            .catch(this.sendFailed)
            .finally(() => {
                this.inFlight = false;
            });
    }

    /** Record a failed send, and tell the user about the first one. */
    private sendFailed = (e: unknown): void => {
        this.lastError = String(e);
        if (this.reported) return;
        this.reported = true;
        console.warn('OSC send failed:', this.lastError);
        this.onError?.(this.lastError);
    };

    /**
     * The haps that started between the previous frame and `cycle`.
     *
     * Split out from {@link frame} so the onset scan can be exercised without a
     * socket. Advances the phase cursor, so callers other than the render loop
     * will steal onsets from it.
     */
    collectOnsets(cycle: number): HapPayload[] {
        if (!this.source) return [];

        const pattern = this.source.scheduler.pattern;
        if (!pattern) {
            // Stopped: the next start is a fresh bar, with no tail to flush.
            this.lastPattern = null;
            this.lastBar = -1;
            this.tracks.length = 0;
            return [];
        }

        const haps: HapPayload[] = [];
        const bar = Math.floor(cycle);
        if (bar !== this.lastBar) {
            // Moving on to the next bar: the old bar's tail since the last
            // frame played too. A jump (seek, stall, restart) has no tail.
            if (bar === this.lastBar + 1) this.scan(this.prevPhase, 1, haps);
            this.lastPattern = pattern;
            this.lastBar = bar;
            this.rebuild(pattern);
            // Let a hap sitting exactly on the downbeat fire this frame.
            this.prevPhase = -1e-6;
        } else if (pattern !== this.lastPattern) {
            // A new pattern mid-bar starts from here; what it would have
            // played earlier in the bar never sounded.
            this.lastPattern = pattern;
            this.rebuild(pattern);
        }

        const phase = cycle - bar;
        this.scan(this.prevPhase, phase, haps);
        this.prevPhase = phase;
        return haps;
    }

    /** Append the cached bar's haps that begin in `(from, to]`. */
    private scan(from: number, to: number, out: HapPayload[]): void {
        for (let t = 0; t < this.tracks.length; t++) {
            const track = this.tracks[t];
            for (let i = 0; i < track.count; i++) {
                const begin = track.begins[i];
                if (begin > from && begin <= to) {
                    const note = track.notes[i];
                    out.push({
                        track: track.name,
                        note: Number.isNaN(note) ? null : note,
                        dur: track.ends[i] - begin,
                        index: t,
                    });
                }
            }
        }
    }

    /** Re-read this bar's haps from the shared cycle-view buffer. */
    private rebuild(pattern: PatternHandle): void {
        pattern.queryCycleViewData(this.lastBar, 1);
        const data = new Float32Array(this.source!.memory.buffer, this.source!.cycleViewPtr, VIEW_CAPACITY);

        const trackCount = data[0];
        const registryVersion = data[2];
        if (registryVersion !== this.registryVersion) {
            this.registryVersion = registryVersion;
            this.names.fill(undefined);
        }

        this.tracks.length = 0;

        let idx = 3;
        for (let t = 0; t < trackCount && idx + 2 <= VIEW_CAPACITY; t++) {
            const trackId = data[idx++];
            const eventCount = data[idx++];

            let name = this.names[trackId];
            if (name === undefined) {
                name = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.names[trackId] = name;
            }

            const nEvents = Math.min(eventCount, Math.floor((VIEW_CAPACITY - idx) / 3));
            const begins = new Float32Array(MAX_EVENTS_PER_TRACK);
            const ends = new Float32Array(MAX_EVENTS_PER_TRACK);
            const notes = new Float32Array(MAX_EVENTS_PER_TRACK);
            let n = 0;

            for (let e = 0; e < nEvents; e++) {
                const begin = data[idx++];
                const end = data[idx++];
                const note = data[idx++];
                if (end <= 0 || begin >= 1) continue;
                if (n < MAX_EVENTS_PER_TRACK) {
                    begins[n] = begin < 0 ? 0 : begin;
                    ends[n] = Math.min(end, 1);
                    notes[n] = note;
                    n++;
                }
            }
            idx += (eventCount - nEvents) * 3;

            this.tracks.push({name, begins, ends, notes, count: n});
        }
    }
}

export const oscOut = new OscOut();
