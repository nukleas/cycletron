/**
 * Fullscreen Immersive Visualizations for Cycletron — the host.
 *
 * Owns the canvas, the rAF loop, resize/DPR handling, FFT feature extraction,
 * theming, and the scanline/vignette chrome. The actual visuals are
 * self-contained modes registered in `viz/registry.ts`; a fresh mode instance
 * is created on every entry, so per-mode state can never leak across
 * switches. See `viz/types.ts` for the mode API and how to add one.
 *
 * Design notes:
 * - Motion is driven by the scheduler's cycle position (via `updateCycle`) so
 *   the viz visibly locks to musical time. FFT only modulates intensity, not
 *   timing.
 * - Palette is pulled from the app's CSS variables so it tracks theme changes.
 * - Canvas 2D only — no extra runtime deps.
 */

import {pauseWhileHidden} from './viz-visibility.js';
import {VIZ_MODES} from './viz/registry.js';
import {defaultTheme, readTheme} from './viz/theme.js';
import type {PatternSource, VizLayer, VizMode, VizServices} from './viz/types.js';

type MutableServices = { -readonly [K in keyof VizServices]: VizServices[K] };

/** A locked output size for Stage Mode. See {@link FullscreenVisualizer.setFixedResolution}. */
export interface FixedResolution {
    width: number;
    height: number;
}

export class FullscreenVisualizer {
    private container: HTMLDivElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;

    private analyser: AnalyserNode | null = null;

    private modeIndex = 0;
    private modeImpl: VizMode = VIZ_MODES[0].create();
    private sensitivity = 1.0;

    private readonly services: MutableServices = {
        width: 0,
        height: 0,
        dpr: 1,
        theme: defaultTheme(),
        cycle: 0,
        low: 0,
        mid: 0,
        high: 0,
        freqData: null,
        timeData: null,
        sensitivity: 1.0,
        patternSource: null,
    };

    private running = false;
    private animationId: number | null = null;
    private lastFrame = 0;
    private scanlineOffset = 0;

    /** Non-null in Stage Mode: bitmap is locked to this size and letterboxed. */
    private fixed: FixedResolution | null = null;
    private layers: readonly VizLayer[] = [];

    private resizeObserver: ResizeObserver | null = null;
    private resizeRaf: number | null = null;

    constructor(container: HTMLDivElement) {
        this.container = container;

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block; width:100%; height:100%;';
        this.container.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d', { alpha: false })!;

        // Observe the container directly so the canvas re-measures when side
        // panels collapse/expand — not just on window resize. Coalesce via rAF
        // so a drag-resize doesn't reallocate the bitmap on every notification.
        this.resizeObserver = new ResizeObserver(() => {
            if (this.resizeRaf !== null) return;
            this.resizeRaf = requestAnimationFrame(() => {
                this.resizeRaf = null;
                this.handleResize();
            });
        });
        this.resizeObserver.observe(this.container);

        pauseWhileHidden({
            pause: () => {
                if (this.animationId !== null) {
                    cancelAnimationFrame(this.animationId);
                    this.animationId = null;
                }
            },
            resume: () => {
                if (this.running && this.animationId === null) {
                    this.lastFrame = performance.now();
                    this.animationId = requestAnimationFrame(this.draw);
                }
            },
        });
        // NOTE: initial geometry seeding still happens in start() — the
        // container is `hidden` until then, so getBoundingClientRect() = 0×0.
    }

    setAnalyser(analyser: AnalyserNode): void {
        this.analyser = analyser;
        const binCount = analyser.frequencyBinCount;
        this.services.freqData = new Uint8Array(binCount);
        this.services.timeData = new Uint8Array(binCount);
    }

    /** Wire in pattern-data access for schedule-driven modes. */
    setPatternSource(source: PatternSource): void {
        this.services.patternSource = source;
    }

    /**
     * Move the canvas to a different container and re-measure.
     *
     * Stage Mode reparents the one existing instance rather than creating a
     * second: two instances would mean two rAF loops, two FFT reads per frame,
     * and a mode that visibly restarts every time you go on stage.
     */
    reparent(next: HTMLDivElement): void {
        if (next === this.container) return;
        // Unobserve first — observing both would thrash handleResize.
        this.resizeObserver?.unobserve(this.container);
        this.container = next;
        next.appendChild(this.canvas); // appendChild moves an attached node
        this.resizeObserver?.observe(next);
        if (this.running) this.handleResize();
    }

    /**
     * Lock the bitmap to a fixed output size, letterboxed inside the container
     * by CSS; `null` restores container-derived, DPR-scaled sizing.
     *
     * A locked size is what makes the stage recordable: `captureStream()` reads
     * the bitmap, so the output stays 1920×1080 no matter how the window is
     * resized. `dpr` is forced to 1 so modes author in output pixels.
     */
    setFixedResolution(size: FixedResolution | null): void {
        this.fixed = size;
        if (!size) this.canvas.style.cssText = 'display:block; width:100%; height:100%;';
        this.handleResize();
    }

    /** Overlays composited on top of the active mode, into the same canvas. */
    setLayers(layers: readonly VizLayer[]): void {
        this.layers = layers;
        if (this.services.width > 0) {
            for (const layer of layers) layer.layout(this.services);
        }
    }


    /** Called from the app's cycle-update callback so motion locks to musical time. */
    updateCycle(cycle: number): void {
        this.services.cycle = cycle;
    }

    getMode(): number {
        return this.modeIndex;
    }

    setMode(index: number): void {
        const next = ((index % VIZ_MODES.length) + VIZ_MODES.length) % VIZ_MODES.length;
        if (next === this.modeIndex) return;
        this.modeIndex = next;
        // Fresh instance per entry — all mode state starts clean, by design.
        this.modeImpl = VIZ_MODES[next].create();
        if (this.services.width > 0) this.modeImpl.layout(this.services);
    }

    /** Rotate forward (+1) or backward (-1) through available modes. */
    cycleMode(delta: number): number {
        this.setMode(this.modeIndex + delta);
        return this.modeIndex;
    }

    setSensitivity(value: number): void {
        this.sensitivity = Math.max(0.3, Math.min(2.5, value));
        this.services.sensitivity = this.sensitivity;
    }

    start(): void {
        if (this.running) return;
        this.services.theme = readTheme();
        // Container is now visible — safe to measure and seed geometry.
        this.handleResize();
        this.running = true;
        this.lastFrame = performance.now();
        this.animationId = requestAnimationFrame(this.draw);
    }

    stop(): void {
        this.running = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    handleResize = (): void => {
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        if (this.fixed) {
            const {width: fw, height: fh} = this.fixed;
            // Assigning canvas.width CLEARS the bitmap and renegotiates any live
            // captureStream() track, so only touch it when the value actually
            // changed — a window drag must move the letterbox, not the output.
            if (this.canvas.width !== fw) this.canvas.width = fw;
            if (this.canvas.height !== fh) this.canvas.height = fh;
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);

            this.services.width = fw;
            this.services.height = fh;
            // dpr 1: modes author stroke weights in output pixels. Only
            // matrix-rain and ascii-scope read dpr, both to size offscreen
            // layers, which become 1:1 here.
            this.services.dpr = 1;

            // Contain-fit; the container's flex centering supplies the bars.
            const scale = Math.min(rect.width / fw, rect.height / fh);
            this.canvas.style.cssText =
                `display:block; width:${fw * scale}px; height:${fh * scale}px;`;
        } else {
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = Math.floor(rect.width * dpr);
            this.canvas.height = Math.floor(rect.height * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            this.services.width = rect.width;
            this.services.height = rect.height;
            this.services.dpr = dpr;
        }

        this.modeImpl.layout(this.services);
        for (const layer of this.layers) layer.layout(this.services);
    };

    private readonly draw = (now: number): void => {
        if (!this.running) return;

        const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
        this.lastFrame = now;

        this.updateAudioFeatures();
        this.modeImpl.update(dt, this.services);
        for (const layer of this.layers) layer.update(dt, this.services);
        this.scanlineOffset = (this.scanlineOffset + dt * 18) % 4;
        this.render();

        this.animationId = requestAnimationFrame(this.draw);
    };

    private updateAudioFeatures(): void {
        const s = this.services;
        if (!this.analyser || !s.freqData || !s.timeData) return;

        // Cast is required by current TS DOM lib (ArrayBufferLike constraint).
        this.analyser.getByteFrequencyData(s.freqData as Uint8Array<ArrayBuffer>);
        this.analyser.getByteTimeDomainData(s.timeData as Uint8Array<ArrayBuffer>);

        const len = s.freqData.length;
        const lowEnd = Math.floor(len * 0.08);
        const midEnd = Math.floor(len * 0.35);

        let low = 0, mid = 0, high = 0;
        for (let i = 0; i < lowEnd; i++) low += s.freqData[i];
        for (let i = lowEnd; i < midEnd; i++) mid += s.freqData[i];
        for (let i = midEnd; i < len; i++) high += s.freqData[i];

        const inv255 = 1 / 255;
        s.low = (low / (lowEnd || 1)) * inv255 * this.sensitivity;
        s.mid = (mid / ((midEnd - lowEnd) || 1)) * inv255 * this.sensitivity;
        s.high = (high / ((len - midEnd) || 1)) * inv255 * this.sensitivity;
    }

    private render(): void {
        const {ctx} = this;
        const s = this.services;
        const w = s.width;
        const h = s.height;

        // Trail modes get a translucent clear so strokes smear across frames;
        // everyone else gets an opaque background.
        const fade = VIZ_MODES[this.modeIndex].trailFade;
        if (fade !== undefined) {
            const [br, bg, bb] = s.theme.bgRgb;
            ctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${fade})`;
        } else {
            ctx.fillStyle = s.theme.bg;
        }
        ctx.fillRect(0, 0, w, h);

        this.drawScanlines(ctx, w, h);
        this.modeImpl.render(ctx, s);
        this.drawVignette(ctx, w, h);
        // Layers last: the vignette is a frame around the *visuals*, and
        // dimming Stage Mode's code at the edges would hurt legibility.
        for (const layer of this.layers) layer.render(ctx, s);
    }

    private drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        ctx.strokeStyle = `hsla(${this.services.theme.neonHue}, 92%, 70%, 0.035)`;
        ctx.lineWidth = 1;

        const step = 3.6;
        let y = (this.scanlineOffset % step) - step;

        ctx.beginPath();
        while (y < h) {
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            y += step;
        }
        ctx.stroke();
    }

    private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const grad = ctx.createRadialGradient(
            w * 0.5, h * 0.5, Math.min(w, h) * 0.35,
            w * 0.5, h * 0.5, Math.max(w, h) * 0.72,
        );
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.65)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    destroy(): void {
        this.stop();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.resizeRaf !== null) {
            cancelAnimationFrame(this.resizeRaf);
            this.resizeRaf = null;
        }
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}
