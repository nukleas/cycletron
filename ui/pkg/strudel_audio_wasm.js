/* @ts-self-types="./strudel_audio_wasm.d.ts" */

/**
 * Main-thread pattern scheduler and event packer.
 *
 * Queries pattern haps, packs them into `CHANNEL.event_input`, and stores
 * the event count with a Release fence so the worklet can pick them up.
 */
export class MainThreadProcessor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MainThreadProcessorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_mainthreadprocessor_free(ptr, 0);
    }
    /**
     * Allocate `count` f32 slots in the sample arena and return the byte address.
     *
     * Call once per batch with the total f32 count across all channels.
     * JS subdivides the returned block for individual channel slices.
     * Returns `0` on OOM.
     * @param {number} count
     * @returns {number}
     */
    static allocAudioSample(count) {
        const ret = wasm.mainthreadprocessor_allocAudioSample(count);
        return ret >>> 0;
    }
    /**
     * Clears the active pattern (call this after freeing the active pattern).
     */
    clearPattern() {
        wasm.mainthreadprocessor_clearPattern(this.__wbg_ptr);
    }
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
     * @param {number} count
     */
    commitBatch(count) {
        wasm.mainthreadprocessor_commitBatch(this.__wbg_ptr, count);
    }
    /**
     * Clear the scheduled event queue without stopping active voices.
     *
     * Active voices ring out naturally through their release envelopes.
     * Use this when changing tempo so stale pre-scheduled events are
     * discarded without cutting off notes that are already sounding.
     */
    flushPending() {
        wasm.mainthreadprocessor_flushPending(this.__wbg_ptr);
    }
    /**
     * Return a pointer to the staging buffer so JS can cache a `Uint32Array`
     * view for the lifetime of the page.
     *
     * Layout: 13 x u32 per entry =
     *   `[leftPtr, leftLen, rightPtr, rightLen, sampleRateBits, bankIdx, sampleIdx, midiNote,
     *     loopStart, loopEnd, keyRangeLow, keyRangeHigh, baseDetuneCentsBits]`.
     * `midiNote` is `0xFFFF_FFFF` for unpitched samples, though anything outside 0-127 also works.
     * @returns {number}
     */
    getStagingPtr() {
        const ret = wasm.mainthreadprocessor_getStagingPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Stop all voices and clear all pending events (full reset).
     *
     * Use this when changing patterns to ensure clean transitions.
     */
    hush() {
        wasm.mainthreadprocessor_hush(this.__wbg_ptr);
    }
    constructor() {
        const ret = wasm.mainthreadprocessor_new();
        this.__wbg_ptr = ret >>> 0;
        MainThreadProcessorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Stop all voices immediately (panic).
     *
     * Immediately silences all playing sounds without waiting for release.
     */
    panic() {
        wasm.mainthreadprocessor_panic(this.__wbg_ptr);
    }
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
     * @param {number} begin
     * @param {number} end
     * @param {number} cps
     */
    queryEventsPacked(begin, end, cps) {
        wasm.mainthreadprocessor_queryEventsPacked(this.__wbg_ptr, begin, end, cps);
    }
    /**
     * Register a sample bank name using the shared `bank_name_buf`.
     *
     * # Safety
     *
     * - The caller must have written exactly `n` valid UTF-8 bytes into `bank_name_buf.bytes`.
     * - The caller must have stored the byte count `n` in `bank_name_buf.len`.
     * - `n` must not exceed `MAX_NAME_LEN - 1`.
     * @returns {number}
     */
    registerBankNameFromBuffer() {
        const ret = wasm.mainthreadprocessor_registerBankNameFromBuffer(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Set master gain (0.0 to 2.0).
     * @param {number} gain
     */
    setMasterGain(gain) {
        wasm.mainthreadprocessor_setMasterGain(this.__wbg_ptr, gain);
    }
    /**
     * Set the active pattern (hot-swap).
     * @param {PatternHandle} pattern
     */
    setPattern(pattern) {
        _assertClass(pattern, PatternHandle);
        wasm.mainthreadprocessor_setPattern(this.__wbg_ptr, pattern.__wbg_ptr);
    }
    /**
     * Set the start time for pattern scheduling.
     * @param {number} time
     */
    setStartTime(time) {
        wasm.mainthreadprocessor_setStartTime(this.__wbg_ptr, time);
    }
}
if (Symbol.dispose) MainThreadProcessor.prototype[Symbol.dispose] = MainThreadProcessor.prototype.free;

export class PatternHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PatternHandle.prototype);
        obj.__wbg_ptr = ptr;
        PatternHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PatternHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_patternhandle_free(ptr, 0);
    }
    /**
     * Resolve a track ID to its `.color()` hint, if the pattern set one.
     *
     * Same caching contract as [`Self::get_track_name`]: JS caches per ID and
     * invalidates when `registry_version` in the cycle-view header changes.
     * Returns `None` for tracks without a color hint - JS falls back to its
     * theme palette.
     * @param {number} id
     * @returns {string | undefined}
     */
    getTrackColor(id) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.patternhandle_getTrackColor(retptr, this.__wbg_ptr, id);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Resolve a track ID (from `queryCycleViewData`) to its name string.
     *
     * IDs are stable until a registry purge occurs. JS caches the result and
     * detects purges via `registry_version` in the cycle-view header (`data[2]`).
     * Returns `None` only if the ID was never registered or is out-of-range.
     * @param {number} id
     * @returns {string | undefined}
     */
    getTrackName(id) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.patternhandle_getTrackName(retptr, this.__wbg_ptr, id);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
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
     * @param {number} now
     * @param {number} lookahead
     * @returns {number}
     */
    queryActiveLocations(now, lookahead) {
        const ret = wasm.patternhandle_queryActiveLocations(this.__wbg_ptr, now, lookahead);
        return ret >>> 0;
    }
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
     * @param {number} start_cycle - The cycle to start from
     * @param {number} cycles - Number of cycles to query
     */
    queryCycleViewData(start_cycle, cycles) {
        wasm.patternhandle_queryCycleViewData(this.__wbg_ptr, start_cycle, cycles);
    }
    /**
     * Scan haps in [begin, end) and writes the set of sound bank names that
     * are referenced but have no loaded samples yet to.
     * @param {number} begin
     * @param {number} end
     */
    queryMissingBanks(begin, end) {
        wasm.patternhandle_queryMissingBanks(this.__wbg_ptr, begin, end);
    }
    /**
     * Generates a partitioned flat array of rects for piano-roll rendering.
     *
     * # Data Structure
     *
     * A partitioned array: `[inactive_count, ...inactive_rects, ...active_rects]`.
     * Rect stride is 4: `[x, y, w, h]`.
     *
     * Returns the number of f32 elements written to the buffer (use as JS slice length).
     * @param {number} startCycle
     * @param {number} currentCycle
     * @param {number} cycles
     * @param {number} width
     * @param {number} height
     * @returns {number} The length of the buffer filled.
     */
    queryVizRectsView(startCycle, currentCycle, cycles, width, height) {
        const ret = wasm.patternhandle_queryVizRectsView(this.__wbg_ptr, startCycle, currentCycle, cycles, width, height);
        return ret >>> 0;
    }
}
if (Symbol.dispose) PatternHandle.prototype[Symbol.dispose] = PatternHandle.prototype.free;

/**
 * Audio-thread DSP engine for `AudioWorkletProcessor`.
 *
 * Reads events from `CHANNEL.event_input` (written by the main thread), polls
 * `CHANNEL` atomics for gain/hush/panic, and renders 128-sample blocks into
 * fixed output buffers that JS reads via persistent `Float32Array` views.
 */
export class WorkletProcessor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WorkletProcessorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_workletprocessor_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    activeVoices() {
        const ret = wasm.workletprocessor_activeVoices(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    currentTime() {
        const ret = wasm.workletprocessor_currentTime(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    getArgsPtr() {
        const ret = wasm.workletprocessor_getArgsPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    getLeftPtr() {
        const ret = wasm.workletprocessor_getLeftPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    getRightPtr() {
        const ret = wasm.workletprocessor_getRightPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} sampleRate
     * @param {number} rngSeed
     */
    constructor(sampleRate, rngSeed) {
        const ret = wasm.workletprocessor_new(sampleRate, rngSeed);
        this.__wbg_ptr = ret >>> 0;
        WorkletProcessorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    pendingEvents() {
        const ret = wasm.workletprocessor_pendingEvents(this.__wbg_ptr);
        return ret >>> 0;
    }
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
    renderBlock() {
        wasm.workletprocessor_renderBlock(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    sampleRate() {
        const ret = wasm.workletprocessor_sampleRate(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} time
     */
    setCurrentTime(time) {
        wasm.workletprocessor_setCurrentTime(this.__wbg_ptr, time);
    }
}
if (Symbol.dispose) WorkletProcessor.prototype[Symbol.dispose] = WorkletProcessor.prototype.free;

/**
 * Returns a pointer to the fixed active-locations buffer.
 *
 * JS builds a `Uint32Array` view here. Contains packed `(start, end, color)`
 * triplets: source-code byte offsets for currently-active pattern elements
 * plus their `.color()` hint as `0xRRGGBBAA` (`0` = no hint).
 * @returns {number}
 */
export function getActiveLocsBufPtr() {
    const ret = wasm.getActiveLocsBufPtr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function getAudioAllocLogPtr() {
    const ret = wasm.getAudioAllocLogPtr();
    return ret >>> 0;
}

/**
 * Pointer to 10 packed u32 fields - see `COUNTERS_FIELDS` doc comment for layout.
 * @returns {number}
 */
export function getAudioCountersPtr() {
    const ret = wasm.getAudioCountersPtr();
    return ret >>> 0;
}

/**
 * Byte pointer to `CHANNEL.bank_name_buf`.
 * @returns {number}
 */
export function getBankNameBufPtr() {
    const ret = wasm.getBankNameBufPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer to the current bpm.
 *
 * Use this after calling `parsePattern` to read the latest value.
 * `NaN` indicates no value.
 * @returns {number}
 */
export function getCurrentBpmPtr() {
    const ret = wasm.getCurrentBpmPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer to the first element of the fixed cycle-view buffer.
 *
 * The address is stable for the lifetime of the page - JS may build a
 * persistent `Float32Array` view here once and reuse it every frame.
 * @returns {number}
 */
export function getCycleViewBufPtr() {
    const ret = wasm.getCycleViewBufPtr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function getMainAllocLogPtr() {
    const ret = wasm.getMainAllocLogPtr();
    return ret >>> 0;
}

/**
 * Pointer to 10 packed u32 fields - see `COUNTERS_FIELDS` doc comment for layout.
 * @returns {number}
 */
export function getMainCountersPtr() {
    const ret = wasm.getMainCountersPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer to the current set of missing gm bits.
 *
 * Use this after calling `queryMissingBanks` to read the latest value.
 * @returns {number}
 */
export function getMissingGMBitsPtr() {
    const ret = wasm.getMissingGMBitsPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer to the 128-element per-instrument sample-index bitset.
 * @returns {number}
 */
export function getMissingGMSampleBitsPtr() {
    const ret = wasm.getMissingGMSampleBitsPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer for manifest bank names referenced but not yet loaded..
 *
 * Layout: `[count: u32 LE][entry0: 32 bytes][entry1: 32 bytes]`.
 * @returns {number}
 */
export function getMissingManifestBanksBufPtr() {
    const ret = wasm.getMissingManifestBanksBufPtr();
    return ret >>> 0;
}

/**
 * Returns a pointer to the first element of the fixed piano-rects buffer.
 *
 * The address is stable for the lifetime of the page - JS may build a
 * persistent `Float32Array` view here once and reuse it every frame.
 * @returns {number}
 */
export function getPianoRectsBufPtr() {
    const ret = wasm.getPianoRectsBufPtr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function getSampleAllocLogPtr() {
    const ret = wasm.getSampleAllocLogPtr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function getSampleArenaNextPtr() {
    const ret = wasm.getSampleArenaNextPtr();
    return ret >>> 0;
}

/**
 * Byte offset of `CHANNEL.voice_count`.
 * Written by WorkletProcessor::render_block (Relaxed).
 * Read by main JS with a plain typed-array load.
 * @returns {number}
 */
export function getVoiceCountPtr() {
    const ret = wasm.getVoiceCountPtr();
    return ret >>> 0;
}

/**
 * Global WebAssembly module entry point automatically invoked on load.
 *
 * Sets up the panic hook interface and registers an internal error-capture mechanism.
 * This fallback captures panic messages into thread-local storage, allowing the
 * hosting JavaScript environment (such as an AudioWorklet thread) to safely extract
 * error details following a WebAssembly trap.
 */
export function init() {
    wasm.init();
}

/**
 * Attempts to parse a pattern.
 *
 * Read the typed array surrounding `getCurrentBpmPtr` to know what the bpm is.
 * @param {string} code
 * @returns {PatternHandle}
 */
export function parsePattern(code) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
        const len0 = WASM_VECTOR_LEN;
        wasm.parsePattern(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return PatternHandle.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Refresh main-thread heap counters. Call this from the main thread.
 */
export function refreshMainCounters() {
    wasm.refreshMainCounters();
}

/**
 * Returns the most recent panic message captured on this thread and clears
 * the slot. Returns `None` if no panic has fired since the last call.
 * @returns {string | undefined}
 */
export function take_last_panic() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.take_last_panic(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v1;
        if (r0 !== 0) {
            v1 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export(r0, r1 * 1, 1);
        }
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Get version information.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports(memory) {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_export(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return addHeapObject(ret);
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = getObject(arg1).stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export2, wasm.__wbindgen_export3);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
        memory: memory || new WebAssembly.Memory({initial:65,maximum:16384,shared:true}),
    };
    return {
        __proto__: null,
        "./strudel_audio_wasm_bg.js": import0,
    };
}

const MainThreadProcessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_mainthreadprocessor_free(ptr >>> 0, 1));
const PatternHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_patternhandle_free(ptr >>> 0, 1));
const WorkletProcessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_workletprocessor_free(ptr >>> 0, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : undefined);
if (cachedTextDecoder) cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len));
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined);

if (cachedTextEncoder) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module, thread_stack_size) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    if (typeof thread_stack_size !== 'undefined' && (typeof thread_stack_size !== 'number' || thread_stack_size === 0 || thread_stack_size % 65536 !== 0)) {
        throw new Error('invalid stack size');
    }

    wasm.__wbindgen_start(thread_stack_size);
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module, memory, thread_stack_size} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports(memory);
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module, thread_stack_size);
}

async function __wbg_init(module_or_path, memory) {
    if (wasm !== undefined) return wasm;

    let thread_stack_size
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path, memory, thread_stack_size} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('strudel_audio_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports(memory);

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module, thread_stack_size);
}

export { initSync, __wbg_init as default };
