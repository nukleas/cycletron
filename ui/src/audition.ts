/**
 * Preview a single sample on click, from anywhere that lists sounds.
 *
 * Routing is the part that matters: auditions go to the **cue bus**
 * (`audio-manager.ts` `getCueBus()`), which sits *after* the capture tap. They
 * are audible to the performer and can never leak into a recording or a WAV
 * export — the same treatment the metronome click gets. Sending them to the
 * performance bus instead would silently corrupt every capture made while
 * browsing.
 *
 * No new Rust: `read_audio_file` already returns raw bytes for any path, and
 * bundled samples are same-origin URLs.
 */

import {invoke} from './tauri.js';
import type {SampleRef} from './sound-catalog.js';

/** Decoded buffers, insertion-ordered so the map doubles as an LRU queue. */
const CACHE_LIMIT = 64;
const cache = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer>>();

/** Longest a preview may hold the room — a long break should not lock the bus. */
const MAX_PREVIEW_SECONDS = 6;

let previewCtx: AudioContext | null = null;
let current: {source: AudioBufferSourceNode; gain: GainNode} | null = null;
let currentKey: string | null = null;

const listeners = new Set<(key: string | null) => void>();

/** Subscribe to "which sample is sounding" so rows can render a playing state. */
export function onAuditionChange(fn: (key: string | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function setPlaying(key: string | null): void {
    currentKey = key;
    for (const fn of listeners) fn(key);
}

/** The key a ref caches and compares under. */
export function refKey(ref: SampleRef): string {
    return ref.kind === 'url' ? ref.url : ref.path;
}

export function playingKey(): string | null {
    return currentKey;
}

/**
 * Prefer the engine's context so previews share its clock and device. Fall back
 * to a module-local one — browsing sounds before pressing Play is a real flow —
 * and retire that fallback as soon as the engine is up, so we never hold two
 * output devices open.
 */
function audioContext(): AudioContext {
    const engine = window.strudelApp?.audioManager?.getAudioContext?.();
    if (engine) {
        if (previewCtx) {
            void previewCtx.close().catch(() => {});
            previewCtx = null;
        }
        return engine;
    }
    previewCtx ??= new AudioContext();
    return previewCtx;
}

/** Audible, never captured. Falls back to the destination before the bus exists. */
function destination(ctx: AudioContext): AudioNode {
    return window.strudelApp?.audioManager?.getCueBus?.() ?? ctx.destination;
}

async function fetchBytes(ref: SampleRef): Promise<ArrayBuffer> {
    if (ref.kind === 'url') {
        const resp = await fetch(ref.url, {mode: 'cors'});
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        return resp.arrayBuffer();
    }
    return invoke<ArrayBuffer>('read_audio_file', {path: ref.path});
}

async function decode(ctx: AudioContext, ref: SampleRef): Promise<AudioBuffer> {
    const key = refKey(ref);
    const hit = cache.get(key);
    if (hit) {
        // Promote to the tail: insertion order is the LRU order.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    const pending = inflight.get(key);
    if (pending) return pending;

    const job = (async () => {
        const bytes = await fetchBytes(ref);
        // decodeAudioData detaches its input, so decode from a copy — the same
        // bytes may be re-decoded after a context swap.
        const buf = await ctx.decodeAudioData(bytes.slice(0));
        cache.set(key, buf);
        while (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
        return buf;
    })().finally(() => inflight.delete(key));

    inflight.set(key, job);
    return job;
}

/** Stop whatever is sounding. Safe to call when nothing is. */
export function stopAudition(): void {
    if (!current) return;
    const {source, gain} = current;
    current = null;
    try {
        // Short ramp instead of a hard stop: scrubbing a list with the arrow
        // keys would otherwise click on every row.
        const ctx = gain.context;
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.008);
        source.stop(ctx.currentTime + 0.02);
    } catch {
        /* already stopped */
    }
    setPlaying(null);
}

/**
 * Play one sample. Exactly one preview sounds at a time, so arrow-scrubbing a
 * 300-row list cannot stack 300 voices.
 */
export async function auditionSample(ref: SampleRef): Promise<void> {
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    const key = refKey(ref);
    let buffer: AudioBuffer;
    try {
        buffer = await decode(ctx, ref);
    } catch (e) {
        stopAudition();
        throw e;
    }

    stopAudition();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.8, ctx.currentTime);
    source.connect(gain).connect(destination(ctx));

    source.onended = () => {
        if (current?.source === source) {
            current = null;
            setPlaying(null);
        }
    };

    source.start();
    source.stop(ctx.currentTime + Math.min(buffer.duration + 0.05, MAX_PREVIEW_SECONDS));
    current = {source, gain};
    setPlaying(key);
}
