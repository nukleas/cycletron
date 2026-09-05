/**
 * Lossless capture tap.
 *
 * Copies whatever is routed into it, verbatim, into a shared ring buffer that
 * the main thread drains and streams to disk. No encoding happens here — the
 * audio thread's only job is a memcpy, so a long take can't turn into a
 * dropout.
 *
 * Deliberately *not* MediaRecorder: that path is lossy (Opus), and decoding it
 * back to PCM at the end held the compressed chunks, the decoded buffer, and
 * the output all in memory at once. A ring buffer is bounded no matter how
 * long the recording runs.
 *
 * The node has zero outputs — it is a sink, pulled by having its input
 * connected, and never contributes to what you hear.
 */

/** Control-header slots, as Int32 indices into the head of the ring. */
const enum Ctrl {
    /** Producer position, in frames, modulo capacity. Written here. */
    Write = 0,
    /** Consumer position, in frames, modulo capacity. Written by the main thread. */
    Read = 1,
    /** Blocks dropped because the consumer fell behind. */
    Overruns = 2,
}

/** Bytes reserved for the control header before the audio data begins. */
const HEADER_BYTES = 16;

class WavTapProcessor extends AudioWorkletProcessor<'wav-tap'> {
    private readonly ctrl: Int32Array;
    private readonly data: Float32Array;
    private readonly capacity: number;

    constructor(options: TypedAudioWorkletNodeOptions<'wav-tap'>) {
        super();
        const {ring, capacity} = options.processorOptions;
        this.ctrl = new Int32Array(ring, 0, HEADER_BYTES / 4);
        this.data = new Float32Array(ring, HEADER_BYTES, capacity * 2);
        this.capacity = capacity;
    }

    process(inputs: Float32Array[][]): boolean {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        const left = input[0];
        // Mono sources feed both sides rather than recording silence on the right.
        const right = input[1] ?? left;
        const frames = left.length;
        if (frames === 0) return true;

        const write = Atomics.load(this.ctrl, Ctrl.Write);
        const read = Atomics.load(this.ctrl, Ctrl.Read);

        // One frame is held back so a full ring stays distinguishable from an
        // empty one.
        const free = (read - write - 1 + this.capacity) % this.capacity;
        if (free < frames) {
            Atomics.add(this.ctrl, Ctrl.Overruns, 1);
            return true;
        }

        let at = write;
        for (let i = 0; i < frames; i++) {
            const slot = at * 2;
            this.data[slot] = left[i];
            this.data[slot + 1] = right[i];
            at = at + 1 === this.capacity ? 0 : at + 1;
        }
        // Release: publishing the position last guarantees the consumer never
        // sees an index pointing at frames we haven't written yet.
        Atomics.store(this.ctrl, Ctrl.Write, at);

        return true;
    }
}

registerProcessor('wav-tap', WavTapProcessor);
