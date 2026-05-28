/**
 * Strudel WASM REPL - Main Application
 *
 * Rust/WASM pattern evaluation and audio synthesis
 * with CodeMirror editor and pattern visualization
 */

import type {MainThreadProcessor, PatternHandle} from '../pkg';
import type {StrudelAudioManager} from '../audio-manager.js';
import type {PatternScheduler} from '../scheduler.js';
import type {SampleLoader} from '../sample-loader.js';
import {PlaybackState} from "./types/app.js";
import {StrudelEditor} from './editor.js';
import {PatternVisualizer, ScopeVisualizer, VizMode} from './visualizer.js';
import {ExamplesBrowser} from './examples.js';

interface AppElements {
    // -- Header controls --
    transportBtn: HTMLButtonElement;
    stopBtn: HTMLButtonElement;
    bpmSlider: HTMLInputElement;
    bpmValue: HTMLInputElement;
    gainSlider: HTMLInputElement;
    gainValue: HTMLSpanElement;
    copyBtn: HTMLButtonElement;
    // -- Main panels --
    editor: HTMLDivElement;
    error: HTMLDivElement;
    // -- Sidebar --
    visualizer: HTMLDivElement;
    vizMode: HTMLSelectElement;
    scope: HTMLDivElement;
    cycleCount: HTMLDivElement;
    voiceCount: HTMLDivElement;
    sampleCount: HTMLDivElement;
    bpmDisplay: HTMLDivElement;
    // -- Status bar --
    status: HTMLDivElement;
    liveIndicator: HTMLSpanElement;
}

declare module '../pkg/strudel_audio_wasm.js' {
    function __drop_wasm(): void;
}

type WasmModule = typeof import('../pkg/strudel_audio_wasm.js');

export class StrudelApp {
    editor: StrudelEditor | null;
    visualizer: PatternVisualizer | null;
    scope: ScopeVisualizer | null;
    audioManager: StrudelAudioManager | null;
    scheduler: PatternScheduler | null;
    private sampleLoader: SampleLoader | null;
    processor: MainThreadProcessor | null;

    playbackState: PlaybackState;
    isInitialized: boolean;

    // WASM modules (loaded dynamically)
    private wasm: WasmModule | null;

    private latestCycle: number;
    // Flag to prevent over-rendering
    private vizPending: boolean;

    elements: AppElements;
    private statsInterval: ReturnType<typeof setInterval> | null;

    // True while _initAndPlay is awaiting initAudio - used by _onPageHide to
    // avoid attempting a full async dispose against a half-constructed AudioWorklet,
    // which can deadlock the browser's audio thread during page unload.
    private _initInProgress: boolean;
    /**
     * Set when the AudioWorklet's process() method throws — the worklet is
     * unrecoverable at that point and any further audio output requires a
     * fresh AudioContext + shared memory. The next play press triggers a
     * full dispose+init cycle and resumes the current pattern.
     */
    private _audioCrashed: boolean;
    /** Set while _recoverFromAudioCrash is in flight so a second click on
     * Play (or a menu/tray/hotkey trigger) doesn't kick off a parallel
     * dispose+init and race the first one to nulled state. */
    private _recoveringFromCrash: boolean;
    private _resizeMoveRafId: number | null;
    private _activeLocsBufPtr: number;
    private _wasmMemory: WebAssembly.Memory | null;
    private bpmView: Float64Array | null;
    private _suppressNextCodeChange: boolean;
    /** Cached byte→char offset map for the current code. */
    private _byteToChar: Uint32Array | null;
    private _byteToCharCode: string;

    constructor() {
        this.editor = null;
        this.visualizer = null;
        this.scope = null;
        this.audioManager = null;
        this.scheduler = null;
        this.sampleLoader = null;
        this.processor = null;

        this.playbackState = PlaybackState.Stopped;
        this.isInitialized = false;

        // WASM modules (loaded dynamically)
        this.wasm = null;

        this.latestCycle = 0;
        // Flag to prevent over-rendering
        this.vizPending = false;

        this.elements = null!;
        this.statsInterval = null;
        this._initInProgress = false;
        this._audioCrashed = false;
        this._recoveringFromCrash = false;
        this._resizeMoveRafId = null;
        this._activeLocsBufPtr = 0;
        this._wasmMemory = null;
        this.bpmView = null;
        this._suppressNextCodeChange = false;
        this._byteToChar = null;
        this._byteToCharCode = '';
    }

    renderFrame = (): void => {
        if (this.isInitialized && this.visualizer) {
            this.visualizer.setCycle(this.latestCycle);
        }
        this.updateActiveNotes(this.latestCycle);
        this.vizPending = false;
    };

    updateStats = (): void => {
        if (!this.audioManager || !this.isInitialized || !this.wasm) return;
        this.elements.voiceCount.textContent = String(this.audioManager.getActiveVoices());
    };

    /**
     * Build a byte-offset → char-offset lookup table for the given code.
     * Cached and only rebuilt when the code changes.
     */
    private getByteToCharMap(code: string): Uint32Array {
        if (this._byteToChar && this._byteToCharCode === code) return this._byteToChar;

        const encoder = new TextEncoder();
        const bytes = encoder.encode(code);
        // Map: for each byte index, what is the char index?
        const map = new Uint32Array(bytes.length + 1);
        let charIdx = 0;
        let byteIdx = 0;
        while (charIdx < code.length) {
            map[byteIdx] = charIdx;
            const cp = code.codePointAt(charIdx)!;
            const byteLen = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
            const charLen = cp > 0xffff ? 2 : 1;
            for (let j = 1; j < byteLen; j++) {
                map[byteIdx + j] = charIdx; // mid-codepoint bytes map to same char
            }
            byteIdx += byteLen;
            charIdx += charLen;
        }
        map[byteIdx] = charIdx; // sentinel at end
        this._byteToChar = map;
        this._byteToCharCode = code;
        return map;
    }

    private updateActiveNotes(cycle: number): void {
        if (!this.scheduler?.pattern || !this.editor || !this._wasmMemory) return;

        const count = this.scheduler.pattern.queryActiveLocations(cycle, cycle + 0.5);

        if (count === 0) {
            this.editor.clearActiveNotes();
            return;
        }

        const locsBuf = new Uint32Array(
            this._wasmMemory.buffer,
            this._activeLocsBufPtr,
            count
        );

        const code = this.editor.getCode();
        const b2c = this.getByteToCharMap(code);
        const docLen = this.editor.view.state.doc.length;
        const ranges: { from: number; to: number }[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < count; i += 2) {
            const fromByte = locsBuf[i];
            const toByte = locsBuf[i + 1];
            const from = fromByte < b2c.length ? b2c[fromByte] : fromByte;
            const to = toByte < b2c.length ? b2c[toByte] : toByte;
            if (from < docLen && to <= docLen && from < to) {
                const key = `${from}-${to}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    ranges.push({from, to});
                }
            }
        }

        if (ranges.length > 0) {
            this.editor.setActiveNotes(ranges);
        } else {
            this.editor.clearActiveNotes();
        }
    }

    handleCycleUpdate = (cycle: number): void => {
        // If a frame is already waiting, don't even update the cycle count!
        if (this.vizPending || !this.isInitialized) return;
        this.elements.cycleCount.textContent = cycle.toFixed(2);
        this.latestCycle = cycle;
        this.vizPending = true;
        requestAnimationFrame(this.renderFrame);
    };

    onCodeChange = (code: string): void => {
        if (this._suppressNextCodeChange) {
            this._suppressNextCodeChange = false;
            this.hideError();
            return;
        }

        if ((this.playbackState === PlaybackState.Playing || this.playbackState === PlaybackState.Paused) && this.scheduler) {
            this.debouncedEvaluate(code);
        } else {
            this.hideError();
        }
    };

    init(): void {
        // Set up UI first
        this.setupUI();

        // Create editor
        this.editor = new StrudelEditor(this.elements.editor, {
            onChange: this.onCodeChange,
            onEvaluate: (code) => this.evaluate(code),
            onStop: () => this.stop(),
        });

        // Restore persisted font size now that the editor exists
        const savedSize = parseInt(localStorage.getItem('editor-font-size') || '14', 10);
        this.editor.setFontSize(savedSize);

        window.addEventListener('beforeunload', this._onBeforeUnload);

        // Update status
        this.setStatus('Press Play to begin');
    }

    _onBeforeUnload = (): void => {
        if (this.editor) {
            localStorage.setItem('editor-code', this.editor.getCode());
        }
    };

    setupUI(): void {
        // Returns a touchend handler that fires callback on double-tap
        const doubleTap = (callback: () => void) => {
            let lastTap = 0;
            return () => {
                const now = Date.now();
                if (now - lastTap < 300) callback();
                lastTap = now;
            };
        };

        // Get all control elements
        this.elements = {
            // -- Header controls --
            transportBtn: document.getElementById('transportBtn') as HTMLButtonElement,
            stopBtn: document.getElementById('stopBtn') as HTMLButtonElement,
            bpmSlider: document.getElementById('bpmSlider') as HTMLInputElement,
            bpmValue: document.getElementById('bpmValue') as HTMLInputElement,
            gainSlider: document.getElementById('gainSlider') as HTMLInputElement,
            gainValue: document.getElementById('gainValue') as HTMLSpanElement,
            copyBtn: document.getElementById('copyBtn') as HTMLButtonElement,
            // -- Main panels --
            editor: document.getElementById('editor') as HTMLDivElement,
            error: document.getElementById('error') as HTMLDivElement,
            visualizer: document.getElementById('visualizer') as HTMLDivElement,
            // -- Sidebar --
            vizMode: document.getElementById('vizMode') as HTMLSelectElement,
            scope: document.getElementById('scope') as HTMLDivElement,
            cycleCount: document.getElementById('cycleCount') as HTMLDivElement,
            voiceCount: document.getElementById('voiceCount') as HTMLDivElement,
            sampleCount: document.getElementById('sampleCount') as HTMLDivElement,
            bpmDisplay: document.getElementById('bpmDisplay') as HTMLDivElement,
            // -- Status bar --
            status: document.getElementById('status') as HTMLDivElement,
            liveIndicator: document.getElementById('liveIndicator') as HTMLSpanElement,
        };

        // Event listener handlers
        const handleTransport = async () => this.togglePlayPause();

        const handleStop = () => this.stop();

        const resetBpm = () => this.applyBpm(120);

        const onBpmInput = (e: Event) => {
            this.applyBpm(parseInt((e.target as HTMLInputElement).value, 10));
        };

        const onBpmKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.applyBpm(parseInt(this.elements.bpmValue.value, 10));
                this.elements.bpmValue.blur();
            }
            if (e.key === 'Escape') {
                e.stopPropagation(); // prevent stopping playback
                this.elements.bpmValue.value = this.elements.bpmSlider.value; // revert
                this.elements.bpmValue.blur();
            }
        };

        // Select all text on focus so typing immediately replaces the value.
        const onBpmFocus = (e: FocusEvent) => {
            (e.target as HTMLInputElement).select();
        };

        const onBpmWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            const step = e.shiftKey ? 10 : 1;
            const current = parseInt(this.elements.bpmSlider.value, 10);
            this.applyBpm(current + delta * step);
        };

        const onBpmValueWheel = (e: WheelEvent) => {
            // Only handle when the input is focused to avoid hijacking page scroll.
            if (document.activeElement !== this.elements.bpmValue) return;
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            const step = e.shiftKey ? 10 : 1;
            const current = parseInt(this.elements.bpmValue.value, 10);
            this.applyBpm(current + delta * step);
        };

        const onGainInput = (e: Event) => {
            const pct = parseInt((e.target as HTMLInputElement).value, 10);
            this.elements.gainValue.textContent = `${pct}%`;
            this.audioManager?.sendMasterGain(pct / 100);
        };

        const resetGain = () => {
            this.elements.gainSlider.value = "100";
            this.elements.gainValue.textContent = '100%';
            this.audioManager?.sendMasterGain(1.0);
        };

        const onGainWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            const step = e.shiftKey ? 10 : 1;
            const current = parseInt(this.elements.gainSlider.value, 10);
            const next = Math.max(0, Math.min(200, current + delta * step));
            this.elements.gainSlider.value = String(next);
            this.elements.gainValue.textContent = `${next}%`;
            this.audioManager?.sendMasterGain(next / 100);
        };

        const onVizChange = (e: Event) => {
            const el = e.target as HTMLSelectElement;
            const mode = el.selectedIndex as VizMode;
            if (this.visualizer) {
                this.visualizer.setMode(mode);
            } else {
                localStorage.setItem('visualizer-mode', mode.toString());
            }
        };

        const onCopyCode = async () => {
            const code = this.editor?.getCode() ?? '';
            try {
                await navigator.clipboard.writeText(code);
                this._flashCopyBtn('Copied!');
            } catch {
                // Fallback for browsers without Clipboard API
                this._flashCopyBtn('Failed');
            }
        };

        const onGlobalKeydown = async (e: KeyboardEvent) => {
            // Ctrl+Enter anywhere to play/pause/resume
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                await this.togglePlayPause();
            }
            // Escape anywhere to stop
            if (e.key === 'Escape') {
                this.stop();
            }
        };

        // Examples browser
        const examplesBrowser = new ExamplesBrowser((code: string) => {
            if (this.editor) this.editor.setCode(code);
        });
        document.getElementById('browseExamples')?.addEventListener('click', () => {
            examplesBrowser.toggle();
        });

        // Event listeners
        this.elements.transportBtn.addEventListener('click', handleTransport);
        this.elements.stopBtn.addEventListener('click', handleStop);

        this.elements.bpmSlider.addEventListener('input', onBpmInput);
        this.elements.bpmSlider.addEventListener('dblclick', resetBpm);
        this.elements.bpmSlider.addEventListener('touchend', doubleTap(resetBpm));
        this.elements.bpmSlider.addEventListener('wheel', onBpmWheel, {passive: false});

        this.elements.bpmValue.addEventListener('change', onBpmInput);
        this.elements.bpmValue.addEventListener('blur', onBpmInput);
        this.elements.bpmValue.addEventListener('focus', onBpmFocus);
        this.elements.bpmValue.addEventListener('keydown', onBpmKeydown);
        this.elements.bpmValue.addEventListener('wheel', onBpmValueWheel, {passive: false});

        this.elements.gainSlider.addEventListener('input', onGainInput);
        this.elements.gainSlider.addEventListener('dblclick', resetGain);
        this.elements.gainSlider.addEventListener('touchend', doubleTap(resetGain));
        this.elements.gainSlider.addEventListener('wheel', onGainWheel, {passive: false});

        this.elements.vizMode.addEventListener('change', onVizChange);

        this.elements.copyBtn.addEventListener('click', onCopyCode);

        this._initResizeHandle();
        this._initEditorZoom();

        // Keyboard shortcuts (global)
        document.addEventListener('keydown', onGlobalKeydown);

        // (examples browser is wired above via ExamplesBrowser class)
    }

    private _flashCopyBtn(label: string): void {
        const btn = this.elements.copyBtn;
        const textSpan = btn.querySelector('.btn-text');

        if (!textSpan) return;

        const original = textSpan.textContent;
        textSpan.textContent = label;
        btn.classList.add('copy-btn--flash');

        setTimeout(() => {
            textSpan.textContent = original;
            btn.classList.remove('copy-btn--flash');
        }, 1500);
    }

    _initResizeHandle(): void {
        const handle = document.getElementById('resizeHandle');
        const main = document.querySelector('main');
        if (!handle || !main) return;

        const onMove = (e: MouseEvent | TouchEvent) => {
            const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
            if (this._resizeMoveRafId !== null) return;
            this._resizeMoveRafId = requestAnimationFrame(() => {
                this._resizeMoveRafId = null;
                const mainRect = main.getBoundingClientRect();
                const desiredWidth = mainRect.right - clientX;
                document.documentElement.style.setProperty('--sidebar-width', `${desiredWidth}px`);
            });
        };

        const endDrag = () => {
            if (this._resizeMoveRafId !== null) {
                cancelAnimationFrame(this._resizeMoveRafId);
                this._resizeMoveRafId = null;
            }
            document.removeEventListener('mousemove', onMove as EventListener);
            document.removeEventListener('touchmove', onMove as EventListener);
            document.removeEventListener('mouseup', endDrag);
            document.removeEventListener('touchend', endDrag);

            const finalWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').replace('px', '').trim();
            if (finalWidth) {
                localStorage.setItem('sidebar-width', finalWidth);
            }
            document.body.classList.remove('is-resizing');
        };

        const startDragMouse = () => {
            document.addEventListener('mousemove', onMove as EventListener);
            document.addEventListener('mouseup', endDrag);
            document.body.classList.add('is-resizing');
        };

        const startDragTouch = (e: TouchEvent) => {
            // prevent scroll interference
            if (e.cancelable) e.preventDefault();
            document.addEventListener('touchmove', onMove as EventListener, {passive: false});
            document.addEventListener('touchend', endDrag);
            document.body.classList.add('is-resizing');
        };

        const resetSidebar = () => {
            document.documentElement.style.setProperty('--sidebar-width', '300px');
            localStorage.removeItem('sidebar-width');
        };

        handle.addEventListener('mousedown', startDragMouse);
        handle.addEventListener('touchstart', startDragTouch as EventListener, {passive: false});
        handle.addEventListener('dblclick', resetSidebar);
    }

    _initEditorZoom(): void {
        const MIN = 10;
        const MAX = 32;
        const STEP = 2;

        let size = parseInt(localStorage.getItem('editor-font-size') || '14', 10);

        const apply = (s: number) => {
            size = Math.max(MIN, Math.min(MAX, s));
            const pxValue = `${size}px`;
            document.documentElement.style.setProperty('--editor-font-size', pxValue);
            localStorage.setItem('editor-font-size', String(size));
            (document.getElementById('editorZoomValue') as HTMLElement).textContent = pxValue;
            // Reconfigure font size through CodeMirror's compartment system
            // so it triggers a full layout pass including gutter recalculation
            this.editor?.setFontSize(size);
        };

        const handleZoomOut = () => apply(size - STEP);
        const handleZoomIn = () => apply(size + STEP);

        const onEditorKeydown = (e: KeyboardEvent) => {
            if (!e.ctrlKey && !e.metaKey) return;
            if (e.key === '=' || e.key === '+') {
                e.preventDefault();
                apply(size + STEP);
            } else if (e.key === '-') {
                e.preventDefault();
                apply(size - STEP);
            }
        };

        const onEditorWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            apply(size + delta * STEP);
        };

        (document.getElementById('editorZoomValue') as HTMLElement).textContent = `${size}px`;
        document.getElementById('editorZoomOut')!.addEventListener('click', handleZoomOut);
        document.getElementById('editorZoomIn')!.addEventListener('click', handleZoomIn);

        // Ctrl+= / Ctrl+- / Ctrl+Scroll when editor is focused
        this.elements.editor.addEventListener('keydown', onEditorKeydown);
        this.elements.editor.addEventListener('wheel', onEditorWheel, {passive: false});
    }

    resetUI(): void {
        const el = this.elements;

        el.transportBtn.classList.remove('transport--playing', 'transport--paused');
        el.transportBtn.textContent = '▶ Play';
        el.transportBtn.disabled = false;
        el.stopBtn.disabled = true;
        el.cycleCount.textContent = '0.00';
        el.voiceCount.textContent = '0';
    }

    async initAudio(): Promise<void> {
        this.setStatus('Loading WASM...');

        let wasmModule: WasmModule;
        let StrudelAudioManagerCtor: typeof import('../audio-manager.js').StrudelAudioManager;
        let PatternSchedulerCtor: typeof import('../scheduler.js').PatternScheduler;
        let SampleLoaderCtor: typeof import('../sample-loader.js').SampleLoader;
        let sampleRate: number;

        try {
            [wasmModule, {StrudelAudioManager: StrudelAudioManagerCtor}, {PatternScheduler: PatternSchedulerCtor}, {SampleLoader: SampleLoaderCtor}] = await Promise.all([
                import('../pkg/strudel_audio_wasm.js') as Promise<WasmModule>,
                import('../audio-manager.js'),
                import('../scheduler.js'),
                import('../sample-loader.js'),
            ]);

            // Initialize WASM
            this.wasm = wasmModule;

            // Create audio manager
            this.audioManager = new StrudelAudioManagerCtor();
            this.audioManager.onCrash = () => this._handleAudioCrash();
            sampleRate = await this.audioManager.init(wasmModule.default, wasmModule.MainThreadProcessor);
        } catch (e) {
            this.setStatus('Error: ' + (e as Error).message);
            console.error('Init failed:', e);
            return;
        }

        this.processor = this.audioManager.getProcessor();

        const audioContext = this.audioManager.getAudioContext()!;

        // Create scheduler
        this.scheduler = new PatternSchedulerCtor(
            this.processor!,
            audioContext
        );
        this.scheduler.audioManager = this.audioManager;
        this.scheduler.visualLatency = audioContext.outputLatency + audioContext.baseLatency;

        // Scheduler callbacks
        this.scheduler.onCycleUpdate = this.handleCycleUpdate;

        const analyser = this.audioManager.getAnalyser()!;

        // Create visualizer and wire scheduler into visualizer so it can borrow the pattern during render
        this.visualizer = new PatternVisualizer(
            this.elements.visualizer,
            this.audioManager.getWasmMemory()!,
            wasmModule.getCycleViewBufPtr(),
            wasmModule.getPianoRectsBufPtr(),
        );
        this.visualizer.scheduler = this.scheduler;

        // Create scope visualizer using the analyser already connected in audio manager
        this.scope = new ScopeVisualizer(this.elements.scope);
        this.scope.setAnalyser(analyser);

        this.visualizer.setAudioAnalyser(analyser);

        // Capture pointers for active-note highlighting
        this._activeLocsBufPtr = wasmModule.getActiveLocsBufPtr();
        this._wasmMemory = this.audioManager.getWasmMemory()!;

        // BPM is published by parsePattern into a single-f64 cell; we just keep
        // a view over it and read `[0]` after each parse. NaN = no value in code.
        const currentBpmPtr = wasmModule.getCurrentBpmPtr();
        this.bpmView = new Float64Array(this._wasmMemory.buffer, currentBpmPtr, 1);

        this.hideError();
        this.isInitialized = true;

        // Create sample loader
        this.sampleLoader = new SampleLoaderCtor(
            this.processor!,
            audioContext,
            this.audioManager
        );

        try {
            this.elements.sampleCount.textContent = 'Loading...';
            const loaded = await this.sampleLoader!.loadEssentialDrums();
            // Safety guard: If app was disposed during the await, stop here.
            if (!this.isInitialized) return;

            this.elements.sampleCount.textContent = `${loaded} drums`;
        } catch (e) {
            if (!this.isInitialized) return;
            this.elements.sampleCount.textContent = 'Failed';
            console.warn('Sample loading failed:', e);
        }

        this.audioManager.discardAllocLog();

        this.setStatus(`Ready! v${wasmModule.version()} @ ${sampleRate!}Hz Worklet`);

        // Start stats update
        this.startStatsUpdate();
    }

    startStatsUpdate(): void {
        if (this.statsInterval) clearInterval(this.statsInterval);
        this.statsInterval = setInterval(this.updateStats, 100);
    }

    debouncedEvaluate = this.debounce((code: string) => {
        // Safety: don't evaluate if we are currently cleaning up
        if (!this.isInitialized || !this.audioManager) return;

        try {
            const {pattern, bpm} = this.parsePatternWithTempo(code);
            // Hot-swap without resetting the clock so the pattern continues
            // from the current cycle position instead of jumping to 0.
            this.scheduler!.setPattern(pattern, false);
            if (bpm != null) {
                this.applyBpm(bpm);
            }
            this.visualizer?.resetCache();
            this.updateVisualization();
            this.hideError();
        } catch (e) {
            const msg = (e as Error).message || String(e);
            this.showError(msg);
        }
    }, 100);

    parsePatternWithTempo(code: string): { pattern: PatternHandle; bpm: number | undefined } {
        const pattern = this.wasm!.parsePattern(code);
        const raw = this.bpmView ? this.bpmView[0] : NaN;
        return {pattern, bpm: isNaN(raw) ? undefined : raw};
    }

    async evaluate(code: string): Promise<void> {
        if (!this.isInitialized) {
            if (this._initInProgress) return;
            await this._initAndPlay();
            return;
        }

        let pattern: PatternHandle;
        try {
            const result = this.parsePatternWithTempo(code);
            pattern = result.pattern;

            // Hot-swap without resetting the clock so the pattern continues
            // from the current cycle position instead of jumping to 0.
            this.scheduler!.setPattern(pattern, false);
            this.visualizer?.resetCache();
            // Use tempo from code if present, otherwise use slider value
            this.applyBpm(result.bpm ?? parseInt(this.elements.bpmSlider.value, 10));
        } catch (e) {
            const msg = (e as Error).message || String(e);
            this.showError(msg); // Normal syntax error
            return;
        }

        if (this.playbackState !== PlaybackState.Playing) {
            this.scheduler!.start();
            this._enterPlayingState();
        }

        this.hideError();
    }

    async ensureAudioInitialized(): Promise<boolean> {
        if (this.isInitialized) {
            return true;
        }

        if (this._initInProgress) {
            return false;
        }

        this._initInProgress = true;

        const btn = this.elements.transportBtn;
        btn.disabled = true;
        btn.textContent = '⏳ Starting...';

        try {
            await this.initAudio();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            return this.isInitialized;
        } catch (e) {
            console.error('Audio init failed:', e);
            this.showError('Could not start audio engine.');
            return false;
        } finally {
            this._initInProgress = false;

            if (this.playbackState !== PlaybackState.Playing) {
                btn.textContent = '▶ Play';
                btn.classList.remove('transport--playing');
                btn.disabled = false;
            }
        }
    }

    async replaceCodeAndPlay(code: string): Promise<void> {
        if (!this.editor) return;

        this._suppressNextCodeChange = true;
        this.editor.setCode(code);
        await this.evaluate(code);
    }

    private _enterPlayingState(): void {
        this.playbackState = PlaybackState.Playing;

        this._setTransportPlaying();
        this.elements.stopBtn.disabled = false;
        this.scope?.startAnimation();
        this.visualizer?.startAnimation();

        this.elements.liveIndicator.classList.remove('indicator-paused');
        this.elements.liveIndicator.classList.add('active');
    }

    play(): void {
        const code = this.editor!.getCode();
        this.evaluate(code);
    }

    /**
     * Pause playback. Fades out the GainNode to silence, then stops the
     * scheduler. The AudioContext is intentionally NOT suspended - suspend()
     * causes an OS-level discontinuity click regardless of graph output.
     * The render loop keeps running so the worklet is never starved of samples.
     */
    pause(): void {
        if (this.playbackState !== PlaybackState.Playing) return;
        this.playbackState = PlaybackState.Paused;

        // Stop scheduling new events. clearEvents() flushes the lookahead
        // queue so those events don't double-fire on resume.
        this.scheduler!.pause();

        const btn = this.elements.transportBtn;
        btn.classList.remove('transport--playing');
        btn.classList.add('transport--paused');
        btn.textContent = '▶ Resume';
        btn.disabled = false;

        this.elements.stopBtn.disabled = false;
        this.scope!.pauseAnimation();

        this.elements.liveIndicator.classList.remove('active');
        this.elements.liveIndicator.classList.add('indicator-paused');
    }

    /**
     * Resume from a paused state. Fades the GainNode back in and restarts
     * the scheduler. startTime is reconstructed from pausedCycle since
     * currentTime kept advancing while the context remained running.
     */
    resume(): void {
        if (this.playbackState !== PlaybackState.Paused) return;

        this.scheduler!.resume();
        this._enterPlayingState();
    }

    /**
     * Transport button handler: cycles Stopped->Play, Playing->Pause, Paused->Resume.
     * On first press, initializes audio then plays immediately.
     */
    async togglePlayPause(): Promise<void> {
        // Worklet crashed previously — tear down the dead pipeline and rebuild
        // before doing anything else. Re-init then plays the current editor code.
        if (this._audioCrashed) {
            await this._recoverFromAudioCrash();
            return;
        }

        if (!this.isInitialized) {
            if (this._initInProgress) return;
            await this._initAndPlay();
            return;
        }
        switch (this.playbackState) {
            case PlaybackState.Stopped:
                this.play();
                break;
            case PlaybackState.Playing:
                this.pause();
                break;
            case PlaybackState.Paused:
                this.resume();
                break;
        }
    }

    /**
     * Reset state after an AudioWorkletProcessor crash. The worklet stops
     * calling process() permanently once it throws, so no audio is possible
     * until we rebuild the AudioContext + shared memory from scratch. Surfaces
     * the error to the user and arms the next Play press to re-init.
     */
    private _handleAudioCrash(): void {
        if (this._audioCrashed) return;
        this._audioCrashed = true;

        // Mark the engine as not-initialized so debouncedEvaluate + the rest
        // of the app stop poking at the dead scheduler/processor.
        this.isInitialized = false;

        try { this.scheduler?.stop(); } catch { /* worklet is dead, ignore */ }
        this.playbackState = PlaybackState.Stopped;

        const btn = this.elements.transportBtn;
        btn.classList.remove('transport--playing', 'transport--paused');
        btn.textContent = '↻ Restart audio';
        btn.disabled = false;

        this.elements.stopBtn.disabled = true;
        this.elements.liveIndicator.classList.remove('active', 'indicator-paused');

        this.showError('Audio engine crashed — press Play to restart.');
    }

    /**
     * Full teardown + re-init triggered by the next Play press after a crash.
     * Preserves the current editor code; once the new audio engine is ready
     * it evaluates that code so playback resumes from the same pattern.
     */
    private async _recoverFromAudioCrash(): Promise<void> {
        if (this._recoveringFromCrash) return;
        this._recoveringFromCrash = true;

        const btn = this.elements.transportBtn;
        btn.disabled = true;
        btn.textContent = '⏳ Restarting...';

        try {
            await this.dispose();
            this._audioCrashed = false;
            this.hideError();
            await this._initAndPlay();
        } finally {
            this._recoveringFromCrash = false;
        }
    }

    /**
     * Initialize audio on first interaction, then play immediately.
     *
     * A requestAnimationFrame barrier before play() gives the AudioWorklet one
     * full render quantum to settle after init before the scheduler starts
     * dispatching events, preventing the audio overlap that occurs when both
     * happen in the same microtask chain as audioManager.init() resolving.
     */
    private async _initAndPlay(): Promise<void> {
        const ready = await this.ensureAudioInitialized();
        if (!ready) {
            return;
        }

        this.play();
    }

    /** Update transport button to the "currently playing" appearance. */
    private _setTransportPlaying(): void {
        const btn = this.elements.transportBtn;
        btn.classList.remove('transport--paused');
        btn.classList.add('transport--playing');
        btn.textContent = '⏸ Pause';
        btn.disabled = false;
    }

    stop(): void {
        if (this.playbackState === PlaybackState.Stopped) return;

        this.scheduler?.stop();
        this.playbackState = PlaybackState.Stopped;

        const btn = this.elements.transportBtn;
        btn.classList.remove('transport--playing', 'transport--paused');
        btn.textContent = '▶ Play';
        btn.disabled = false;

        this.elements.stopBtn.disabled = true;

        this.elements.liveIndicator.classList.remove('active', 'indicator-paused');

        this.elements.cycleCount.textContent = '0.00';
        this.editor?.clearActiveNotes();
        this.scope!.stopAnimation();
        this.visualizer!.stopAnimation();
        // Pattern was freed by scheduler.stop() above, so render() will
        // clearRect and return early - leaving the canvas blank, matching
        // the Play -> Stop behaviour where the rAF loop does this naturally.
        this.visualizer!.render();
    }

    applyBpm(bpm: number): void {
        bpm = Math.max(30, Math.min(300, bpm));
        if (isNaN(bpm)) return;
        const value = String(bpm);
        localStorage.setItem('bpm', value);
        this.elements.bpmSlider.value = value;
        this.elements.bpmValue.value = value;
        this.elements.bpmDisplay.textContent = value;
        if (this.scheduler) {
            this.scheduler.setBpm(bpm);
        }
    }

    updateVisualization(): void {
        this.visualizer!.render();
    }

    setStatus(text: string): void {
        this.elements.status.textContent = text;
    }

    /**
     * @param message
     * @param decorate  pass false to skip squiggle
     */
    showError(message: string, decorate = true): void {
        this.elements.error.textContent = message;
        this.elements.error.classList.add('error--visible');

        if (decorate && this.editor) {
            const doc = this.editor.view.state.doc;

            const byRange = /at (\d+)\.\.(\d+)/i.exec(message);
            const byPos = /at position (\d+)/i.exec(message);

            let from: number | null = null;
            let to: number | null = null;

            if (byRange) {
                from = Math.max(0, Math.min(parseInt(byRange[1], 10), doc.length));
                to = Math.max(from, Math.min(parseInt(byRange[2], 10), doc.length));
            } else if (byPos) {
                const pos = Math.max(0, Math.min(parseInt(byPos[1], 10), doc.length));
                const line = doc.lineAt(pos);
                from = pos;
                to = line.to > pos ? line.to : Math.min(pos + 1, doc.length);
            }

            if (from !== null && to !== null && from <= to) {
                this.editor.setErrorDecoration(from, to, message);
            }
        }
    }

    hideError(): void {
        this.elements.error.classList.remove('error--visible');
        this.editor?.clearErrorDecoration();
    }

    /**
     * @param fn - The function to debounce.
     * @param delay - Delay in milliseconds.
     * @returns A debounced function with a `.cancel()` method.
     */
    debounce<T extends unknown[]>(fn: (...args: T) => void, delay: number): ((...args: T) => void) & {
        cancel: () => void
    } {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const debounced = (...args: T) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), delay);
        };
        debounced.cancel = () => clearTimeout(timeout);
        return debounced;
    }

    async dispose(): Promise<void> {
        this.isInitialized = false;
        this.playbackState = PlaybackState.Stopped;
        this.latestCycle = 0;
        this.vizPending = false;

        this.debouncedEvaluate?.cancel();

        this.resetUI();

        if (this.visualizer) {
            this.visualizer.dispose();
            this.visualizer = null;
        }
        if (this.scope) {
            this.scope.dispose();
            this.scope = null;
        }

        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }

        if (this.scheduler) {
            this.scheduler.dispose();
            this.scheduler = null;
        }

        if (this.audioManager) {
            await this.audioManager.dispose();
            this.audioManager = null;
        }

        this.processor = null;
        this.sampleLoader = null;

        // Force the ES module to drop the memory
        this.wasm?.__drop_wasm();
        this.wasm = null;
    }
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new StrudelApp();
    window.strudelApp = app;
    app.init();

    // Enable transport button after the first frame
    // Prevents race conditions if user clicks too early
    requestAnimationFrame(() => {
        app.elements.transportBtn.disabled = false;
    });
});
