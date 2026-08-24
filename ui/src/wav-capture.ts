/**
 * Lossless WAV capture: drains the tap worklet's ring buffer to disk.
 *
 * 32-bit float, at the context's own sample rate. Float rather than 16/24-bit
 * integer because it is bit-exact with what the engine produced and cannot clip
 * on the way out — if a pattern peaks over 0 dBFS the recording still holds the
 * real samples, so it can be brought down in post instead of arriving squared
 * off. Every DAW and ffmpeg reads it.
 *
 * Nothing is buffered for the length of the take: the worklet writes into a
 * fixed ring, this drains it on a timer, and the Rust sink appends straight to
 * a file. Memory is flat whether the take is one minute or three hours.
 *
 * The sample rate is deliberately whatever `AudioContext` chose (usually 48 kHz)
 * rather than a constant — resampling here would defeat the point, and the
 * offline exporter's 44.1 kHz belongs to a different pipeline.
 */

import {invoke, invokeRaw, isTauri} from './tauri.js';

/** Ring capacity, in seconds of audio. Far more than the drain interval needs. */
const RING_SECONDS = 8;
const DRAIN_MS = 250;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 4;
/** WAVE_FORMAT_IEEE_FLOAT */
const FORMAT_FLOAT = 3;

/** Control-header slots; mirrors the `Ctrl` enum in wav-tap-worklet.ts. */
const CTRL_WRITE = 0;
const CTRL_READ = 1;
const CTRL_OVERRUNS = 2;
const HEADER_BYTES = 16;

// --- WAV header layout ------------------------------------------------------
// fmt is the 18-byte form and a fact chunk is present, which is what the spec
// requires for non-PCM formats. Sizes that aren't known until the end are
// patched in place at close.
const WAV_HEADER_BYTES = 58;
const OFFSET_RIFF_SIZE = 4;
const OFFSET_FACT_FRAMES = 46;
const OFFSET_DATA_SIZE = 54;

function ascii(view: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function wavHeader(sampleRate: number): Uint8Array {
    const bytes = new Uint8Array(WAV_HEADER_BYTES);
    const view = new DataView(bytes.buffer);
    const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

    ascii(view, 0, 'RIFF');
    view.setUint32(OFFSET_RIFF_SIZE, 0, true); // patched at close
    ascii(view, 8, 'WAVE');

    ascii(view, 12, 'fmt ');
    view.setUint32(16, 18, true);
    view.setUint16(20, FORMAT_FLOAT, true);
    view.setUint16(22, CHANNELS, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
    view.setUint16(36, 0, true); // cbSize

    ascii(view, 38, 'fact');
    view.setUint32(42, 4, true);
    view.setUint32(OFFSET_FACT_FRAMES, 0, true); // patched at close

    ascii(view, 50, 'data');
    view.setUint32(OFFSET_DATA_SIZE, 0, true); // patched at close

    return bytes;
}

export interface CaptureResult {
    path: string;
    frames: number;
    seconds: number;
    sampleRate: number;
    /** Blocks the audio thread had to drop because the drain fell behind. */
    overruns: number;
}

/** Loaded once per context; the module registration is not idempotent. */
const registered = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(ctx: AudioContext): Promise<void> {
    let ready = registered.get(ctx);
    if (!ready) {
        ready = import('../wav-tap-worklet.ts?worker&url')
            .then((m) => ctx.audioWorklet.addModule(m.default));
        registered.set(ctx, ready);
    }
    return ready;
}

export class WavCapture {
    private node: AudioWorkletNode | null = null;
    private source: AudioNode | null = null;
    private ctrl: Int32Array | null = null;
    private data: Float32Array | null = null;
    private capacity = 0;
    private timer: ReturnType<typeof setInterval> | null = null;

    private sinkId: number | null = null;
    private sampleRate = 0;
    private frames = 0;
    /** Serializes writes so chunks can't reach the sink out of order. */
    private tail: Promise<unknown> = Promise.resolve();
    private failure: string | null = null;

    isActive(): boolean {
        return this.sinkId !== null;
    }

    /** Frames captured so far — the honest elapsed time, on the audio clock. */
    elapsedSeconds(): number {
        return this.sampleRate > 0 ? this.frames / this.sampleRate : 0;
    }

    /**
     * Begin capturing `source` to `path`.
     *
     * @returns free bytes on the destination volume, for a remaining-time readout.
     */
    async start(ctx: AudioContext, source: AudioNode, path: string): Promise<number> {
        if (this.sinkId !== null) throw new Error('already recording');
        if (!isTauri) throw new Error('Recording requires the desktop app');

        await ensureWorklet(ctx);

        this.sampleRate = ctx.sampleRate;
        this.capacity = Math.ceil(this.sampleRate * RING_SECONDS);
        this.frames = 0;
        this.failure = null;

        const ring = new SharedArrayBuffer(
            HEADER_BYTES + this.capacity * CHANNELS * BYTES_PER_SAMPLE,
        );
        this.ctrl = new Int32Array(ring, 0, HEADER_BYTES / 4);
        this.data = new Float32Array(ring, HEADER_BYTES, this.capacity * CHANNELS);

        const {id, free_bytes} = await invoke<{id: number; free_bytes: number}>(
            'recording_open',
            {
                path,
                meta: {
                    kind: 'wav',
                    sample_rate: this.sampleRate,
                    channels: CHANNELS,
                    started_at: new Date().toISOString(),
                },
            },
        );
        this.sinkId = id;

        await this.write(wavHeader(this.sampleRate));

        this.node = new AudioWorkletNode(ctx, 'wav-tap', {
            numberOfInputs: 1,
            // A sink: zero outputs, pulled purely by having a connected input,
            // so the tap can never colour what you hear.
            numberOfOutputs: 0,
            channelCount: CHANNELS,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            processorOptions: {ring, capacity: this.capacity},
        });

        this.source = source;
        source.connect(this.node);

        this.timer = setInterval(() => void this.drain(), DRAIN_MS);
        return free_bytes;
    }

    /**
     * Stop capturing and finalize the file.
     *
     * Always tears the graph down, even if the last writes fail — leaving a tap
     * connected would keep the ring filling with nowhere to go.
     */
    async stop(commit = true): Promise<CaptureResult | null> {
        const id = this.sinkId;
        if (id === null) return null;

        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        try {
            this.source?.disconnect(this.node!);
        } catch {
            // Graph may already be torn down (crash recovery) — nothing to undo.
        }
        this.node?.disconnect();

        const overruns = this.ctrl ? Atomics.load(this.ctrl, CTRL_OVERRUNS) : 0;

        // One last pass so the tail of the take isn't lost in the ring.
        await this.drain();
        await this.tail;

        if (this.failure === null && this.frames > 0) await this.patchSizes();

        const keep = commit && this.failure === null && this.frames > 0;
        const closed = await invoke<{path: string; bytes: number}>('recording_close', {
            id,
            commit: keep,
        });

        const frames = this.frames;
        const sampleRate = this.sampleRate;
        const failure = this.failure;
        this.reset();

        if (failure !== null) throw new Error(failure);
        if (!keep) return null;

        return {
            path: closed.path,
            frames,
            seconds: frames / sampleRate,
            sampleRate,
            overruns,
        };
    }

    private reset(): void {
        this.sinkId = null;
        this.node = null;
        this.source = null;
        this.ctrl = null;
        this.data = null;
        this.frames = 0;
        this.failure = null;
        this.tail = Promise.resolve();
    }

    /** Copy everything the worklet has published since the last pass. */
    private async drain(): Promise<void> {
        const ctrl = this.ctrl;
        const data = this.data;
        if (!ctrl || !data || this.sinkId === null || this.failure !== null) return;

        // Acquire: read the published position before touching the frames it covers.
        const write = Atomics.load(ctrl, CTRL_WRITE);
        const read = Atomics.load(ctrl, CTRL_READ);
        const available = (write - read + this.capacity) % this.capacity;
        if (available === 0) return;

        const out = new Float32Array(available * CHANNELS);
        const firstRun = Math.min(available, this.capacity - read);
        out.set(data.subarray(read * CHANNELS, (read + firstRun) * CHANNELS), 0);
        if (firstRun < available) {
            out.set(
                data.subarray(0, (available - firstRun) * CHANNELS),
                firstRun * CHANNELS,
            );
        }

        Atomics.store(ctrl, CTRL_READ, (read + available) % this.capacity);
        this.frames += available;

        await this.write(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    }

    /** Queue a chunk behind whatever is already in flight. */
    private write(bytes: Uint8Array, offset?: number): Promise<unknown> {
        const id = this.sinkId;
        if (id === null) return this.tail;

        const headers: Record<string, string> = {'x-rec-id': String(id)};
        if (offset !== undefined) headers['x-rec-offset'] = String(offset);

        this.tail = this.tail
            .then(() => invokeRaw<number>('recording_write', bytes, headers))
            .catch((e: unknown) => {
                // Record the first failure and stop writing; stop() reports it.
                this.failure ??= e instanceof Error ? e.message : String(e);
            });
        return this.tail;
    }

    /** Fill in the three length fields the header couldn't know up front. */
    private async patchSizes(): Promise<void> {
        const dataBytes = this.frames * CHANNELS * BYTES_PER_SAMPLE;

        const u32 = (value: number) => {
            const buf = new Uint8Array(4);
            new DataView(buf.buffer).setUint32(0, value, true);
            return buf;
        };

        await this.write(u32(WAV_HEADER_BYTES - 8 + dataBytes), OFFSET_RIFF_SIZE);
        await this.write(u32(this.frames), OFFSET_FACT_FRAMES);
        await this.write(u32(dataBytes), OFFSET_DATA_SIZE);
        await this.tail;
    }
}

export const wavCapture = new WavCapture();
