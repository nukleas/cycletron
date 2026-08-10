/**
 * Shared constants for the zero-copy event queue.
 *
 * With shared WASM memory the event data lives directly in WASM linear memory
 * (the `CHANNEL.event_input` static).  There is no intermediate SAB copy.
 *
 * Main thread:
 *   1. `processor.queryEventsPacked(begin, end, cps)`
 *      -> Rust writes N events into CHANNEL.event_input, then does
 *         Atomics.store(event_count, N) [release fence] internally.
 *
 * Worklet:
 *   1. Atomics.swap(event_count, 0) [acquire fence].
 *   2. `processor.drainEventInput(N)` - Rust reads CHANNEL.event_input directly.
 *
 * Controls (gain, hush, panic) are written by the main thread directly into
 * CHANNEL atomics.  No postMessage needed for these.
 */

// the size of one render quantum
export const RENDER_BLOCK = 128;

/**
 * Integer command discriminants.
 *
 * Only sample loading and graceful release still use postMessage.
 * everything else (gain, hush, panic, bank names) goes through the shared channel.
 */
export const enum Cmd {
    LoadSampleMono = 0,
    LoadSampleStereo = 1,
    Release = 2,
}

export const enum WorkletEvt {
    WasmReady = 0,
    WasmError = 1,
    Released = 2,
}

export type WorkletInboundMsg =
    | { type: Cmd.LoadSampleMono; name: string; ch: Float32Array; sampleRate: number }
    | { type: Cmd.LoadSampleStereo; name: string; l: Float32Array; r: Float32Array; sampleRate: number }
    | { type: Cmd.Release };

export type WorkletOutboundMsg =
    | { type: WorkletEvt.WasmReady }
    | { type: WorkletEvt.WasmError; error: string }
    | { type: WorkletEvt.Released };
