/**
 * Ambient visualizer mode API.
 *
 * A mode is a self-contained object created fresh every time the user enters
 * it — all per-mode state lives on the instance, so switching modes can never
 * leak stale state (there is no shared reset list to keep in sync). The host
 * (`FullscreenVisualizer`) owns the canvas, the rAF loop, FFT feature
 * extraction, theming, and the scanline/vignette chrome; modes get everything
 * they need through the read-only {@link VizServices} snapshot passed to each
 * lifecycle call.
 *
 * Adding a mode:
 *   1. Create `viz/modes/<id>.ts` exporting a `VizModeDef`.
 *   2. Add it to the ordered list in `viz/registry.ts`.
 * That's the whole surface — the menu, HUD, keyboard cycling, auto-cycle, and
 * persistence all derive from the registry.
 */

import type {PatternHandle} from '../../pkg';

/**
 * Read access to the scheduled-pattern data for modes that visualize musical
 * structure (ISO CITY, LENS BENCH, SPOT FIELD) rather than just the audio
 * signal. The `PatternHandle` must never be retained across frames — it's
 * freed on stop/re-evaluate, so read it fresh from the scheduler inside each
 * synchronous use.
 */
export interface PatternSource {
    scheduler: { pattern: PatternHandle | null };
    memory: WebAssembly.Memory;
    cycleViewPtr: number;
}

/** App palette snapshot, re-read from CSS variables on visualizer start. */
export interface Theme {
    bg: string;
    neon: string;          // primary cyan
    neonSecondary: string; // magenta
    active: string;        // yellow accent
    violet: string;
    red: string;
    /** Hue components parsed once, for cheap hsla() construction in hot paths. */
    neonHue: number;
    secondaryHue: number;
    activeHue: number;
    /** RGB triples for canvas color mixing (port of CSS color-mix). */
    bgRgb: [number, number, number];
    bgLightRgb: [number, number, number];
    bgLighterRgb: [number, number, number];
    borderRgb: [number, number, number];
    /** --text-secondary — labels and readout text in the drafting modes. */
    textRgb: [number, number, number];
    /** Accent rotation for pattern tracks without a `.color()` hint — same
     *  order as the sidebar visualizer's eventColors. */
    accentPool: Array<[number, number, number]>;
}

/** Per-frame snapshot of everything the host provides to the active mode. */
export interface VizServices {
    /** Canvas size in CSS pixels. */
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
    readonly theme: Theme;
    /** Latency-compensated fractional cycle position (1 cycle = 1 bar). */
    readonly cycle: number;
    /** Normalized FFT band energies, already scaled by sensitivity. */
    readonly low: number;
    readonly mid: number;
    readonly high: number;
    /** Raw analyser data for per-bin work; null before audio init. */
    readonly freqData: Uint8Array | null;
    readonly timeData: Uint8Array | null;
    readonly sensitivity: number;
    readonly patternSource: PatternSource | null;
}

export interface VizMode {
    /**
     * Recompute layout from services. Called once on mode entry and again on
     * every resize — must be idempotent and must not reset simulation state
     * (a resize mid-performance should not visibly restart the mode).
     */
    layout(s: VizServices): void;
    update(dt: number, s: VizServices): void;
    render(ctx: CanvasRenderingContext2D, s: VizServices): void;
}

/**
 * An overlay composited on top of the active mode, into the *same* canvas,
 * after the host's vignette. Identical lifecycle contract to {@link VizMode}.
 *
 * Stage Mode's code and readout are layers rather than DOM because the stage
 * is meant to be captured: a DOM overlay would appear on screen but be absent
 * from anything reading the canvas, so preview and capture would disagree.
 */
export type VizLayer = VizMode;

export interface VizModeDef {
    /** Stable id — persistence key; never reuse or rename casually. */
    id: string;
    /** HUD / menu label, uppercase by convention. */
    name: string;
    /**
     * Optional trail background: instead of an opaque clear, the host paints
     * the theme background at this alpha so strokes smear across frames.
     */
    trailFade?: number;
    create(): VizMode;
}
