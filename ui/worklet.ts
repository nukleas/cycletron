/**
 * Strudel AudioWorkletProcessor - Shared-Memory Architecture
 *
 * Both the main thread and this worklet use the SAME `WebAssembly.Memory`
 * (passed in `processorOptions.sharedMemory`).
 *
 * Hot path:
 *   1. Main Rust: queryEventsPacked() writes into CHANNEL.event_input,
 *                 does Atomics.store(event_count, N) [release fence] internally.
 *   2. This:      Atomics.swap(event_count, 0) [acquire fence]
 *   3. Rust:      drainEventInput(N) reads CHANNEL.event_input directly - no copy.
 *   4. Rust:      renderBlock() polls CHANNEL for gain/hush/panic, renders 128 samples.
 *
 * View stability:
 *   The backing buffer is a SharedArrayBuffer.  memory.grow() extends it in-place.
 *   All TypedArray views remain valid forever - no _refreshViews() needed.
 */

// this must be first - setups TextDecoder if not available before other imports.
import './polyfills.js';

import {initSync, take_last_panic, WorkletProcessor} from './pkg';
import {
    Cmd,
    RENDER_BLOCK,
    WorkletEvt,
    type WorkletInboundMsg
} from './src/types/event-queue.js';

declare const currentTime: number;

class StrudelProcessor extends AudioWorkletProcessor<'strudel-processor'> {
    private processor: WorkletProcessor | null = null;
    private ready = false;

    // Fixed byte offsets captured once at init - stable forever (no realloc possible
    // because WASM linear memory only grows, never moves).
    private readonly leftPtr: number = 0;
    private readonly rightPtr: number = 0;
    private readonly argsPtr: number = 0;

    // Persistent TypedArray views into the SHARED memory.
    // Never rebuilt - SharedArrayBuffer views survive memory.grow().
    private leftView: Float32Array | null = null;
    private rightView: Float32Array | null = null;
    private argsView: Float64Array | null = null;

    constructor(options: TypedAudioWorkletNodeOptions<'strudel-processor'>) {
        super();

        try {
            const {wasmModule, sampleRate, sharedMemory, rngSeed} = options.processorOptions;

            // Use the SAME memory object as the main thread.
            // Both instances compile the same binary, so CHANNEL is at the same
            // byte offset in both - they access the same physical bytes.
            initSync({module: wasmModule, memory: sharedMemory});

            this.processor = new WorkletProcessor(sampleRate, rngSeed >>> 0);

            // Capture pointer offsets once - they are stable for the lifetime of
            // this instance (the values live in the audio heap 4-12MB range).
            this.leftPtr = this.processor.getLeftPtr();
            this.rightPtr = this.processor.getRightPtr();
            this.argsPtr = this.processor.getArgsPtr();

            // Build views into the shared memory.  These never need rebuilding.
            const buf = sharedMemory.buffer;
            this.leftView = new Float32Array(buf, this.leftPtr, RENDER_BLOCK);
            this.rightView = new Float32Array(buf, this.rightPtr, RENDER_BLOCK);
            this.argsView = new Float64Array(buf, this.argsPtr, 4);

            this.ready = true;
            this.port.onmessage = (e) => this._onMessage(e.data);
            this.port.postMessage({type: WorkletEvt.WasmReady});
        } catch (err) {
            this.port.postMessage({type: WorkletEvt.WasmError, error: String(err)});
        }
    }

    /**
     * Handle infrequent control messages from the main thread.
     *
     * Only sample loading and graceful release still use postMessage.
     * Gain, hush, panic, and bank names now go through CHANNEL atomics.
     */
    private _onMessage(msg: WorkletInboundMsg): void {
        if (!this.processor) return;

        switch (msg.type) {
            case Cmd.Release: {
                // Null all views so the SharedArrayBuffer's cross-thread reference
                // count can drop to zero promptly on page teardown.
                this.ready = false;
                this.leftView = null;
                this.rightView = null;
                this.argsView = null;
                this.processor.free();
                this.processor = null;
                this.port.postMessage({type: WorkletEvt.Released});
                break;
            }
        }
    }

    process(
        _inputs: Float32Array[][],
        outputs: Float32Array[][],
        _params: Record<string, Float32Array>,
    ): boolean {
        const ch = outputs[0];
        if (!this.ready || !this.processor || !ch || ch.length < 2) {
            ch?.[0]?.fill(0);
            ch?.[1]?.fill(0);
            return true;
        }

        this.argsView![0] = currentTime;

        try {
            this.processor.renderBlock();
        } catch (err) {
            // A WASM trap (Rust panic, OOB access, etc.) here would otherwise
            // be swallowed by the browser as "An error was thrown from
            // process()" with no detail and would kill the worklet for good.
            // Catch it, forward the real message + stack to the main thread
            // (so the crash-recovery flow can re-init), and silence ourselves
            // — the WASM instance is in undefined state once a trap happens,
            // so we must not call into it again.
            this.ready = false;
            const jsErr = err instanceof Error
                ? `${err.message}\n${err.stack ?? ''}`
                : String(err);
            // Pull the Rust panic message captured by the custom panic hook in
            // strudel-audio-wasm. WKWebView swallows console.error from
            // AudioWorklets so this is the only reliable channel for surfacing
            // the actual panic info on Tauri/Safari.
            let rustPanic: string | undefined;
            try {
                rustPanic = take_last_panic();
            } catch {
                // take_last_panic itself can throw if the WASM is in an
                // unrecoverable state — fall through to whatever JS has.
            }
            const msg = rustPanic
                ? `Rust panic: ${rustPanic}\n--- JS trap: ---\n${jsErr}`
                : jsErr;
            this.port.postMessage({type: WorkletEvt.WasmError, error: msg});
            ch[0].fill(0);
            ch[1].fill(0);
            return true;
        }

        ch[0].set(this.leftView!);
        ch[1].set(this.rightView!);

        return true;
    }
}

registerProcessor('strudel-processor', StrudelProcessor);
