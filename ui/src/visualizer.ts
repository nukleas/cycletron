/**
 * Pattern Visualizer for Strudel WASM REPL
 *
 * Provides multiple visualization modes:
 * - Cycle view: Shows pattern events as blocks on a timeline
 * - Piano roll: Shows notes vertically with time horizontally
 * - Waveform: Real-time audio waveform display
 */

import type {PatternHandle} from '../pkg';
import type {PatternScheduler} from '../scheduler.js';
import {VizMode} from './types/visualizer.js';
import {pauseWhileHidden} from './viz-visibility.js';
import {measure} from '../query-profiler.js';

export {VizMode};

const MIN_NOTE = 24; // C1
const MAX_NOTE = 96; // C7
const INV_NOTE_RANGE = 1.0 / 72.0;
const INV_128 = 1.0 / 128.0;

// Must match CYCLE_VIEW_CAPACITY, PIANO_RECTS_CAPACITY, and MAX_TRACKS in strudel-audio-wasm/lib.rs
const CYCLE_VIEW_CAPACITY = 4096;
const PIANO_RECTS_CAPACITY = 8192;
const MAX_TRACKS = 128;

export class PatternVisualizer {
    private readonly midiNoteTable: string[];
    private readonly cNoteLabels: string[];
    private readonly cNotePositions: number[];

    container: HTMLDivElement;
    private width: number;
    private readonly _baseHeight: number;
    private height: number;

    private mode: VizMode;

    private readonly cycles: number;

    private colorBg: string;
    private colorGrid: string;
    private colorGridAccent: string;
    private colorText: string;
    private colorPlayhead: string;
    private colorActive: string;
    private colorHot: string;

    private readonly eventColors: string[];

    private canvas: HTMLCanvasElement | null;
    private _glowCanvas: HTMLCanvasElement | null = null;
    private _staticCanvas: HTMLCanvasElement | null = null;
    private _staticCtx: CanvasRenderingContext2D | null = null;
    private _staticDirty: boolean = true;
    private ctx: CanvasRenderingContext2D | null;
    private animationId: number | null;
    private shouldAnimate: boolean;
    private currentCycle: number;
    scheduler: PatternScheduler | null;
    private audioAnalyser: AnalyserNode | null;
    private waveformData: Uint8Array | null;

    private cycleViewBuf: Float32Array | null;
    private pianoRectsBuf: Float32Array | null;
    private _lastStartCycle: number;
    private _detectedPeriod: number;

    /**
     * Flat array cache for track name resolution.
     *
     * Indexed directly by track ID (O(1), no hashing). Populated lazily via
     * `pattern.getTrackName(id)` on first encounter. Cleared when
     * `registryVersion` in the cycle-view header changes, which happens only
     * when the Rust registry purges on overflow (> MAX_TRACKS distinct names).
     * In normal use this never occurs.
     */
    private readonly trackNameCache: (string | undefined)[];
    private lastRegistryVersion: number;

    private readonly resizeObserver: ResizeObserver;
    private _themeQuery: MediaQueryList | null;
    private _themeHandler: (() => void) | null;
    private _resizeRafId: number | null = null;
    private _pendingResizeWidth: number = 0;
    private _pendingResizeDpr: number = 0;
    private _pendingResize: boolean = false;

    constructor(
        container: HTMLDivElement,
        mem: WebAssembly.Memory,
        cycleViewPtr: number,
        pianoRectsPtr: number,
    ) {
        this.midiNoteTable = new Array(128);
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        for (let i = 0; i < 128; i++) {
            this.midiNoteTable[i] =
                NOTE_NAMES[i % 12] + ((i / 12 | 0) - 1);
        }

        this.cNoteLabels = [];
        this.cNotePositions = [];
        for (let note = MIN_NOTE; note <= MAX_NOTE; note++) {
            if (note % 12 === 0) {
                this.cNoteLabels.push(`C${Math.floor(note / 12) - 1}`);
                this.cNotePositions.push(note);
            }
        }

        this.container = container;
        this.width = 800;
        this._baseHeight = 120;
        this.height = this._baseHeight;

        const saved = localStorage.getItem('visualizer-mode');
        // Parse once on init from stored integer; default to Cycle
        this.mode = saved !== null ? (parseInt(saved, 10) as VizMode) : VizMode.Cycle;

        this.cycles = 4;

        this.colorBg = "#0a0a0c";
        this.colorGrid = '#1a1a1e';
        this.colorGridAccent = '#1e1e24';
        this.colorText = '#687797';
        this.colorPlayhead = '#ff2bd6';
        this.colorActive = '#f7ff5a';
        this.colorHot = '#47f6ff';


        // Event color palette — readable cyberpunk colors with non-adjacent hues.
        this.eventColors = [
            '#47f6ff',
            '#ff2bd6',
            '#52ff9f',
            '#f7ff5a',
            '#9d7cff',
            '#ffb000',
            '#ff456c',
            '#6aa8ff',
        ];

        this.canvas = null;
        this.ctx = null;
        this.animationId = null;
        this.shouldAnimate = false;
        this.currentCycle = 0;
        this.scheduler = null;
        this.audioAnalyser = null;
        this.waveformData = null;

        this.cycleViewBuf = null;
        this.pianoRectsBuf = null;
        this._lastStartCycle = -1;
        this._detectedPeriod = 0;

        // Flat array sized to MAX_TRACKS. Direct index lookup, no hashing.
        // Cleared when registry_version in the cycle-view header changes.
        this.trackNameCache = new Array(MAX_TRACKS).fill(undefined);
        this.lastRegistryVersion = -1;

        this._themeQuery = null;
        this._themeHandler = null;

        pauseWhileHidden({
            pause: () => {
                if (this.animationId !== null) {
                    cancelAnimationFrame(this.animationId);
                    this.animationId = null;
                }
            },
            resume: () => {
                if (this.shouldAnimate && this.mode === VizMode.Waveform
                    && this.animationId === null) {
                    this.animate();
                }
            },
        });

        this.resizeObserver = new ResizeObserver(this._onResize);

        this.cycleViewBuf = new Float32Array(mem.buffer, cycleViewPtr, CYCLE_VIEW_CAPACITY);
        this.pianoRectsBuf = new Float32Array(mem.buffer, pianoRectsPtr, PIANO_RECTS_CAPACITY);
        this.init();
    }

    /**
     * Pulls CSS variables from :root. Call this on init or theme toggle.
     */
    updateTheme(): void {
        const style = getComputedStyle(document.documentElement);
        const css = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
        this.colorBg = css('--bg', '#05060a');
        this.colorGrid = css('--bg-lighter', '#111827');
        this.colorGridAccent = css('--border', '#26324c');
        this.colorText = css('--text-muted', '#687797');
        this.colorPlayhead = css('--viz-hot', '#ff2bd6');
        this.colorActive = css('--viz-active', '#f7ff5a');
        this.colorHot = css('--neon', '#47f6ff');
        this.eventColors.splice(0, this.eventColors.length,
            css('--neon', '#47f6ff'),
            css('--neon-secondary', '#ff2bd6'),
            css('--green-bright', '#52ff9f'),
            css('--viz-active', '#f7ff5a'),
            css('--violet', '#9d7cff'),
            css('--orange', '#ffb000'),
            css('--red', '#ff456c'),
            '#6aa8ff',
        );
        this._rebuildGlow();
        this._staticDirty = true;
    }

    private _rebuildGlow(): void {
        if (!this._glowCanvas) return;

        const gc = this._glowCanvas.getContext('2d')!;
        const g = gc.createLinearGradient(0, 0, this._glowCanvas.width, 0);
        g.addColorStop(0, 'rgba(255, 43, 214, 0)');
        g.addColorStop(0.5, 'rgba(255, 43, 214, 0.26)');
        g.addColorStop(1, 'rgba(255, 43, 214, 0)');
        gc.clearRect(0, 0, this._glowCanvas.width, this._glowCanvas.height);
        gc.fillStyle = g;
        gc.fillRect(0, 0, this._glowCanvas.width, this._glowCanvas.height);
    }

    init(): void {
        this._themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this._themeHandler = () => {
            this.updateTheme();
            this.render();
        };
        this._themeQuery.addEventListener('change', this._themeHandler);

        this._glowCanvas = document.createElement('canvas');
        this._glowCanvas.width = 40;
        this._glowCanvas.height = 1;

        // _staticCanvas allocated lazily on first cycle view render

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block; width:100%; height:100%; image-rendering:pixelated;';
        this.container.appendChild(this.canvas);
        // alpha:false - background is opaque, skip RGBA compositing
        this.ctx = this.canvas.getContext('2d', {alpha: false});

        // Handle resize
        this.resizeObserver.observe(this.container);

        this.updateTheme();
        this.render();
    }

    _onResize = (): void => {
        this.handleResize();
    };

    handleResize(): void {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Record the latest dimensions but don't touch the canvas backing store yet.
        // Coalescing into one rAF means at most one bitmap reallocation per frame
        // regardless of how many ResizeObserver callbacks fire.
        this._pendingResizeWidth = rect.width;
        this._pendingResizeDpr = dpr;
        this._pendingResize = true;

        if (this._resizeRafId !== null) return;
        this._resizeRafId = requestAnimationFrame(() => {
            this._resizeRafId = null;
            if (this._pendingResize) {
                this._pendingResize = false;
                this._applyResize(this._pendingResizeWidth, this._pendingResizeDpr);
            }
        });
    }

    private _applyResize(width: number, dpr: number): void {
        // Bitmap reallocation and render happen in the same rAF callback,
        // so the canvas is never cleared without being immediately repainted.
        this.canvas!.width = width * dpr;

        if (this.mode !== VizMode.Cycle) {
            this.height = this._baseHeight;
        }

        this.canvas!.height = this.height * dpr;
        this.canvas!.style.height = `${this.height}px`;

        this.ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.width = width;

        // Only sync if already allocated - lazy creation happens in _renderCycleStatic
        if (this._staticCanvas) {
            this._staticCanvas.width = this.canvas!.width;
            this._staticCanvas.height = this.canvas!.height;
            this._staticCtx!.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // Don't reset _lastStartCycle - the pattern data is still valid for the
        // same cycle position, only the pixel layout changed. _staticDirty = true
        // is sufficient to trigger a static redraw at the new dimensions.
        this._staticDirty = true;

        this.render();
    }

    setMode(mode: VizMode): void {
        if (this.mode === mode) return;

        this.mode = mode;
        // Fast numeric string storage
        localStorage.setItem('visualizer-mode', mode.toString());

        if (mode !== VizMode.Cycle) {
            const dpr = window.devicePixelRatio || 1;
            this.canvas!.height = this._baseHeight * dpr;
            this.canvas!.style.height = `${this._baseHeight}px`;
            this.height = this._baseHeight;
            this.container.style.height = `${this._baseHeight}px`;
            this._lastStartCycle = -1;
            this.ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        this.render();

        if (mode === VizMode.Waveform && this.shouldAnimate) {
            this.startAnimation();
        } else if (mode !== VizMode.Waveform && this.animationId !== null) {
            this._cancelAnimationFrame();
        }
    }

    setCycle(cycle: number): void {
        this.currentCycle = cycle;
        this.render();
    }

    setAudioAnalyser(analyser: AnalyserNode): void {
        this.audioAnalyser = analyser;
        this.waveformData = new Uint8Array(analyser.frequencyBinCount);
    }

    /**
     * Convert MIDI note to y position
     */
    noteToY(note: number): number {
        const normalized = (note - MIN_NOTE) * INV_NOTE_RANGE;
        return this.height - (normalized * (this.height - 40)) - 20;
    }

    render(): void {
        const {ctx, width, height, mode} = this;

        // alpha:false requires explicit background fill instead of clearRect
        ctx!.fillStyle = this.colorBg;
        ctx!.fillRect(0, 0, width, height);

        const pattern = this.scheduler?.pattern;
        if (!pattern) return;

        switch (mode) {
            case VizMode.Cycle:
                this.renderCycleView(pattern);
                break;
            case VizMode.Piano:
                this.renderPianoRoll(pattern);
                break;
            case VizMode.Waveform:
                this.renderWaveform();
                break;
        }
    }

    renderCycleView(pattern: PatternHandle): void {
        const {ctx, width, cycles, currentCycle} = this;

        const eventHeight = 30;
        const padding = 10;

        const snapUnit = (this._detectedPeriod > 0 && this._detectedPeriod < cycles - 0.01)
            ? this._detectedPeriod
            : cycles;
        const startCycle = Math.floor(currentCycle / snapUnit) * snapUnit;

        if (startCycle !== this._lastStartCycle) {
            // Query uses detected period if known - avoids over-allocating in Rust
            measure('queryCycleViewData', currentCycle, () =>
                pattern.queryCycleViewData(Math.floor(startCycle), snapUnit));
            this._lastStartCycle = startCycle;
            this._staticDirty = true;
        }

        const data = this.cycleViewBuf!;

        const trackCount = data[0];
        const maxDataEnd = data[1];
        const registryVersion = data[2];

        // If the Rust registry was purged (overflow of MAX_TRACKS distinct names),
        // the version increments and we clear the cache. In normal use this never fires.
        if (registryVersion !== this.lastRegistryVersion) {
            this.trackNameCache.fill(undefined);
            this.lastRegistryVersion = registryVersion;
            this._staticDirty = true;
        }

        const detectedPeriod = maxDataEnd > 0.01 ? Math.round(maxDataEnd) : cycles;
        if (detectedPeriod < cycles) {
            this._detectedPeriod = detectedPeriod;
        }

        const effectiveCycles = detectedPeriod < cycles ? detectedPeriod : cycles;
        // Guard against pathological patterns (e.g. note("c*2048")) that produce
        // so many haps that maxDataEnd rounds to 0 and effectiveCycles bottoms out.
        if (effectiveCycles <= 0) {
            ctx!.fillStyle = this.colorPlayhead;
            ctx!.font = 'bold 16px ui-monospace, monospace';
            ctx!.textAlign = 'center';
            ctx!.fillText('Pattern too dense to visualize', width / 2, this.height / 2);
            ctx!.textAlign = 'left';
            return;
        }

        const cycleWidth = width / effectiveCycles;

        const trackStride = eventHeight + 20;
        const requiredHeight = 30 + trackCount * trackStride + padding;

        if (this.height !== requiredHeight) {
            const dpr = window.devicePixelRatio || 1;
            this.canvas!.height = requiredHeight * dpr;
            this.canvas!.style.height = `${requiredHeight}px`;
            this.height = requiredHeight;
            this.container.style.height = `${requiredHeight}px`;
            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Repaint the background immediately after resize to avoid a black
            // frame - _renderCycleStatic will repaint content below, but the
            // main canvas background must be filled now before the blit.
            ctx!.fillStyle = this.colorBg;
            ctx!.fillRect(0, 0, width, requiredHeight);
            this._staticDirty = true;
        }

        const height = this.height;

        if (this._staticDirty) {
            this._renderCycleStatic(
                pattern, startCycle, effectiveCycles,
                cycleWidth, trackCount, trackStride, eventHeight, height,
            );
            this._staticDirty = false;
        }

        // Blit pre-rendered static layer
        ctx!.drawImage(this._staticCanvas!, 0, 0, width, height);

        // Draw playhead + glow on canvas so they're always in the same composite frame
        const playheadX = (currentCycle % snapUnit) * cycleWidth;

        // Glow: pre-baked 40x1 canvas stretched to full height - one GPU blit, no per-frame alloc
        ctx!.drawImage(this._glowCanvas!, 0, 0, 40, 1, playheadX - 20, 0, 40, height);

        ctx!.strokeStyle = this.colorPlayhead;
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.moveTo(playheadX, 0);
        ctx!.lineTo(playheadX, height);
        ctx!.stroke();
    }

    private _renderCycleStatic(
        pattern: PatternHandle,
        startCycle: number,
        effectiveCycles: number,
        cycleWidth: number,
        trackCount: number,
        trackStride: number,
        eventHeight: number,
        height: number,
    ): void {
        const dpr = window.devicePixelRatio || 1;
        const targetWidth = this.canvas!.width;
        const targetHeight = this.canvas!.height;

        // Lazy allocation - only created when cycle view is actually rendered
        if (!this._staticCanvas) {
            this._staticCanvas = document.createElement('canvas');
            this._staticCtx = this._staticCanvas.getContext('2d', {alpha: false});
        }

        // Resize if dimensions changed (covers both initial allocation and height changes)
        if (this._staticCanvas.width !== targetWidth || this._staticCanvas.height !== targetHeight) {
            this._staticCanvas.width = targetWidth;
            this._staticCanvas.height = targetHeight;
            this._staticCtx!.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        const {width, colorBg, colorGrid, colorGridAccent, colorText} = this;
        const ctx = this._staticCtx!;
        const data = this.cycleViewBuf!;

        // alpha:false requires explicit background fill instead of clearRect
        ctx.fillStyle = colorBg;
        ctx.fillRect(0, 0, width, height);

        // Draw grid lines (one per cycle)
        ctx.strokeStyle = colorGridAccent;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        for (let i = 0; i <= effectiveCycles; i++) {
            const x = (i / effectiveCycles) * width;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();

        // Draw beat subdivisions (4 per cycle)
        ctx.strokeStyle = colorGrid;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        for (let i = 0; i < effectiveCycles * 4; i++) {
            const x = (i / (effectiveCycles * 4)) * width;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw cycle numbers
        ctx.fillStyle = colorText;
        ctx.font = '10px ui-monospace, monospace';
        for (let i = 0; i < effectiveCycles; i++) {
            const x = (i / effectiveCycles) * width;
            ctx.fillText(`cycle ${Math.floor(startCycle) + i}`, x + 8, 16);
        }

        // Buffer layout (after 3-float header): [track_id, event_count, begin, end, note, ...] per track
        let i = 3;

        const labelFont = 'bold 10px ui-monospace, monospace';
        const trackFont = '9px ui-monospace, monospace';

        for (let trackIdx = 0; trackIdx < trackCount; trackIdx++) {
            const y = 30 + trackIdx * trackStride;

            // Read track_id and resolve name via flat array cache (O(1) index).
            // getTrackName() is called at most once per unique ID per registry generation.
            const trackId = data[i++];
            let trackName = this.trackNameCache[trackId];
            if (trackName === undefined) {
                trackName = String(pattern.getTrackName(trackId) ?? `track${trackId}`);
                this.trackNameCache[trackId] = trackName;
            }
            const trackLabel: string = trackName ?? `track${trackId}`;

            // Read events for this track
            const eventCount = data[i++];
            const color = this.eventColors[trackIdx % this.eventColors.length];

            // Draw all event rects for this track in one fill-style set.
            ctx.fillStyle = color;
            for (let e = 0; e < eventCount; e++) {
                const begin = data[i++];
                const end = data[i++];
                const note = data[i++];

                if (end < 0 || begin > effectiveCycles) continue;

                const x = begin * cycleWidth;
                const w = Math.max((end - begin) * cycleWidth, 4);

                ctx.fillRect(x, y, w - 2, eventHeight);

                // Label (only when wide enough).
                if (w > 30) {
                    ctx.fillStyle = '#05060a';
                    ctx.font = labelFont;
                    const label = Number.isFinite(note)
                        ? (this.midiNoteTable[note & 127] ?? String(note))
                        : trackLabel;
                    ctx.fillText(label, x + 6, y + 19);
                    // Restore event color for next iteration.
                    ctx.fillStyle = color;
                    ctx.font = labelFont; // keep consistent
                }
            }

            // Track label below events.
            ctx.fillStyle = colorText;
            ctx.font = trackFont;
            ctx.fillText(trackLabel, 4, y + eventHeight + 14);
        }
    }

    renderPianoRoll(pattern: PatternHandle): void {
        const {ctx, width, height, cycles, currentCycle, colorGrid, colorGridAccent, colorText} = this;

        const labelWidth = 20;
        const drawWidth = width - labelWidth;
        const cycleWidth = drawWidth / cycles;
        const noteHeight = (height - 20) / (MAX_NOTE - MIN_NOTE);

        // Batch all black keys into one path
        ctx!.fillStyle = colorGrid;
        ctx!.beginPath();
        for (let note = MIN_NOTE; note <= MAX_NOTE; note++) {
            if ((1354 >> (note % 12)) & 1) {
                ctx!.rect(labelWidth, this.noteToY(note), drawWidth, noteHeight);
            }
        }
        ctx!.fill();

        // Batch all C-note accent lines
        ctx!.strokeStyle = colorGridAccent;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        for (let note = MIN_NOTE; note <= MAX_NOTE; note++) {
            if (note % 12 === 0) {
                const y = this.noteToY(note);
                ctx!.moveTo(labelWidth, y);
                ctx!.lineTo(width, y);
            }
        }
        ctx!.stroke();

        // Batch vertical beat lines (reuses same strokeStyle)
        ctx!.beginPath();
        for (let i = 0; i <= cycles; i++) {
            const x = labelWidth + i * cycleWidth;
            ctx!.moveTo(x, 0);
            ctx!.lineTo(x, height);
        }
        ctx!.stroke();

        // SAFETY: this is fine to store since the view is dedicated specifically for this callsite
        const startCycle = Math.floor(currentCycle / cycles) * cycles;
        const len = measure('queryVizRectsView', currentCycle, () =>
            pattern.queryVizRectsView(startCycle, currentCycle, cycles, drawWidth, height));
        const rects = this.pianoRectsBuf!;

        // rects[0] = number of inactive rects; stride is 4: [x, y, w, h]
        const inactiveCount = rects[0];
        const inactiveEnd = 1 + inactiveCount * 4;

        // shadowBlur is a GPU composite operation applied *per fill* and is by
        // far the most expensive canvas operation in this hot path.
        // We replace it with a slightly larger, low-opacity rect drawn first.

        // Batch 1: all inactive rects in a single path
        ctx!.fillStyle = colorGridAccent;
        ctx!.strokeStyle = colorGrid;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        for (let i = 1; i < inactiveEnd; i += 4) {
            ctx!.rect(rects[i] + labelWidth + 1, rects[i + 1] + 1, rects[i + 2] - 3, rects[i + 3] - 2);
        }
        ctx!.fill();
        ctx!.stroke();

        // Batch 2: active glow halos in a single path
        ctx!.fillStyle = 'rgba(255, 43, 214, 0.26)';
        ctx!.beginPath();
        for (let i = inactiveEnd; i < len; i += 4) {
            ctx!.rect(rects[i] + labelWidth - 2, rects[i + 1] - 2, rects[i + 2] + 3, rects[i + 3] + 4);
        }
        ctx!.fill();

        // Batch 3: active rects in a single path
        ctx!.fillStyle = this.colorActive;
        ctx!.beginPath();
        for (let i = inactiveEnd; i < len; i += 4) {
            ctx!.rect(rects[i] + labelWidth + 1, rects[i + 1] + 1, rects[i + 2] - 3, rects[i + 3] - 2);
        }
        ctx!.fill();

        // Draw playhead
        const playheadX = labelWidth + (currentCycle % cycles) * cycleWidth;
        ctx!.strokeStyle = this.colorPlayhead;
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.moveTo(playheadX, 0);
        ctx!.lineTo(playheadX, height);
        ctx!.stroke();

        ctx!.fillStyle = colorText;
        ctx!.font = '9px ui-monospace, monospace';
        for (let i = 0; i < this.cNoteLabels.length; i++) {
            ctx!.fillText(this.cNoteLabels[i], 4, this.noteToY(this.cNotePositions[i]) + 10);
        }
    }

    renderWaveform(): void {
        const {ctx, width, height, colorGrid, colorText} = this;

        if (!this.audioAnalyser || !this.waveformData) {
            // No audio data - draw placeholder
            ctx!.fillStyle = colorText;
            ctx!.font = '12px ui-monospace, monospace';
            ctx!.textAlign = 'center';
            ctx!.fillText('Waveform (connect audio analyser)', width / 2, height / 2);
            ctx!.textAlign = 'left';
            return;
        }

        // Get waveform data
        this.audioAnalyser.getByteTimeDomainData(this.waveformData as Uint8Array<ArrayBuffer>);

        // Draw waveform
        const sliceWidth = width / this.waveformData.length;
        let x = 0;

        ctx!.strokeStyle = this.colorHot;
        ctx!.lineWidth = 2;
        ctx!.beginPath();

        for (let i = 0; i < this.waveformData.length; i += 4) {
            const v = this.waveformData[i] * INV_128;
            const y = (v * height) * 0.5;

            if (i === 0) {
                ctx!.moveTo(x, y);
            } else {
                ctx!.lineTo(x, y);
            }

            x += sliceWidth * 4;
        }

        ctx!.stroke();

        // Draw center line
        ctx!.strokeStyle = colorGrid;
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(0, height / 2);
        ctx!.lineTo(width, height / 2);
        ctx!.stroke();
    }

    animate = (): void => {
        if (!this.canvas || !this.shouldAnimate || this.mode !== VizMode.Waveform) {
            this.animationId = null;
            return;
        }

        this.render();
        this.animationId = requestAnimationFrame(this.animate);
    };

    // Start animation loop (for waveform mode)
    startAnimation(): void {
        this.shouldAnimate = true;
        if (this.mode !== VizMode.Waveform || this.animationId !== null) {
            return;
        }

        this.animate();
    }

    private _cancelAnimationFrame(): void {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    resetCache(): void {
        this._lastStartCycle = -1;
        this._detectedPeriod = 0;
        this._staticDirty = true;
    }

    stopAnimation(): void {
        this.shouldAnimate = false;
        this._cancelAnimationFrame();
    }

    dispose(): void {
        this.stopAnimation();
        if (this._resizeRafId !== null) {
            cancelAnimationFrame(this._resizeRafId);
            this._resizeRafId = null;
        }
        this._pendingResize = false;
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        if (this._themeQuery && this._themeHandler) {
            this._themeQuery.removeEventListener('change', this._themeHandler);
            this._themeQuery = null;
            this._themeHandler = null;
        }

        if (this.canvas) {
            this.canvas.remove();
            this.canvas = null;
        }

        this.ctx = null;
        this._glowCanvas = null;
        this._staticCanvas = null;
        this._staticCtx = null;
        this.cycleViewBuf = null;
        this.pianoRectsBuf = null;
        this.scheduler = null;
        this.audioAnalyser = null;
        this.waveformData = null;
    }
}

/**
 * Scope visualizer for real-time audio analysis
 */
export class ScopeVisualizer {
    private readonly container: HTMLDivElement;

    private analyser: AnalyserNode | null;
    private dataArray: Uint8Array | null;

    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private animationId: number | null;

    private width: number;
    private height: number;
    private running: boolean;
    private lastFrameMs: number;
    private colorTrace: string;

    constructor(container: HTMLDivElement) {
        this.container = container;

        this.analyser = null;
        this.dataArray = null;

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block; width:100%; height:60px;';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', {alpha: true})!;

        pauseWhileHidden({
            pause: () => {
                if (this.animationId !== null) {
                    cancelAnimationFrame(this.animationId);
                    this.animationId = null;
                }
            },
            resume: () => {
                if (this.running && this.animationId === null) {
                    this.lastFrameMs = 0;
                    this.animationId = requestAnimationFrame(this.draw);
                }
            },
        });
        this.animationId = null;

        this.width = 0;
        this.height = 60;
        this.running = false;
        this.lastFrameMs = 0;
        this.colorTrace = '#f7ff5a';

        this.handleResize();
        window.addEventListener('resize', this._onResize);
    }

    private readonly _onResize = (): void => {
        this.handleResize();
    };

    private readonly draw = (now = 0): void => {
        if (!this.running || !this.analyser || !this.dataArray) return;

        if (now - this.lastFrameMs < 33) {
            this.animationId = requestAnimationFrame(this.draw);
            return;
        }
        this.lastFrameMs = now;

        this.analyser.getByteTimeDomainData(this.dataArray as Uint8Array<ArrayBuffer>);

        const {ctx, width, height, dataArray} = this;
        const len = dataArray.length;

        // Clear
        ctx.clearRect(0, 0, width, height);

        // Draw waveform
        ctx.strokeStyle = this.colorTrace;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        const stepX = (width / len) * 4;
        const halfHeight = height * 0.5;

        let v = dataArray[0] * INV_128;
        ctx.moveTo(0, v * halfHeight);

        let x = stepX;
        for (let i = 4; i < len; i += 4) {
            v = dataArray[i] * INV_128;
            ctx.lineTo(x | 0, (v * halfHeight) | 0);
            x += stepX;
        }

        ctx.stroke();

        this.animationId = requestAnimationFrame(this.draw);
    };

    setAnalyser(analyser: AnalyserNode): void {
        this.analyser = analyser;
        this.dataArray = new Uint8Array(analyser.frequencyBinCount);
    }

    handleResize(): void {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = 60 * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = rect.width;
        this.height = 60;
    }

    startAnimation(): void {
        if (this.running) return;
        this.running = true;
        this.lastFrameMs = 0;
        this.updateTheme();
        this.animationId = requestAnimationFrame(this.draw);
    }

    updateTheme(): void {
        const style = getComputedStyle(document.documentElement);
        this.colorTrace = style.getPropertyValue('--viz-active').trim() || '#f7ff5a';
    }

    pauseAnimation(): void {
        this.running = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    stopAnimation(): void {
        this.running = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        const {ctx, width, height} = this;
        ctx.clearRect(0, 0, width, height);
    }

    dispose(): void {
        this.stopAnimation();
        window.removeEventListener('resize', this._onResize);
        this.canvas.remove();

        this.analyser = null;
        this.dataArray = null;
    }
}
