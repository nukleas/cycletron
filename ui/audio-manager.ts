import workletUrl from './worklet.ts?worker&url';
import wasmUrl from './pkg/strudel_audio_wasm_bg.wasm?url';
import {
    getAudioAllocLogPtr,
    getBankNameBufPtr,
    getMainAllocLogPtr,
    getVoiceCountPtr,
    MainThreadProcessor
} from './pkg';
import {Cmd, WorkletEvt} from './src/types/event-queue.js';

declare var AudioWorkletNode: TypedAudioWorkletNodeCtor;
type MainThreadProcessorCtor = new () => MainThreadProcessor;
type WasmInitFn = typeof import('./pkg').default;

// must match Rust constants/structs
const ALLOC_LOG_CAPACITY = 64;

const MAX_NAME_LEN = 32;
const MAX_STAGING_BATCH = 32;
const STAGING_STRIDE = 13;

export interface DecodedSample {
    name: string;
    audioBuffer: AudioBuffer;
    midiNote: number;
    sampleIdx: number;
    loopStart: number;
    loopEnd: number;
    /** 0 - 127, or 255 = no key range (nearest-neighbour fallback). */
    keyRangeLow: number;
    /** 0 - 127, or 255 = no key range (nearest-neighbour fallback). */
    keyRangeHigh: number;
    /** Exact recording pitch in cents. NaN = integer-semitone fallback. */
    baseDetuneCents: number;
}

const AUDIO_THREAD_LOG_PREFIX = `[WasmMemory:AudioThread] heap grew `;
const MAIN_THREAD_LOG_PREFIX = `[WasmMemory:MainThread] heap grew `;

/**
 * Manually encodes a JS string into UTF-8 bytes directly in SharedArrayBuffer.
 * Bypasses TextEncoder restrictions on shared memory.
 *
 * @returns The number of bytes written.
 */
function writeStringToShared(str: string, view: Uint8Array, offset: number, maxBytes: number): number {
    const start = offset;
    const end = offset + maxBytes;
    let p = offset;

    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);

        if (c < 0x80) {
            if (p >= end) break;
            view[p++] = c;
        } else if (c < 0x800) {
            if (p + 1 >= end) break;
            view[p++] = 0xc0 | (c >> 6);
            view[p++] = 0x80 | (c & 0x3f);
        } else if (c < 0xd800 || c >= 0xe000) {
            if (p + 2 >= end) break;
            view[p++] = 0xe0 | (c >> 12);
            view[p++] = 0x80 | ((c >> 6) & 0x3f);
            view[p++] = 0x80 | (c & 0x3f);
        } else {
            // Surrogate pair handling (e.g. Emojis)
            if (i + 1 >= str.length) break;
            c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
            if (p + 3 >= end) break;
            view[p++] = 0xf0 | (c >> 18);
            view[p++] = 0x80 | ((c >> 12) & 0x3f);
            view[p++] = 0x80 | ((c >> 6) & 0x3f);
            view[p++] = 0x80 | (c & 0x3f);
        }
    }
    return p - start;
}

/**
 * Strudel Audio Manager - Shared-Memory Architecture
 *
 * Both the main thread and AudioWorklet use a single `WebAssembly.Memory`
 * (a `SharedArrayBuffer`).  The linear address space is partitioned:
 *
 *   [0 .. ~2MB]   shadow stack + static data + CHANNEL static
 *   [4MB .. 12MB] audio heap  (WorkletProcessor, DspEngine, samples)
 *   [12MB .. 48MB] main heap  (MainThreadProcessor, pattern data, viz buffers)
 *
 * Cross-thread event pipeline (zero-copy):
 *   Main:   queryEventsPacked(begin, end, cps)
 *             -> Rust writes N events into CHANNEL.event_input, does
 *                Atomics.store(event_count, N) [release fence] internally.
 *   Worklet: Atomics.swap(event_count, 0) [acquire fence],
 *            drainEventInput(N) reads CHANNEL.event_input directly, no copy.
 *
 * Controls (gain, hush, panic) are written directly into CHANNEL atomics -
 * no postMessage, latency <= one render quantum (~2.9ms).
 *
 * SharedArrayBuffer-backed TypedArray views NEVER invalidate on memory.grow(),
 * so no view-rebuilding logic is needed anywhere.
 */
export class StrudelAudioManager {
    /**
     * Invoked when the AudioWorkletProcessor::process() method throws. Once
     * that happens the worklet stops calling process() forever — the only
     * recovery path is a full dispose() + init() cycle on a fresh context.
     * The app uses this to flag the manager as dead and re-init on next play.
     */
    onCrash?: (err: Event | string) => void;

    private audioContext: AudioContext | null = null;
    private workletNode: TypedAudioWorkletNode<'strudel-processor'> | null = null;
    private analyserNode: AnalyserNode | null = null;
    private gainNode: GainNode | null = null;
    private processor: MainThreadProcessor | null = null;

    // --- Analyser stall watchdog -------------------------------------------
    // An output-device change (OBS / BlackHole capture, Bluetooth connect,
    // unplugging headphones, …) resets WebKit's audio render thread. The
    // AudioContext keeps reporting state "running" and sound keeps playing,
    // but the AnalyserNode stops being pulled and getByteTimeDomainData()
    // returns all-zeros — which freezes every analyser-fed visualizer while
    // the WASM-data grid keeps working. This watchdog detects that exact
    // signature and re-pulls the node without disturbing playback.
    private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private _watchdogBuf: Uint8Array | null = null;
    private _deadTicks = 0;
    private _recoverCount = 0;
    private _gaveUp = false;
    /** Poll period. Cheap: one fill + an early-exit scan per tick. */
    private static readonly WATCHDOG_INTERVAL_MS = 500;
    /** Consecutive dead polls before acting (~1s) — avoids reacting to the
     *  momentary all-zero window right as playback starts. */
    private static readonly DEAD_TICKS_TO_RECOVER = 2;
    /** Stop *attempting* recovery after this many consecutive failures so a
     *  genuinely unrecoverable graph can't turn into a reconnect storm. The
     *  timer keeps watching and self-heals if audio ever returns. */
    private static readonly MAX_RECOVERIES = 8;

    /** The one shared WebAssembly.Memory used by both threads. */
    private sharedMem: WebAssembly.Memory | null = null;

    private u8: Uint8Array | null = null;
    private u32: Uint32Array | null = null;
    private f32: Float32Array | null = null;

    private audioWriteIdx: number = 0;
    private audioReadIdx: number = 0;
    private audioEntryIdx: number = 0;
    private mainWriteIdx: number = 0;
    private mainReadIdx: number = 0;
    private mainEntryIdx: number = 0;
    private voiceCountIdx: number = 0;
    private bankLenIdx: number = 0;
    private stagingBaseIdx: number = 0;

    static hasSharedArrayBufferSupport(): { ok: boolean; details: Record<string, unknown> } {
        const hasSab = typeof SharedArrayBuffer !== 'undefined';
        const hasAtomics = typeof Atomics !== 'undefined';
        const hasGlobal = hasSab && hasAtomics;
        const crossOriginIsolated = (globalThis as any).crossOriginIsolated === true;
        let constructionError: string | null = null;

        const details: Record<string, unknown> = {
            crossOriginIsolated,
            hasSharedArrayBufferGlobal: hasSab,
            hasAtomicsGlobal: hasAtomics,
            userAgent: navigator.userAgent,
            protocol: location.protocol,
            origin: location.origin,
        };

        console.log('[SAB Diagnostic]', details);

        try {
            if (!hasGlobal) {
                constructionError = !hasSab
                    ? 'SharedArrayBuffer global is missing'
                    : 'Atomics global is missing';
                details.constructionError = constructionError;
                return { ok: false, details };
            }
            new SharedArrayBuffer(1);
            console.log('[SAB Diagnostic] Successfully constructed SharedArrayBuffer(1).');
            return { ok: true, details };
        } catch (err: any) {
            constructionError = String(err?.message || err);
            details.constructionError = constructionError;
            console.error('[SAB Diagnostic] Failed to construct SharedArrayBuffer:', err);
            return { ok: false, details };
        }
    }

    private static showSharedArrayBufferError(details: Record<string, unknown>) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: #1a0000; color: #ffaaaa; font-family: monospace; z-index: 999999;
            padding: 40px; overflow: auto; box-sizing: border-box;
        `;
        overlay.innerHTML = `
            <h1 style="color:#ff5555; margin-top:0;">SHAREDARRAYBUFFER UNAVAILABLE</h1>
            <p style="font-size:18px; color:#ffcccc;">
                The app cannot start audio because the browser context is not cross-origin isolated.<br>
                This is required for high-performance WASM audio (Strudel + AudioWorklet + SharedArrayBuffer).
            </p>
            <h3 style="color:#ffaaaa;">Diagnostic Information (copy this)</h3>
            <pre style="background:#300; padding:16px; border-radius:4px; color:#ffdddd; white-space:pre-wrap; font-size:13px;">${JSON.stringify(details, null, 2)}</pre>

            <h3 style="color:#ffaaaa; margin-top:32px;">What this usually means in Tauri</h3>
            <ul style="line-height:1.6;">
                <li><b>Linux (WebKitGTK):</b> COOP/COEP alone never enables SharedArrayBuffer — JavaScriptCore gates it behind <code>JSC_useSharedArrayBuffer=1</code>. The app sets this automatically at startup; if you still see this screen, launch as <code>JSC_useSharedArrayBuffer=1 cycletron-app</code> and please file a bug. Header debugging is a dead end here: <code>crossOriginIsolated</code> can be true while the constructor is missing.</li>
                <li>The COOP/COEP headers from <code>tauri.conf.json → app.security.headers</code> are not being applied to the main document in the production bundle.</li>
                <li>In <code>cargo tauri dev</code> it works because Vite injects the headers.</li>
                <li>In the built .app the asset protocol responses may not be getting the headers, or WKWebView is not entering a cross-origin isolated state.</li>
            </ul>

            <p style="margin-top:32px; color:#ff8888;">
                Open DevTools (⌘⌥I) and check the console for more [SAB Diagnostic] logs.
            </p>
        `;
        document.body.appendChild(overlay);
    }

    /**
     * Initialize audio.
     *
     * Compiles the WASM module, creates a single shared `WebAssembly.Memory`,
     * instantiates a main-thread WASM instance, and passes the same memory
     * to the AudioWorklet so both threads share the same linear address space.
     */
    async init(
        wasmInit: WasmInitFn,
        MainThreadProcessorCtor: MainThreadProcessorCtor,
    ): Promise<number> {
        const sabCheck = StrudelAudioManager.hasSharedArrayBufferSupport();
        if (!sabCheck.ok) {
            StrudelAudioManager.showSharedArrayBufferError(sabCheck.details);
            throw new Error('SharedArrayBuffer unavailable. See on-screen diagnostic for details.');
        }

        const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl));

        // Single shared memory - both threads use this same object.
        // Initial 64 pages (4MB) covers shadow stack + statics + CHANNEL.
        // Each heap region grows lazily via BoundedGrowHandler in Rust.
        const sharedMemory = new WebAssembly.Memory({
            initial: 65, maximum: 16384, shared: true,
        });
        this.sharedMem = sharedMemory;

        await wasmInit({module_or_path: wasmModule, memory: sharedMemory});

        this.audioContext = new AudioContext();
        this.processor = new MainThreadProcessorCtor();

        // The backing buffer is a SharedArrayBuffer; views NEVER invalidate on
        // memory.grow(), so we build them once and never rebuild.
        const buf = sharedMemory.buffer;

        this.bankLenIdx = getBankNameBufPtr();

        this.u8 = new Uint8Array(buf);
        this.u32 = new Uint32Array(buf);
        this.f32 = new Float32Array(buf);

        this.voiceCountIdx = getVoiceCountPtr() >>> 2;

        const audioBase = getAudioAllocLogPtr() >>> 2;
        this.audioWriteIdx = audioBase;
        this.audioReadIdx = audioBase + 1;
        this.audioEntryIdx = audioBase + 2; // entries start after header

        const mainBase = getMainAllocLogPtr() >>> 2;
        this.mainWriteIdx = mainBase;
        this.mainReadIdx = mainBase + 1;
        this.mainEntryIdx = mainBase + 2;  // entries start after header

        this.stagingBaseIdx = this.processor.getStagingPtr() >>> 2;

        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 1024;
        this.analyserNode.smoothingTimeConstant = 0.8;

        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.setValueAtTime(1, this.audioContext.currentTime);
        this.gainNode.connect(this.analyserNode);
        this.analyserNode.connect(this.audioContext.destination);

        await this.audioContext.audioWorklet.addModule(workletUrl);

        this.workletNode = new AudioWorkletNode(
            this.audioContext, 'strudel-processor',
            {
                outputChannelCount: [2],
                processorOptions: {
                    wasmModule,
                    sampleRate: this.audioContext.sampleRate,
                    // Pass the shared memory - worklet calls initSync with this.
                    sharedMemory,
                    // Per-session seed for the worklet's audio-synthesis RNG.
                    rngSeed: crypto.getRandomValues(new Uint32Array(1))[0],
                },
            },
        );
        this.workletNode.onprocessorerror = (err) => {
            console.error('[Worklet] crashed:', err);
            this.onCrash?.(err);
        };
        this.workletNode.connect(this.gainNode);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('Worklet init timed out')), 10_000,
            );
            this.workletNode!.port.onmessage = (e) => {
                switch (e.data.type) {
                    case WorkletEvt.WasmReady:
                        clearTimeout(timeout);
                        console.log('[AudioManager] Shared-memory audio thread ready');
                        resolve();
                        break;
                    case WorkletEvt.WasmError:
                        clearTimeout(timeout);
                        reject(new Error(`Worklet WASM error: ${e.data.error}`));
                        break;
                }
            };
        });

        // Now that init is done, swap to the runtime message handler. The
        // worklet wraps renderBlock() in try/catch and posts WasmError on a
        // trap — surface that as a crash event so the app can recover instead
        // of the worklet silently dying with the browser's bland processorerror.
        this.workletNode.port.onmessage = (e) => {
            if (e.data?.type === WorkletEvt.WasmError) {
                console.error('[Worklet] DSP trap:', e.data.error);
                this.onCrash?.(e.data.error);
            }
        };

        return this.audioContext.sampleRate;
    }

    private drainLog(
        writeIdx: number,
        readIdx: number,
        entryIdx: number,
        prefix: string,
    ): void {
        const view = this.u32!;
        while (true) {
            const read = Atomics.load(view, readIdx);
            const write = Atomics.load(view, writeIdx);
            if (read === write) break;

            const base = entryIdx + (read % ALLOC_LOG_CAPACITY) * 3;
            const oldEnd = view[base];
            const newEnd = view[base + 1];
            const deltaPages = view[base + 2];

            console.debug(
                `${prefix}${(oldEnd / 1048576).toFixed(2)}MB -> ` +
                `${(newEnd / 1048576).toFixed(2)}MB | wasm pages: +${deltaPages}`
            );

            Atomics.store(view, readIdx, read + 1);
        }
    }

    flushAllocLog(): void {
        if (!this.u32) return;
        this.drainLog(this.audioWriteIdx, this.audioReadIdx, this.audioEntryIdx, AUDIO_THREAD_LOG_PREFIX);
        this.drainLog(this.mainWriteIdx, this.mainReadIdx, this.mainEntryIdx, MAIN_THREAD_LOG_PREFIX);
    }

    discardAllocLog(): void {
        const view = this.u32;
        if (!view) return;
        Atomics.store(view, this.audioReadIdx, Atomics.load(view, this.audioWriteIdx));
        Atomics.store(view, this.mainReadIdx, Atomics.load(view, this.mainWriteIdx));
    }

    /**
     * Signal the worklet to update the master gain on the next render block.
     */
    sendMasterGain(gain: number): void {
        this.processor?.setMasterGain(gain);
    }

    /**
     * Signal the worklet to hush on the next render block.
     */
    sendHush(): void {
        this.processor?.hush();
    }

    /**
     * Signal the worklet to panic on the next render block.
     */
    sendPanic(): void {
        this.processor?.panic();
    }

    /**
     * Signal the worklet to flush pending events on the next render block.
     */
    sendFlushPending(): void {
        this.processor?.flushPending();
    }

    /**
     * Read the active voice count written by the worklet into CHANNEL.voice_count.
     *
     * Plain array access - CHANNEL.voice_count is 32-bit aligned in a SAB,
     * so the read is atomic on all real hardware.  Avoids the SeqCst fence
     * that `Atomics.load` would impose for this UI-only display value.
     */
    getActiveVoices(): number {
        return this.u32 ? this.u32[this.voiceCountIdx] : 0;
    }

    private refreshViews() {
        const buf = this.sharedMem!.buffer;
        this.u8 = new Uint8Array(buf);
        this.u32 = new Uint32Array(buf);
        this.f32 = new Float32Array(buf);
    }

    // Zero JS-WASM boundary crossings per sample.  JS fills the pre-cached
    // staging view synchronously (no `await` between writes) then calls
    // `commitBatch(count)` once.  One atomic swap for the entire batch.
    //
    // `items` must be fully decoded `AudioBuffer`s (no awaits inside this method).
    sendSampleBatch(items: Array<DecodedSample>): void {
        if (!this.processor || !this.u8 || !this.u32 || !this.f32) return;

        const processor = this.processor;
        let u8 = this.u8;
        let u32 = this.u32;
        let f32 = this.f32;

        const base = this.stagingBaseIdx;
        const bankLenIdx = this.bankLenIdx;
        const bankNameBufIdx = bankLenIdx + 1;

        // Process items in MAX_STAGING_BATCH windows so we never drop samples.
        for (let batchStart = 0; batchStart < items.length; batchStart += MAX_STAGING_BATCH) {
            const batchEnd = Math.min(batchStart + MAX_STAGING_BATCH, items.length);

            // Pre-calculate total f32 count for this window so we can make a
            // single arena allocation and a single refreshViews call.
            let totalF32s = 0;
            for (let i = batchStart; i < batchEnd; i++) {
                const ab = items[i].audioBuffer;
                totalF32s += ab.getChannelData(0).length;
                if (ab.numberOfChannels > 1) totalF32s += ab.getChannelData(1).length;
            }

            // Single allocation covers the entire batch window.
            const batchBasePtr = MainThreadProcessor.allocAudioSample(totalF32s);
            if (batchBasePtr === 0) {
                console.error('[AudioManager] Sample arena OOM');
                return;
            }

            // Rebuild views once after the potential memory_grow inside Rust.
            this.refreshViews();
            u8 = this.u8!;
            u32 = this.u32!;
            f32 = this.f32!;

            // f32-index cursor into the arena block.
            let cursor = batchBasePtr >>> 2;

            // Synchronous block - no await inside
            for (let i = batchStart; i < batchEnd; i++) {
                const batchIdx = i - batchStart;
                const {
                    name, audioBuffer, midiNote, sampleIdx, loopStart, loopEnd,
                    keyRangeLow, keyRangeHigh, baseDetuneCents,
                } = items[i];

                u8[bankLenIdx] = writeStringToShared(name, u8, bankNameBufIdx, MAX_NAME_LEN - 1);
                const bankIdx = processor.registerBankNameFromBuffer();

                // Left channel - absolute byte ptr = cursor * 4.
                const leftSlice = audioBuffer.getChannelData(0);
                const leftPtr = cursor * 4;
                f32.set(leftSlice, cursor);
                cursor += leftSlice.length;

                // Right channel (defaults to 0 for mono)
                let rightPtr = 0;
                let rightLen = 0;

                if (audioBuffer.numberOfChannels > 1) {
                    const rightSlice = audioBuffer.getChannelData(1);
                    rightLen = rightSlice.length;
                    rightPtr = cursor * 4;
                    f32.set(rightSlice, cursor);
                    cursor += rightLen;
                }

                const off = base + (batchIdx * STAGING_STRIDE);

                u32[off] = leftPtr;
                u32[off + 1] = leftSlice.length;
                u32[off + 2] = rightPtr;
                u32[off + 3] = rightLen;
                f32[off + 4] = audioBuffer.sampleRate;
                u32[off + 5] = bankIdx;
                u32[off + 6] = sampleIdx;
                u32[off + 7] = midiNote;
                u32[off + 8] = loopStart;
                u32[off + 9] = loopEnd;
                u32[off + 10] = keyRangeLow <= 127 ? keyRangeLow : 255;
                u32[off + 11] = keyRangeHigh <= 127 ? keyRangeHigh : 255;
                f32[off + 12] = baseDetuneCents;

                items[i].audioBuffer = null!;
            }

            this.processor.commitBatch(batchEnd - batchStart);
        }
    }

    getProcessor(): MainThreadProcessor | null {
        return this.processor;
    }

    getOutputNode(): GainNode | null {
        return this.gainNode;
    }

    getAnalyser(): AnalyserNode | null {
        return this.analyserNode;
    }

    getAudioContext(): AudioContext | null {
        return this.audioContext;
    }

    getWasmMemory(): WebAssembly.Memory | null {
        return this.sharedMem;
    }


    /**
     * Begin watching the analyser for the device-reset stall described above.
     * Idempotent and safe to call when audio isn't ready (it just no-ops).
     * The caller should only run this while playback is active so legitimate
     * silence on stop/pause is never mistaken for a stall.
     */
    startAnalyserWatchdog(): void {
        if (this._watchdogTimer !== null || !this.analyserNode) return;
        // One reusable buffer — no per-tick allocation.
        this._watchdogBuf = new Uint8Array(this.analyserNode.fftSize);
        this._deadTicks = 0;
        this._recoverCount = 0;
        this._gaveUp = false;
        this._watchdogTimer = setInterval(
            this._watchdogTick, StrudelAudioManager.WATCHDOG_INTERVAL_MS,
        );
    }

    stopAnalyserWatchdog(): void {
        if (this._watchdogTimer !== null) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
        this._watchdogBuf = null;
        this._deadTicks = 0;
    }

    private _watchdogTick = (): void => {
        const an = this.analyserNode;
        const buf = this._watchdogBuf;
        if (!an || !buf) return;

        an.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);

        // "Dead" == every sample is exactly 0. Genuine silence sits at 128, so
        // quiet or empty musical passages never match; only a stalled (un-pulled)
        // analyser produces literal zeros. The early-exit keeps the healthy path
        // O(1) in practice — it bails on the first non-zero sample.
        let dead = true;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== 0) { dead = false; break; }
        }

        if (!dead) {
            // Healthy tick clears all state, so the recovery budget only
            // depletes on *consecutive* failed recoveries, and protection
            // resumes automatically after any self-heal.
            this._deadTicks = 0;
            this._recoverCount = 0;
            this._gaveUp = false;
            return;
        }

        if (++this._deadTicks < StrudelAudioManager.DEAD_TICKS_TO_RECOVER) return;
        this._deadTicks = 0;

        if (this._recoverCount >= StrudelAudioManager.MAX_RECOVERIES) {
            if (!this._gaveUp) {
                this._gaveUp = true;
                console.warn(
                    `[AudioManager] analyser still stalled after ${this._recoverCount} ` +
                    `recovery attempts; pausing recovery (will retry if audio returns)`,
                );
            }
            return;
        }

        this._recoverCount++;
        this._recoverAnalyser();
    };

    /**
     * Re-pull a stalled analyser. Sound flows gain → analyser → destination,
     * so the node is clearly being pulled (you still hear audio) yet its
     * analysis buffer is stuck — a known WebKit post-device-reset state.
     * Toggling the input edge forces the node to re-initialise. The
     * disconnect + reconnect happen synchronously in one tick, so the next
     * render quantum sees a fully wired graph and there's no audible gap.
     */
    private _recoverAnalyser(): void {
        const ctx = this.audioContext;
        const gain = this.gainNode;
        const an = this.analyserNode;
        if (!ctx || !gain || !an) return;

        console.warn(
            `[AudioManager] analyser stalled (all-zero); re-pulling graph ` +
            `(attempt ${this._recoverCount})`,
        );

        // Some WebKit builds leave the context suspended after a device reset
        // while still reporting "running"; resume() is a cheap no-op otherwise.
        if (ctx.state !== 'running') void ctx.resume();

        try {
            gain.disconnect(an);
        } catch {
            // Edge may already be gone (teardown race) — reconnect re-establishes it.
        }
        gain.connect(an);
    }

    async dispose(): Promise<void> {
        this.stopAnalyserWatchdog();

        if (this.workletNode) {
            await new Promise<void>((resolve) => {
                const t = setTimeout(resolve, 800);
                this.workletNode!.port.onmessage = (e) => {
                    if (e.data.type === WorkletEvt.Released) {
                        clearTimeout(t);
                        resolve();
                    }
                };
                this.workletNode!.port.postMessage({type: Cmd.Release});
            });

            // A concurrent dispose() (e.g. a second crash-recovery click) may
            // have nulled workletNode while we were awaiting Release. Re-check.
            if (this.workletNode) {
                this.workletNode.port.onmessage = null;
                this.workletNode.disconnect();
                this.workletNode = null;
            }
        }

        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        if (this.analyserNode) {
            this.analyserNode.disconnect();
            this.analyserNode = null;
        }

        if (this.processor) {
            this.processor.free();
            this.processor = null;
        }

        // Clear views so the SharedArrayBuffer's reference count can drop.
        this.u8 = null;
        this.u32 = null;
        this.f32 = null;
        this.sharedMem = null;

        if (this.audioContext) {
            await this.audioContext.close();
            this.audioContext = null;
        }
    }
}