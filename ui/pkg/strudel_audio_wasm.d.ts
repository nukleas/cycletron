/* tslint:disable */
/* eslint-disable */

/**
 * Main-thread pattern scheduler and event packer.
 *
 * Queries pattern haps, packs them into `CHANNEL.event_input`, and stores
 * the event count with a Release fence so the worklet can pick them up.
 */
export class MainThreadProcessor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Allocate `count` f32 slots in the sample arena and return the byte address.
     *
     * Call once per batch with the total f32 count across all channels.
     * JS subdivides the returned block for individual channel slices.
     * Returns `0` on OOM.
     */
    static allocAudioSample(count: number): number;
    /**
     * Clears the active pattern (call this after freeing the active pattern).
     */
    clearPattern(): void;
    /**
     * Commit `count` entries from the staging buffer in a single atomic swap.
     *
     * JS fills the staging buffer synchronously (no `await` between writes),
     * then calls `commitBatch(count)`.  This performs one `Vec::clone` + one
     * pointer swap regardless of how many samples are in the batch.
     *
     * # Safety
     *
     * - Every `ptr` in the first `count` entries must come from
     *   `allocAudioSample` with the matching `len`.
     * - All bytes must be fully initialized by the caller.
     */
    commitBatch(count: number): void;
    /**
     * Clear the scheduled event queue without stopping active voices.
     *
     * Active voices ring out naturally through their release envelopes.
     * Use this when changing tempo so stale pre-scheduled events are
     * discarded without cutting off notes that are already sounding.
     */
    flushPending(): void;
    /**
     * Return a pointer to the staging buffer so JS can cache a `Uint32Array`
     * view for the lifetime of the page.
     *
     * Layout: 13 x u32 per entry =
     *   `[leftPtr, leftLen, rightPtr, rightLen, sampleRateBits, bankIdx, sampleIdx, midiNote,
     *     loopStart, loopEnd, keyRangeLow, keyRangeHigh, baseDetuneCentsBits]`.
     * `midiNote` is `0xFFFF_FFFF` for unpitched samples, though anything outside 0-127 also works.
     */
    getStagingPtr(): number;
    /**
     * Stop all voices and clear all pending events (full reset).
     *
     * Use this when changing patterns to ensure clean transitions.
     */
    hush(): void;
    constructor();
    /**
     * Stop all voices immediately (panic).
     *
     * Immediately silences all playing sounds without waiting for release.
     */
    panic(): void;
    /**
     * Query packed events for the given cycle range and write them into
     * `CHANNEL.event_input` (the shared static).
     *
     * This method performs an internal `Ordering::Release` store to
     * `CHANNEL.event_count` after packing is complete. This acts as a memory
     * fence, ensuring all event data is visible to the AudioWorklet's
     * `Acquire` load in `render_block`. No manual JS `Atomics.store` is required.
     *
     * Also runs deferred sample-allocation GC (~10 Hz cadence).
     */
    queryEventsPacked(begin: number, end: number, cps: number): void;
    /**
     * Register a sample bank name using the shared `bank_name_buf`.
     *
     * # Safety
     *
     * - The caller must have written exactly `n` valid UTF-8 bytes into `bank_name_buf.bytes`.
     * - The caller must have stored the byte count `n` in `bank_name_buf.len`.
     * - `n` must not exceed `MAX_NAME_LEN - 1`.
     */
    registerBankNameFromBuffer(): number;
    /**
     * Set master gain (0.0 to 2.0).
     */
    setMasterGain(gain: number): void;
    /**
     * Set the active pattern (hot-swap).
     */
    setPattern(pattern: PatternHandle): void;
    /**
     * Set the start time for pattern scheduling.
     */
    setStartTime(time: number): void;
}

export class PatternHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Resolve a track ID to its `.color()` hint, if the pattern set one.
     *
     * Same caching contract as [`Self::get_track_name`]: JS caches per ID and
     * invalidates when `registry_version` in the cycle-view header changes.
     * Returns `None` for tracks without a color hint - JS falls back to its
     * theme palette.
     */
    getTrackColor(id: number): string | undefined;
    /**
     * Resolve a track ID (from `queryCycleViewData`) to its name string.
     *
     * IDs are stable until a registry purge occurs. JS caches the result and
     * detects purges via `registry_version` in the cycle-view header (`data[2]`).
     * Returns `None` only if the ID was never registered or is out-of-range.
     */
    getTrackName(id: number): string | undefined;
    /**
     * Query haps active at `now` and write their source locations into a
     * static buffer as packed `(start, end, color)` u32 triplets.
     *
     * `color` is the hap's `.color()` hint parsed to `0xRRGGBBAA`, or `0`
     * when the hap has no (hex-parseable) hint - JS falls back to its
     * default highlight style. `#000` parses to `0x0000_00FF`, so black
     * never collides with "no hint".
     *
     * Returns the number of `u32` elements written (divide by 3 for location
     * count).  JS reads the data from `getActiveLocsBufPtr()`.
     */
    queryActiveLocations(now: number, lookahead: number): number;
    /**
     * Generates grouped event data for cycle view visualization.
     *
     * # Data structure
     *
     * A packed array in the format:
     *
     * ```text
     * [track_count, max_data_end, registry_version,
     *   track_id, event_count, begin, end, note, begin, end, note, ...,
     *   track_id, event_count, begin, end, note, begin, end, note, ...,
     *   ...]
     * ```
     *
     * The header is 3 floats:
     * - `track_count`: number of track blocks that follow.
     * - `max_data_end`: the furthest event end time (used to detect pattern period).
     * - `registry_version`: bumped whenever the track registry is purged on overflow.
     *   JS compares this against its cached value each frame and clears its
     *   track name cache when they differ - no extra WASM call needed.
     *
     * Each track block contains:
     * - `track_id`: index into `CHANNEL.tracks`. Resolve via `getTrackName(id)`.
     * - `event_count`: number of events for this track.
     * - `begin, end, note`: event data (stride of 3 floats per event).
     *
     * The `note` field is a MIDI note number (0-127) when the event has an explicit
     * pitch. It is `NaN` when the event has no explicit pitch (e.g. `s("bd")`).
     *
     * Use `Number.isFinite(note)` to distinguish the two cases.
     * @param start_cycle - The cycle to start from
     * @param cycles - Number of cycles to query
     */
    queryCycleViewData(start_cycle: number, cycles: number): void;
    /**
     * Scan haps in [begin, end) and writes the set of sound bank names that
     * are referenced but have no loaded samples yet to.
     */
    queryMissingBanks(begin: number, end: number): void;
    /**
     * Generates a partitioned flat array of rects for piano-roll rendering.
     *
     * # Data Structure
     *
     * A partitioned array: `[inactive_count, ...inactive_rects, ...active_rects]`.
     * Rect stride is 4: `[x, y, w, h]`.
     *
     * Returns the number of f32 elements written to the buffer (use as JS slice length).
     * @param startCycle
     * @param currentCycle
     * @param cycles
     * @param width
     * @param height
     * @returns The length of the buffer filled.
     */
    queryVizRectsView(startCycle: number, currentCycle: number, cycles: number, width: number, height: number): number;
}

/**
 * Audio-thread DSP engine for `AudioWorkletProcessor`.
 *
 * Reads events from `CHANNEL.event_input` (written by the main thread), polls
 * `CHANNEL` atomics for gain/hush/panic, and renders 128-sample blocks into
 * fixed output buffers that JS reads via persistent `Float32Array` views.
 */
export class WorkletProcessor {
    free(): void;
    [Symbol.dispose](): void;
    activeVoices(): number;
    currentTime(): number;
    getArgsPtr(): number;
    getLeftPtr(): number;
    getRightPtr(): number;
    constructor(sampleRate: number, rngSeed: number);
    pendingEvents(): number;
    /**
     * Render one 128-sample block.
     *
     * Reads `args[0]` (currentTime written by JS), polls `CHANNEL` controls,
     * renders into `out_l`/`out_r`, and writes the active voice count to
     * `CHANNEL.voice_count`.
     *
     * Hot path (zero allocation, O(1) sample lookup, GC-safe):
     * 1. Capture generation BEFORE loading the sample pointer.
     * 2. Acquire stable sample snapshot (one Acquire load).
     * 3. Drain events (pre-resolved `sample_id`/`sample_ratio`).
     * 4. `engine.render_block(samples, stereo)`.
     * 5. `processed_gen` Relaxed store signals main thread it's safe to GC.
     */
    renderBlock(): void;
    sampleRate(): number;
    setCurrentTime(time: number): void;
}

/**
 * Returns a pointer to the fixed active-locations buffer.
 *
 * JS builds a `Uint32Array` view here. Contains packed `(start, end, color)`
 * triplets: source-code byte offsets for currently-active pattern elements
 * plus their `.color()` hint as `0xRRGGBBAA` (`0` = no hint).
 */
export function getActiveLocsBufPtr(): number;

export function getAudioAllocLogPtr(): number;

/**
 * Pointer to 10 packed u32 fields - see `COUNTERS_FIELDS` doc comment for layout.
 */
export function getAudioCountersPtr(): number;

/**
 * Byte pointer to `CHANNEL.bank_name_buf`.
 */
export function getBankNameBufPtr(): number;

/**
 * Returns a pointer to the current bpm.
 *
 * Use this after calling `parsePattern` to read the latest value.
 * `NaN` indicates no value.
 */
export function getCurrentBpmPtr(): number;

/**
 * Returns a pointer to the first element of the fixed cycle-view buffer.
 *
 * The address is stable for the lifetime of the page - JS may build a
 * persistent `Float32Array` view here once and reuse it every frame.
 */
export function getCycleViewBufPtr(): number;

export function getMainAllocLogPtr(): number;

/**
 * Pointer to 10 packed u32 fields - see `COUNTERS_FIELDS` doc comment for layout.
 */
export function getMainCountersPtr(): number;

/**
 * Returns a pointer to the current set of missing gm bits.
 *
 * Use this after calling `queryMissingBanks` to read the latest value.
 */
export function getMissingGMBitsPtr(): number;

/**
 * Returns a pointer to the 128-element per-instrument sample-index bitset.
 */
export function getMissingGMSampleBitsPtr(): number;

/**
 * Returns a pointer for manifest bank names referenced but not yet loaded..
 *
 * Layout: `[count: u32 LE][entry0: 32 bytes][entry1: 32 bytes]`.
 */
export function getMissingManifestBanksBufPtr(): number;

/**
 * Returns a pointer to the first element of the fixed piano-rects buffer.
 *
 * The address is stable for the lifetime of the page - JS may build a
 * persistent `Float32Array` view here once and reuse it every frame.
 */
export function getPianoRectsBufPtr(): number;

export function getSampleAllocLogPtr(): number;

export function getSampleArenaNextPtr(): number;

/**
 * Byte offset of `CHANNEL.voice_count`.
 * Written by WorkletProcessor::render_block (Relaxed).
 * Read by main JS with a plain typed-array load.
 */
export function getVoiceCountPtr(): number;

export function init(): void;

/**
 * Attempts to parse a pattern.
 *
 * Read the typed array surrounding `getCurrentBpmPtr` to know what the bpm is.
 */
export function parsePattern(code: string): PatternHandle;

/**
 * Refresh main-thread heap counters. Call this from the main thread.
 */
export function refreshMainCounters(): void;

/**
 * Returns the most recent panic message captured on this thread and clears
 * the slot. Returns `None` if no panic has fired since the last call.
 */
export function take_last_panic(): string | undefined;

/**
 * Get version information.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_mainthreadprocessor_free: (a: number, b: number) => void;
    readonly __wbg_patternhandle_free: (a: number, b: number) => void;
    readonly __wbg_workletprocessor_free: (a: number, b: number) => void;
    readonly getActiveLocsBufPtr: () => number;
    readonly getAudioAllocLogPtr: () => number;
    readonly getAudioCountersPtr: () => number;
    readonly getBankNameBufPtr: () => number;
    readonly getCurrentBpmPtr: () => number;
    readonly getCycleViewBufPtr: () => number;
    readonly getMainAllocLogPtr: () => number;
    readonly getMainCountersPtr: () => number;
    readonly getMissingGMBitsPtr: () => number;
    readonly getMissingGMSampleBitsPtr: () => number;
    readonly getMissingManifestBanksBufPtr: () => number;
    readonly getPianoRectsBufPtr: () => number;
    readonly getSampleAllocLogPtr: () => number;
    readonly getSampleArenaNextPtr: () => number;
    readonly getVoiceCountPtr: () => number;
    readonly init: () => void;
    readonly mainthreadprocessor_allocAudioSample: (a: number) => number;
    readonly mainthreadprocessor_clearPattern: (a: number) => void;
    readonly mainthreadprocessor_commitBatch: (a: number, b: number) => void;
    readonly mainthreadprocessor_flushPending: (a: number) => void;
    readonly mainthreadprocessor_getStagingPtr: (a: number) => number;
    readonly mainthreadprocessor_hush: (a: number) => void;
    readonly mainthreadprocessor_new: () => number;
    readonly mainthreadprocessor_panic: (a: number) => void;
    readonly mainthreadprocessor_queryEventsPacked: (a: number, b: number, c: number, d: number) => void;
    readonly mainthreadprocessor_registerBankNameFromBuffer: (a: number) => number;
    readonly mainthreadprocessor_setMasterGain: (a: number, b: number) => void;
    readonly mainthreadprocessor_setPattern: (a: number, b: number) => void;
    readonly mainthreadprocessor_setStartTime: (a: number, b: number) => void;
    readonly parsePattern: (a: number, b: number, c: number) => void;
    readonly patternhandle_getTrackColor: (a: number, b: number, c: number) => void;
    readonly patternhandle_getTrackName: (a: number, b: number, c: number) => void;
    readonly patternhandle_queryActiveLocations: (a: number, b: number, c: number) => number;
    readonly patternhandle_queryCycleViewData: (a: number, b: number, c: number) => void;
    readonly patternhandle_queryMissingBanks: (a: number, b: number, c: number) => void;
    readonly patternhandle_queryVizRectsView: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly refreshMainCounters: () => void;
    readonly take_last_panic: (a: number) => void;
    readonly version: (a: number) => void;
    readonly workletprocessor_activeVoices: (a: number) => number;
    readonly workletprocessor_currentTime: (a: number) => number;
    readonly workletprocessor_getArgsPtr: (a: number) => number;
    readonly workletprocessor_getLeftPtr: (a: number) => number;
    readonly workletprocessor_getRightPtr: (a: number) => number;
    readonly workletprocessor_new: (a: number, b: number) => number;
    readonly workletprocessor_pendingEvents: (a: number) => number;
    readonly workletprocessor_renderBlock: (a: number) => void;
    readonly workletprocessor_sampleRate: (a: number) => number;
    readonly workletprocessor_setCurrentTime: (a: number, b: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
