/**
 * Fullscreen Immersive Visualizations for Cycletron
 *
 * Music-reactive canvas modes intended for large-screen / live-performance use.
 * Two flavors:
 *  - NeonCircuit: network of nodes + flowing traces. Node pulses lock to the
 *    pattern cycle; particles ride FFT energy.
 *  - MarbleCore: concentric rings rotating at integer multiples of the cycle
 *    ("clockwork" feel), with orbiting orbs and an FFT-driven core glow.
 *
 * Design notes:
 * - Motion is driven by the scheduler's cycle position (via `updateCycle`) so
 *   the viz visibly locks to musical time. FFT only modulates intensity, not
 *   timing.
 * - Palette is pulled from the app's CSS variables (--neon, --neon-secondary,
 *   --viz-hot, --viz-active) so it tracks any theme changes.
 * - Canvas 2D only — no extra runtime deps.
 */

import artRaw from './assets/art.txt?raw';
import {pauseWhileHidden} from './viz-visibility.js';

export enum FullscreenVizMode {
    NeonCircuit = 0,
    MarbleCore = 1,
    MarbleDrop = 2,
    FlameGraph = 3,
    Lissajous = 4,
    WaveTerrain = 5,
    Tunnel = 6,
    StrangeAttractor = 7,
    Plasma = 8,
    Kaleidoscope = 9,
    AsciiArt = 10,
    MatrixRain = 11,
}

export const MODE_COUNT = 12;
const TAU = Math.PI * 2;

/** Glyph pool for MatrixRain — katakana + digits + latin, drawn per cell. */
const RAIN_GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEFGHJKLMNPQRSTUVWXYZ$+*:;.<>=';

interface RainStream {
    /** Column index. */
    col: number;
    /** Head position in fractional rows. */
    y: number;
    /** Rows per second. */
    speed: number;
    /** Rows left to live — stream dies after this distance or off-screen. */
    remaining: number;
    /** 1 on downbeat-accented streams: brighter head, brighter body. */
    accent: number;
}

/**
 * Glyph ramp of the ASCII artwork, ascending ink coverage. Index = sprite
 * column in the atlas; density drives sprite hue (denser glyph = hotter).
 */
const ART_GLYPHS = ['.', ':', ';', '+', 'x', 'X', '$', '&'] as const;
const ART_DENSITY: Record<string, number> = {
    '.': 0.10,
    ':': 0.20,
    ';': 0.30,
    '+': 0.45,
    'x': 0.58,
    'X': 0.70,
    '$': 0.85,
    '&': 1.00,
};

interface ArtGrid {
    rows: number;
    cols: number;
    /** row-major glyph index into ART_GLYPHS, -1 for blank cells */
    glyph: Int16Array;
}

let cachedArtGrid: ArtGrid | null = null;

function getArtGrid(): ArtGrid {
    if (cachedArtGrid) return cachedArtGrid;

    const lines = artRaw.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    const rows = lines.length;
    let cols = 0;
    for (const line of lines) cols = Math.max(cols, line.length);

    const glyphIndex = new Map<string, number>(ART_GLYPHS.map((g, i) => [g, i]));
    const glyph = new Int16Array(rows * cols).fill(-1);
    for (let r = 0; r < rows; r++) {
        const line = lines[r];
        for (let c = 0; c < line.length; c++) {
            glyph[r * cols + c] = glyphIndex.get(line[c]) ?? -1;
        }
    }

    cachedArtGrid = {rows, cols, glyph};
    return cachedArtGrid;
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
    hue: number;
}

interface Marble {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    hue: number;
    /** Cooldown to avoid registering the same peg-collision frame-after-frame. */
    cooldown: number;
    /** Fades on exit so the marble doesn't pop out. */
    life: number;
}

interface Peg {
    x: number;
    y: number;
    radius: number;
    /** Recent-hit glow, fades each frame. */
    hit: number;
}

interface Theme {
    bg: string;
    neon: string;          // primary cyan
    neonSecondary: string; // magenta
    active: string;        // yellow accent
    violet: string;
    /** Hue components parsed once, for cheap hsla() construction in the hot path. */
    neonHue: number;
    secondaryHue: number;
    activeHue: number;
}

export class FullscreenVisualizer {
    static readonly MODE_COUNT = MODE_COUNT;

    private readonly container: HTMLDivElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;

    private analyser: AnalyserNode | null = null;
    private freqData: Uint8Array | null = null;
    private timeData: Uint8Array | null = null;

    private mode: FullscreenVizMode = FullscreenVizMode.NeonCircuit;
    private sensitivity = 1.0;

    private width = 0;
    private height = 0;
    private dpr = 1;

    private running = false;
    private animationId: number | null = null;
    private lastFrame = 0;
    private currentCycle = 0;

    private particles: Particle[] = [];
    private nodes: Array<{ x: number; y: number; offset: number }> = [];
    private rings: Array<{ radius: number; cyclesPerRev: number; phaseOffset: number; hue: number }> = [];
    private orbs: Array<{ baseAngle: number; cyclesPerRev: number; radius: number; size: number; hue: number }> = [];

    // MarbleDrop state
    private marbles: Marble[] = [];
    private pegs: Peg[] = [];
    private lastBeatIndex = -1;
    private highTransientCooldown = 0;
    private midTransientCooldown = 0;
    private lowTransientCooldown = 0;
    private prevHighEnergy = 0;
    private prevMidEnergy = 0;
    private prevLowEnergy = 0;

    // FlameGraph state — Winamp-style spectrum flame
    // Each "bar" is one slice of the flame silhouette across the width. We
    // sample raw FFT bins with log-frequency mapping (more resolution in the
    // bass) so the shape reflects the actual mix.
    private flameBars: Float32Array | null = null;   // smoothed heights 0..1
    private flamePeaks: Float32Array | null = null;  // peak-hold positions 0..1
    private readonly FLAME_BARS = 64;

    // Lissajous state — phase-shift offset cycles on each musical beat so the
    // curve folds into a new shape each beat. Hue rotates with the cycle.
    private lissaOffset = 32;
    private lissaLastBeatIndex = -1;

    // WaveTerrain state — ring buffer of FFT history rows for the perspective
    // landscape. Each row stores `TERRAIN_BARS` samples; head points to the
    // newest row, render walks back-to-front for proper z ordering.
    private terrainHistory: Float32Array | null = null;
    private terrainHead = 0;
    private terrainAccum = 0;
    private readonly TERRAIN_ROWS = 36;
    private readonly TERRAIN_BARS = 56;
    private readonly TERRAIN_ROW_DT = 1 / 24;  // 24 rows/sec

    // Tunnel state — rings recede along z; on each downbeat we boost zVel.
    private tunnelRings: Array<{ z: number; angle: number; hueShift: number }> = [];
    private tunnelZVel = 1.0;
    private tunnelLastDownbeat = -1;

    // StrangeAttractor state — Lorenz trail integrated each frame
    private attrX = 0.1;
    private attrY = 0;
    private attrZ = 0;
    private attrTrail: Float32Array | null = null;   // ring buffer of [x, y, z]
    private attrTrailHead = 0;
    private readonly ATTR_TRAIL_CAP = 720;

    // Plasma state — additively-blended metaballs
    private plasmaBalls: Array<{
        x: number; y: number; vx: number; vy: number;
        baseR: number; hue: number; phase: number;
    }> = [];

    // Kaleidoscope state — radial particles within one wedge, mirrored
    private kaleidoParticles: Array<{
        r: number; angle: number; vr: number; life: number; hue: number; size: number;
    }> = [];
    private readonly KALEIDO_SLICES = 8;

    // AsciiArt state — a Lissajous-style phosphor scope that etches the
    // artwork. The beam is the time-domain signal plotted against a delayed
    // copy of itself (delay re-picked each beat, same trick as the Lissajous
    // mode); wherever it passes it deposits that cell's glyph onto a
    // persistent etch layer that decays like CRT phosphor. The image only
    // exists where the music has recently drawn. `artAtlas` holds one
    // cell-sized sprite per glyph so splatting is drawImage, not fillText.
    // Etch layer + atlas live in device pixels (no transform).
    private artEtch: HTMLCanvasElement | null = null;
    private artEtchCtx: CanvasRenderingContext2D | null = null;
    private artAtlas: HTMLCanvasElement | null = null;
    private artSpriteW = 0;
    private artSpriteH = 0;
    private artBox = {x: 0, y: 0, w: 0, h: 0};
    private artCellW = 0;
    private artCellH = 0;
    private artOffset = 48;
    private artLastBeatIndex = -1;
    /**
     * Auto-gain peak tracker (byte deviation units, 8..128). Rises instantly
     * to the loudest sample, falls slowly — normalizes the beam so quiet
     * passages still sweep the whole portrait instead of a center blob.
     */
    private artPeak = 20;
    /** Seconds of continuous silence — drives the fade-out-then-clear. */
    private artSilence = 0;
    /** False while the signal is below the beam gate; render skips the trace. */
    private artBeamOn = false;

    // MatrixRain state — green glyph streams on a persistent phosphor layer
    // (destination-out fade gives the trails). Spawn timing borrows the
    // MarbleDrop drum-lane idea: kicks burst streams in the left third of the
    // columns, snares center, hats right, plus an eighth-note baseline while
    // audio is active. Layer lives in device pixels.
    private rainCanvas: HTMLCanvasElement | null = null;
    private rainCtx: CanvasRenderingContext2D | null = null;
    private rainStreams: RainStream[] = [];
    private rainCellW = 0;
    private rainCellH = 0;
    private rainCols = 0;
    private rainRows = 0;
    private rainSilence = 0;
    /** theme.bg as rgb components — the trail-fade fill and silence fill. */
    private rainBg: [number, number, number] = [5, 6, 10];

    private scanlineOffset = 0;

    private theme: Theme = {
        bg: '#05060a',
        neon: '#47f6ff',
        neonSecondary: '#ff2bd6',
        active: '#f7ff5a',
        violet: '#9d7cff',
        neonHue: 185,
        secondaryHue: 315,
        activeHue: 55,
    };

    private lowEnergy = 0;
    private midEnergy = 0;
    private highEnergy = 0;

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
        this.freqData = new Uint8Array(binCount);
        this.timeData = new Uint8Array(binCount);
    }

    /** Called from the app's cycle-update callback so motion locks to musical time. */
    updateCycle(cycle: number): void {
        this.currentCycle = cycle;
    }

    getMode(): FullscreenVizMode {
        return this.mode;
    }

    setMode(mode: FullscreenVizMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.resetModeState();
        this.initModeGeometry();
    }

    /** Rotate forward (+1) or backward (-1) through available modes. */
    cycleMode(delta: number): FullscreenVizMode {
        const next = (((this.mode + delta) % MODE_COUNT) + MODE_COUNT) % MODE_COUNT;
        this.setMode(next as FullscreenVizMode);
        return this.mode;
    }

    setSensitivity(value: number): void {
        this.sensitivity = Math.max(0.3, Math.min(2.5, value));
    }

    private resetModeState(): void {
        this.particles.length = 0;
        this.nodes.length = 0;
        this.rings.length = 0;
        this.orbs.length = 0;
        this.marbles.length = 0;
        this.pegs.length = 0;
        this.lastBeatIndex = -1;
        this.highTransientCooldown = 0;
        this.midTransientCooldown = 0;
        this.lowTransientCooldown = 0;
        this.prevHighEnergy = 0;
        this.prevMidEnergy = 0;
        this.prevLowEnergy = 0;
        this.flameBars = null;
        this.flamePeaks = null;
        this.lissaOffset = 32;
        this.lissaLastBeatIndex = -1;
        this.terrainHistory = null;
        this.terrainHead = 0;
        this.terrainAccum = 0;
        this.tunnelRings.length = 0;
        this.tunnelZVel = 1.0;
        this.tunnelLastDownbeat = -1;
        this.attrX = 0.1;
        this.attrY = 0;
        this.attrZ = 0;
        this.attrTrail = null;
        this.attrTrailHead = 0;
        this.plasmaBalls.length = 0;
        this.kaleidoParticles.length = 0;
        this.artEtch = null;
        this.artEtchCtx = null;
        this.artAtlas = null;
        this.artOffset = 48;
        this.artLastBeatIndex = -1;
        this.artPeak = 20;
        this.artSilence = 0;
        this.artBeamOn = false;
        this.rainCanvas = null;
        this.rainCtx = null;
        this.rainStreams.length = 0;
        this.rainSilence = 0;
        this.scanlineOffset = 0;
    }

    private refreshTheme(): void {
        const style = getComputedStyle(document.documentElement);
        const css = (name: string, fallback: string): string =>
            style.getPropertyValue(name).trim() || fallback;

        this.theme = {
            bg: css('--bg', '#05060a'),
            neon: css('--neon', '#47f6ff'),
            neonSecondary: css('--neon-secondary', '#ff2bd6'),
            active: css('--viz-active', '#f7ff5a'),
            violet: css('--violet', '#9d7cff'),
            neonHue: hueOf(css('--neon', '#47f6ff'), 185),
            secondaryHue: hueOf(css('--neon-secondary', '#ff2bd6'), 315),
            activeHue: hueOf(css('--viz-active', '#f7ff5a'), 55),
        };
    }

    handleResize = (): void => {
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        this.dpr = window.devicePixelRatio || 1;

        this.canvas.width = Math.floor(rect.width * this.dpr);
        this.canvas.height = Math.floor(rect.height * this.dpr);

        this.width = rect.width;
        this.height = rect.height;

        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

        this.initModeGeometry();
    };

    private initModeGeometry(): void {
        if (this.width === 0 || this.height === 0) return;

        const cx = this.width / 2;
        const cy = this.height / 2;

        if (this.mode === FullscreenVizMode.NeonCircuit) {
            this.nodes.length = 0;
            const count = Math.min(32, Math.max(12, Math.floor(Math.max(this.width, this.height) / 36)));
            for (let i = 0; i < count; i++) {
                const angle = (i / count) * TAU;
                const r = Math.min(this.width, this.height) * (0.22 + (i % 5) * 0.035);
                this.nodes.push({
                    x: cx + Math.cos(angle) * r,
                    y: cy + Math.sin(angle) * r * 0.72,
                    offset: (i / count) * TAU * 0.5,
                });
            }
        } else {
            this.rings.length = 0;
            this.orbs.length = 0;

            // Integer-ratio rotation rates → "clockwork" feel
            const ringSpec: Array<{ radius: number; cyclesPerRev: number; hueShift: number }> = [
                { radius: 80,  cyclesPerRev: 4, hueShift: 0   },
                { radius: 132, cyclesPerRev: 2, hueShift: 28  },
                { radius: 184, cyclesPerRev: 1, hueShift: 58  },
                { radius: 236, cyclesPerRev: 0.5, hueShift: 92 },
                { radius: 288, cyclesPerRev: 0.25, hueShift: 130 },
            ];
            for (let i = 0; i < ringSpec.length; i++) {
                const s = ringSpec[i];
                this.rings.push({
                    radius: s.radius,
                    cyclesPerRev: s.cyclesPerRev,
                    phaseOffset: i * 0.4,
                    hue: this.theme.neonHue + s.hueShift,
                });
            }

            const orbSpecs = [1, 2, 3, 4, 6, 8];
            for (let i = 0; i < orbSpecs.length; i++) {
                this.orbs.push({
                    baseAngle: (i / orbSpecs.length) * TAU,
                    cyclesPerRev: orbSpecs[i],
                    radius: 100 + (i % 3) * 44,
                    size: 4.5 + (i % 3),
                    hue: this.theme.neonHue + (i % 5) * 18,
                });
            }
        }

        if (this.mode === FullscreenVizMode.MarbleDrop) {
            this.initPegField();
        }

        if (this.mode === FullscreenVizMode.FlameGraph) {
            this.initFlameBars();
        }

        if (this.mode === FullscreenVizMode.WaveTerrain) {
            this.initTerrain();
        }

        if (this.mode === FullscreenVizMode.Tunnel) {
            this.initTunnel();
        }

        if (this.mode === FullscreenVizMode.StrangeAttractor) {
            this.initAttractor();
        }

        if (this.mode === FullscreenVizMode.Plasma) {
            this.initPlasma();
        }

        if (this.mode === FullscreenVizMode.AsciiArt) {
            this.initAsciiArt();
        }

        if (this.mode === FullscreenVizMode.MatrixRain) {
            this.initMatrixRain();
        }
    }

    /**
     * Size the rain grid to the canvas and allocate the persistent trail
     * layer. Cell size scales with the canvas so an editor-sized viz gets a
     * readable grid and a fullscreen one doesn't look blown up.
     */
    private initMatrixRain(): void {
        if (this.width === 0 || this.height === 0) return;

        const cellH = Math.max(14, Math.min(22, this.height / 42));
        const cellW = cellH * 0.62;
        this.rainCellW = cellW;
        this.rainCellH = cellH;
        this.rainCols = Math.max(4, Math.floor(this.width / cellW));
        this.rainRows = Math.max(4, Math.ceil(this.height / cellH));
        this.rainStreams.length = 0;

        const layer = document.createElement('canvas');
        layer.width = Math.max(1, Math.ceil(this.width * this.dpr));
        layer.height = Math.max(1, Math.ceil(this.height * this.dpr));
        this.rainCanvas = layer;
        const ctx = layer.getContext('2d', {alpha: false})!;
        // Device-pixel space; font state persists across frames.
        ctx.font = `${(cellH * 0.9 * this.dpr).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this.rainCtx = ctx;

        // Opaque layer faded by painting translucent bg over it each frame:
        // trails converge to exactly the background color, so nothing ever
        // lingers as a ghost (destination-out on an alpha layer stalls at low
        // alpha and slowly builds a gray curtain).
        this.rainBg = rgbOf(this.theme.bg, [5, 6, 10]);
        ctx.fillStyle = `rgb(${this.rainBg[0]}, ${this.rainBg[1]}, ${this.rainBg[2]})`;
        ctx.fillRect(0, 0, layer.width, layer.height);
    }

    /**
     * Fit the ASCII grid to the canvas (contain, centered), bake the glyph
     * sprite atlas, and allocate the persistent phosphor layer. Rebuilt on
     * resize and on mode entry (which clears any existing etch — the music
     * redraws it within a couple of bars).
     */
    private initAsciiArt(): void {
        if (this.width === 0 || this.height === 0) return;
        const grid = getArtGrid();
        if (grid.rows === 0 || grid.cols === 0) return;

        // Monospace cell aspect (advance width / line height) as the art
        // would read in an editor — keeps the image proportions intact.
        const CHAR_ASPECT = 0.52;
        // Overscan past the contain fit so the portrait dominates the screen;
        // centered, so the overflow crops equally on opposite edges. Capped
        // at cover-fit — no point growing past filling the whole canvas.
        const GROW = 1.6;
        const containCellH = Math.min(this.height / grid.rows, this.width / (grid.cols * CHAR_ASPECT));
        const coverCellH = Math.max(this.height / grid.rows, this.width / (grid.cols * CHAR_ASPECT));
        const cellH = Math.min(containCellH * GROW, coverCellH);
        const cellW = cellH * CHAR_ASPECT;
        const boxW = cellW * grid.cols;
        const boxH = cellH * grid.rows;
        this.artBox = {
            x: (this.width - boxW) / 2,
            y: (this.height - boxH) / 2,
            w: boxW,
            h: boxH,
        };
        this.artCellW = cellW;
        this.artCellH = cellH;

        // Sprite atlas: one cell at full phosphor brightness per glyph, hue
        // drifting toward secondary with ink density so the portrait's
        // structure reads in two-tone neon as it gets etched.
        const sw = Math.max(1, Math.ceil(cellW * this.dpr));
        const sh = Math.max(1, Math.ceil(cellH * this.dpr));
        this.artSpriteW = sw;
        this.artSpriteH = sh;
        const atlas = document.createElement('canvas');
        atlas.width = sw * ART_GLYPHS.length;
        atlas.height = sh;
        const actx = atlas.getContext('2d')!;
        actx.font = `${(cellH * 0.92 * this.dpr).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
        actx.textAlign = 'center';
        actx.textBaseline = 'middle';
        for (let i = 0; i < ART_GLYPHS.length; i++) {
            const d = ART_DENSITY[ART_GLYPHS[i]];
            const hue = this.theme.neonHue + (this.theme.secondaryHue - this.theme.neonHue) * d * 0.7;
            actx.fillStyle = `hsl(${hue}, 80%, ${50 + d * 24}%)`;
            actx.fillText(ART_GLYPHS[i], (i + 0.5) * sw, sh * 0.52);
        }
        this.artAtlas = atlas;

        const etch = document.createElement('canvas');
        etch.width = Math.max(1, Math.ceil(boxW * this.dpr));
        etch.height = Math.max(1, Math.ceil(boxH * this.dpr));
        this.artEtch = etch;
        this.artEtchCtx = etch.getContext('2d')!;
    }

    private initAttractor(): void {
        this.attrX = 0.1;
        this.attrY = 0;
        this.attrZ = 0;
        // Trail is [x, y, z] triples.
        this.attrTrail = new Float32Array(this.ATTR_TRAIL_CAP * 3);
        this.attrTrailHead = 0;
    }

    private initPlasma(): void {
        this.plasmaBalls.length = 0;
        const COUNT = 7;
        const hues = [
            this.theme.neonHue,
            this.theme.secondaryHue,
            this.theme.activeHue,
            this.theme.neonHue + 40,
            this.theme.secondaryHue - 30,
            this.theme.activeHue - 20,
            260, // violet
        ];
        for (let i = 0; i < COUNT; i++) {
            const angle = (i / COUNT) * TAU;
            const speed = 24 + Math.random() * 18;
            this.plasmaBalls.push({
                x: this.width * 0.5 + Math.cos(angle) * this.width * 0.18,
                y: this.height * 0.5 + Math.sin(angle) * this.height * 0.18,
                vx: Math.cos(angle + 1.5) * speed,
                vy: Math.sin(angle + 1.5) * speed,
                baseR: 60 + Math.random() * 30,
                hue: hues[i],
                phase: Math.random() * TAU,
            });
        }
    }

    private initTerrain(): void {
        this.terrainHistory = new Float32Array(this.TERRAIN_ROWS * this.TERRAIN_BARS);
        this.terrainHead = 0;
        this.terrainAccum = 0;
    }

    private initTunnel(): void {
        this.tunnelRings.length = 0;
        const COUNT = 18;
        for (let i = 0; i < COUNT; i++) {
            this.tunnelRings.push({
                z: (i + 1) / COUNT,        // 0 = at camera, 1 = vanishing point
                angle: (i / COUNT) * TAU,  // staggered rotation phase
                hueShift: (i % 4) * 22,
            });
        }
        this.tunnelZVel = 1.0;
        this.tunnelLastDownbeat = -1;
    }

    private initFlameBars(): void {
        this.flameBars  = new Float32Array(this.FLAME_BARS);
        this.flamePeaks = new Float32Array(this.FLAME_BARS);
    }

    /**
     * Lay out a Galton-board / pachinko peg field: staggered rows of pegs
     * across the canvas. Marbles spawn at the top, fall under gravity, bounce
     * off pegs left/right, and exit the bottom.
     */
    private initPegField(): void {
        this.pegs.length = 0;
        if (this.width === 0 || this.height === 0) return;

        const w = this.width;
        const h = this.height;

        // Reserve a top spawn strip and a bottom exit strip
        const topMargin = 60;
        const bottomMargin = 40;
        const fieldH = h - topMargin - bottomMargin;
        if (fieldH < 80) return;

        // Row spacing scales with canvas — fewer rows on a small editor
        const rowSpacing = Math.max(34, Math.min(56, h / 12));
        const rows = Math.max(4, Math.floor(fieldH / rowSpacing));
        const colSpacing = Math.max(48, Math.min(72, w / 14));
        const cols = Math.max(5, Math.floor(w / colSpacing));
        const pegRadius = 3;

        for (let r = 0; r < rows; r++) {
            const y = topMargin + (r + 0.5) * (fieldH / rows);
            const offset = (r % 2) * (colSpacing * 0.5);
            for (let c = 0; c < cols; c++) {
                const x = offset + (c + 0.5) * colSpacing;
                if (x < 12 || x > w - 12) continue;
                this.pegs.push({ x, y, radius: pegRadius, hit: 0 });
            }
        }
    }

    start(): void {
        if (this.running) return;
        this.refreshTheme();
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

    private readonly draw = (now: number): void => {
        if (!this.running) return;

        const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
        this.lastFrame = now;

        this.updateAudioFeatures();
        this.updateSimulation(dt);
        this.render();

        this.animationId = requestAnimationFrame(this.draw);
    };

    private updateAudioFeatures(): void {
        if (!this.analyser || !this.freqData || !this.timeData) return;

        // Cast is required by current TS DOM lib (ArrayBufferLike constraint).
        this.analyser.getByteFrequencyData(this.freqData as Uint8Array<ArrayBuffer>);
        this.analyser.getByteTimeDomainData(this.timeData as Uint8Array<ArrayBuffer>);

        const len = this.freqData.length;
        const lowEnd = Math.floor(len * 0.08);
        const midEnd = Math.floor(len * 0.35);

        let low = 0, mid = 0, high = 0;
        for (let i = 0; i < lowEnd; i++) low += this.freqData[i];
        for (let i = lowEnd; i < midEnd; i++) mid += this.freqData[i];
        for (let i = midEnd; i < len; i++) high += this.freqData[i];

        const inv255 = 1 / 255;
        this.lowEnergy  = (low  / (lowEnd || 1)) * inv255 * this.sensitivity;
        this.midEnergy  = (mid  / ((midEnd - lowEnd) || 1)) * inv255 * this.sensitivity;
        this.highEnergy = (high / ((len - midEnd) || 1)) * inv255 * this.sensitivity;
    }

    private updateSimulation(dt: number): void {
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const high = this.highEnergy;
        const energy = (low * 0.6 + mid * 0.9 + high * 0.7) * 0.6;

        switch (this.mode) {
            case FullscreenVizMode.NeonCircuit:
                this.updateNeonCircuit(dt, low, mid, high, energy);
                break;
            case FullscreenVizMode.MarbleCore:
                this.updateMarbleCore(dt, low, energy);
                break;
            case FullscreenVizMode.MarbleDrop:
                this.updateMarbleDrop(dt, low, high);
                break;
            case FullscreenVizMode.FlameGraph:
                this.updateFlameGraph(dt, low, mid, high);
                break;
            case FullscreenVizMode.Lissajous:
                this.updateLissajous(dt);
                break;
            case FullscreenVizMode.WaveTerrain:
                this.updateWaveTerrain(dt);
                break;
            case FullscreenVizMode.Tunnel:
                this.updateTunnel(dt, low, energy);
                break;
            case FullscreenVizMode.StrangeAttractor:
                this.updateAttractor(dt, low, mid, high);
                break;
            case FullscreenVizMode.Plasma:
                this.updatePlasma(dt, low, energy);
                break;
            case FullscreenVizMode.Kaleidoscope:
                this.updateKaleidoscope(dt, low, mid, high);
                break;
            case FullscreenVizMode.AsciiArt:
                this.updateAsciiArt(dt);
                break;
            case FullscreenVizMode.MatrixRain:
                this.updateMatrixRain(dt, low, mid, high);
                break;
        }

        this.scanlineOffset = (this.scanlineOffset + dt * 18) % 4;
    }

    /**
     * Lorenz attractor integrated forward in time. FFT bands modulate the
     * three parameters so the "shape" of the chaos breathes with the music:
     *   sigma (10)  — bass mildly raises it (compresses spiral)
     *   rho   (28)  — high band pushes butterfly wider
     *   beta  (8/3) — mid keeps it stable
     * Trail is a ring buffer of recent points; rendered as a fading polyline.
     */
    private updateAttractor(dt: number, low: number, mid: number, high: number): void {
        if (!this.attrTrail) this.initAttractor();
        if (!this.attrTrail) return;

        const sigma = 10 + low * 4;
        const rho   = 28 + high * 18;
        const beta  = 8 / 3 + mid * 0.6;

        // Sub-step the integration so trail is smooth even at low frame rate.
        const subSteps = 6;
        const h = Math.min(dt, 1 / 30) / subSteps;
        for (let s = 0; s < subSteps; s++) {
            const dx = sigma * (this.attrY - this.attrX);
            const dy = this.attrX * (rho - this.attrZ) - this.attrY;
            const dz = this.attrX * this.attrY - beta * this.attrZ;
            this.attrX += dx * h;
            this.attrY += dy * h;
            this.attrZ += dz * h;
            const head = this.attrTrailHead;
            this.attrTrail[head * 3 + 0] = this.attrX;
            this.attrTrail[head * 3 + 1] = this.attrY;
            this.attrTrail[head * 3 + 2] = this.attrZ;
            this.attrTrailHead = (head + 1) % this.ATTR_TRAIL_CAP;
        }
    }

    /**
     * Plasma metaballs — each ball drifts and bounces off the canvas edges.
     * Bass + energy pulse each ball's radius; phase oscillates for slow breath.
     */
    private updatePlasma(dt: number, low: number, energy: number): void {
        if (this.plasmaBalls.length === 0) this.initPlasma();

        for (const b of this.plasmaBalls) {
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.phase += dt * (0.4 + energy * 0.5);

            // Wall bounce with a slight velocity reset so balls don't get
            // trapped along an edge.
            if (b.x < b.baseR * 0.5) {
                b.x = b.baseR * 0.5;
                b.vx = Math.abs(b.vx);
            } else if (b.x > this.width - b.baseR * 0.5) {
                b.x = this.width - b.baseR * 0.5;
                b.vx = -Math.abs(b.vx);
            }
            if (b.y < b.baseR * 0.5) {
                b.y = b.baseR * 0.5;
                b.vy = Math.abs(b.vy);
            } else if (b.y > this.height - b.baseR * 0.5) {
                b.y = this.height - b.baseR * 0.5;
                b.vy = -Math.abs(b.vy);
            }
        }

        // Single shared bass pulse — radii scale with low energy.
        // Stored on each ball lazily via phase; updateBassPulse not needed.
        // Kept here as a cheap "global" so render can read it.
        this.plasmaBassPulse = low;
    }

    /**
     * Kaleidoscope — spawn particles inside one angular wedge (1/8 of the
     * circle), let them drift outward, then render the wedge 8 times mirrored
     * around the center. FFT energy controls spawn rate.
     */
    private updateKaleidoscope(dt: number, low: number, mid: number, high: number): void {
        const energy = (low + mid + high) / 3;
        const wedge = TAU / this.KALEIDO_SLICES;
        const maxR = Math.min(this.width, this.height) * 0.55;

        // Spawn rate tracks total energy + a constant base so it's never empty
        const spawnRate = (1.2 + energy * 6) * dt;
        if (Math.random() < spawnRate) {
            this.kaleidoParticles.push({
                r: 12 + Math.random() * 24,
                angle: Math.random() * wedge,
                vr: 60 + Math.random() * 90 + low * 80,
                life: 1.0 + Math.random() * 0.4,
                hue: this.theme.neonHue + (Math.random() - 0.5) * 80,
                size: 1.8 + Math.random() * 1.6 + high * 1.5,
            });
        }

        // Drift outward, fade
        for (let i = this.kaleidoParticles.length - 1; i >= 0; i--) {
            const p = this.kaleidoParticles[i];
            p.r += p.vr * dt;
            p.life -= dt * 0.85;
            if (p.life <= 0 || p.r > maxR) {
                this.kaleidoParticles.splice(i, 1);
            }
        }

        // Cap particle count
        if (this.kaleidoParticles.length > 280) {
            this.kaleidoParticles.splice(0, this.kaleidoParticles.length - 280);
        }
    }

    private plasmaBassPulse = 0;

    /**
     * ASCII scope beam. Phosphor decay (destination-out fade), then splat the
     * Lissajous curve — (signal[i], signal[i+offset]) mapped onto the art
     * grid — depositing each hit cell's glyph sprite at full brightness.
     * Beats re-pick the delay offset so the curve folds into a new shape and
     * etches a different region of the portrait; beat energy brightens the
     * deposit. A silent signal collapses to a center point, so the beam gates
     * on RMS to avoid burning a blob into the middle.
     */
    private updateAsciiArt(dt: number): void {
        if (!this.artEtchCtx) this.initAsciiArt();
        const ectx = this.artEtchCtx;
        if (!ectx || !this.artEtch || !this.artAtlas) return;

        // Beam gate + auto-gain input — strided RMS and peak of the deviation
        // from center (128).
        let rms = 0;
        let maxDev = 0;
        if (this.timeData) {
            const td = this.timeData;
            let sumSq = 0;
            let count = 0;
            for (let i = 0; i < td.length; i += 16) {
                const d = Math.abs(td[i] - 128);
                sumSq += d * d;
                count++;
                if (d > maxDev) maxDev = d;
            }
            rms = Math.sqrt(sumSq / count);
        }
        // Peak falls slowly so the scale doesn't pump; floor keeps a whisper
        // of signal from being amplified into a full-screen scribble.
        this.artPeak = Math.min(128, Math.max(8, maxDev, this.artPeak - dt * 30));
        this.artBeamOn = rms >= 2.5;

        if (!this.artBeamOn) {
            // Silence: fade out fast, then hard-clear — destination-out
            // quantizes at low alpha and would otherwise leave a permanent
            // ghost hanging behind the editor.
            this.artSilence += dt;
            if (this.artSilence > 1.5) {
                ectx.clearRect(0, 0, this.artEtch.width, this.artEtch.height);
                return;
            }
            const fadeOut = 1 - Math.exp(-dt * 4);
            ectx.globalCompositeOperation = 'destination-out';
            ectx.fillStyle = `rgba(0, 0, 0, ${fadeOut.toFixed(4)})`;
            ectx.fillRect(0, 0, this.artEtch.width, this.artEtch.height);
            ectx.globalCompositeOperation = 'source-over';
            return;
        }
        this.artSilence = 0;

        // Phosphor decay — exponential, frame-rate independent.
        const fade = 1 - Math.exp(-dt * 1.5);
        ectx.globalCompositeOperation = 'destination-out';
        ectx.fillStyle = `rgba(0, 0, 0, ${fade.toFixed(4)})`;
        ectx.fillRect(0, 0, this.artEtch.width, this.artEtch.height);
        ectx.globalCompositeOperation = 'source-over';

        // Beat-switched delay offset — same topology trick as the Lissajous
        // scope: each beat the curve folds into a new figure.
        const beatIndex = Math.floor(this.currentCycle * 4);
        if (beatIndex !== this.artLastBeatIndex) {
            this.artLastBeatIndex = beatIndex;
            const choices = [24, 48, 64, 96, 128, 160];
            this.artOffset = choices[((beatIndex % choices.length) + choices.length) % choices.length];
        }

        const data = this.timeData!;
        const N = data.length;
        const off = this.artOffset;
        if (N < off + 8) return;

        const grid = getArtGrid();
        const beat = beatEnv(this.currentCycle * 4);
        const sw = this.artSpriteW;
        const sh = this.artSpriteH;
        const cellWDev = this.artCellW * this.dpr;
        const cellHDev = this.artCellH * this.dpr;
        const usable = N - off;
        const step = Math.max(1, Math.floor(usable / 600));
        const amp = 0.49;
        const norm = 1 / this.artPeak;

        // Kept well under 1.0 so the etch reads as a glow behind the editor
        // rather than competing with the code for attention.
        ectx.globalAlpha = 0.30 + beat * 0.25;
        let lastCell = -1;
        for (let i = 0; i < usable; i += step) {
            const x = Math.max(-1, Math.min(1, (data[i] - 128) * norm));
            const y = Math.max(-1, Math.min(1, (data[i + off] - 128) * norm));
            const c = Math.floor((0.5 + x * amp) * grid.cols);
            const r = Math.floor((0.5 + y * amp) * grid.rows);
            if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
            const cell = r * grid.cols + c;
            if (cell === lastCell) continue;
            lastCell = cell;
            const g = grid.glyph[cell];
            if (g < 0) continue;
            ectx.drawImage(this.artAtlas, g * sw, 0, sw, sh,
                Math.round(c * cellWDev), Math.round(r * cellHDev), sw, sh);
        }
        ectx.globalAlpha = 1;
    }

    /**
     * Matrix rain, drum-machine style. Streams fall at rows/sec and stamp a
     * random glyph into each cell they cross; the layer's destination-out
     * fade turns those stamps into the classic dissolving tail. Spawning is
     * musical: an eighth-note baseline in the middle columns (downbeats
     * accented and burstier), plus MarbleDrop's per-band transient lanes —
     * kick bursts left, snare center, hats right. Silence fades the layer
     * out fast and hard-clears it so nothing lingers behind the editor.
     */
    private updateMatrixRain(dt: number, low: number, mid: number, high: number): void {
        if (!this.rainCtx) this.initMatrixRain();
        const rctx = this.rainCtx;
        if (!rctx || !this.rainCanvas) return;

        const totalEnergy = low + mid + high;
        const isActive = totalEnergy > 0.12;

        const [br, bg, bb] = this.rainBg;
        if (!isActive) {
            this.rainSilence += dt;
            this.rainStreams.length = 0;
            this.lastBeatIndex = -1;
            if (this.rainSilence > 1.5) {
                rctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
                rctx.fillRect(0, 0, this.rainCanvas.width, this.rainCanvas.height);
                return;
            }
            const fadeOut = 1 - Math.exp(-dt * 4);
            rctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${fadeOut.toFixed(4)})`;
            rctx.fillRect(0, 0, this.rainCanvas.width, this.rainCanvas.height);
            return;
        }
        this.rainSilence = 0;

        // Trail fade — slower than the transient cooldowns so tails stretch
        // several rows behind the head.
        const fade = 1 - Math.exp(-dt * 2.0);
        rctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${fade.toFixed(4)})`;
        rctx.fillRect(0, 0, this.rainCanvas.width, this.rainCanvas.height);

        // ---- Spawning — every stream is a musical event ----
        // No ambient baseline: rain only falls because something in the mix
        // hit. Kick = burst on the left, snare = center, hats = right, and
        // the bar downbeat throws a wide accented volley across the screen.
        const spawn = (x0: number, x1: number, speedMul: number, len: number, accent: number): void => {
            this.rainStreams.push({
                col: Math.min(this.rainCols - 1, Math.floor((x0 + Math.random() * (x1 - x0)) * this.rainCols)),
                y: -1,
                speed: (9 + Math.random() * 6) * speedMul,
                remaining: len + Math.random() * 8,
                accent,
            });
        };

        // Lengths scale with the grid so streams actually traverse the screen
        // instead of dying halfway and leaving the bottom permanently dark.
        const R = this.rainRows;
        const downbeatIndex = Math.floor(this.currentCycle);
        if (downbeatIndex !== this.lastBeatIndex) {
            this.lastBeatIndex = downbeatIndex;
            for (let i = 0; i < 5; i++) {
                spawn(0.02 + i * 0.19, 0.02 + i * 0.19 + 0.15, 1.4, R * 0.9, 1);
            }
        }

        // Per-band transient lanes (same detection thresholds as MarbleDrop).
        this.highTransientCooldown = Math.max(0, this.highTransientCooldown - dt);
        this.midTransientCooldown = Math.max(0, this.midTransientCooldown - dt);
        this.lowTransientCooldown = Math.max(0, this.lowTransientCooldown - dt);

        if (low - this.prevLowEnergy > 0.08 && low > 0.25 && this.lowTransientCooldown <= 0) {
            spawn(0.0, 0.33, 1.6, R * 1.1, 1);
            spawn(0.0, 0.33, 1.4, R * 0.9, 0);
            spawn(0.0, 0.33, 1.2, R * 0.7, 0);
            this.lowTransientCooldown = 0.1;
        }
        if (mid - this.prevMidEnergy > 0.09 && mid > 0.28 && this.midTransientCooldown <= 0) {
            spawn(0.33, 0.66, 1.3, R * 0.6, 0);
            spawn(0.33, 0.66, 1.2, R * 0.5, 0);
            this.midTransientCooldown = 0.08;
        }
        if (high - this.prevHighEnergy > 0.06 && high > 0.20 && this.highTransientCooldown <= 0) {
            spawn(0.66, 1.0, 1.9, R * 0.4, 0);
            this.highTransientCooldown = 0.04;
        }
        this.prevLowEnergy = low;
        this.prevMidEnergy = mid;
        this.prevHighEnergy = high;

        const MAX_STREAMS = 120;
        if (this.rainStreams.length > MAX_STREAMS) {
            this.rainStreams.splice(0, this.rainStreams.length - MAX_STREAMS);
        }

        // ---- Advance streams, stamping glyphs into crossed cells ----
        // The whole field surges on every quarter note and crawls between
        // them — the tempo lock is the loudest visual cue that the rain is
        // listening. Head brightness pumps with the same envelope.
        const beat = beatEnv(this.currentCycle * 4);
        const tempo = 0.45 + beat * 1.1 + totalEnergy * 0.35;
        const cellWDev = this.rainCellW * this.dpr;
        const cellHDev = this.rainCellH * this.dpr;
        for (let i = this.rainStreams.length - 1; i >= 0; i--) {
            const s = this.rainStreams[i];
            const prevRow = Math.floor(s.y);
            const advance = s.speed * tempo * dt;
            s.y += advance;
            s.remaining -= advance;
            const headRow = Math.floor(s.y);
            const x = (s.col + 0.5) * cellWDev;

            // Body glyphs — one stamp per newly-entered cell, matrix green.
            rctx.fillStyle = s.accent
                ? 'hsla(125, 90%, 62%, 0.55)'
                : 'hsla(125, 85%, 50%, 0.45)';
            for (let r = prevRow + 1; r <= headRow; r++) {
                if (r < 0 || r >= this.rainRows) continue;
                rctx.fillText(
                    RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)],
                    x, (r + 0.55) * cellHDev);
            }

            // Bright head — restamped every frame, flashing with the beat.
            if (headRow >= 0 && headRow < this.rainRows) {
                rctx.fillStyle = s.accent
                    ? `hsla(120, 95%, 88%, ${(0.55 + beat * 0.4).toFixed(3)})`
                    : `hsla(122, 90%, 75%, ${(0.4 + beat * 0.4).toFixed(3)})`;
                rctx.fillText(
                    RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)],
                    x, (headRow + 0.55) * cellHDev);
            }

            if (s.remaining <= 0 || headRow > this.rainRows) {
                this.rainStreams.splice(i, 1);
            }
        }
    }

    private updateLissajous(_dt: number): void {
        // Phase shift bumps on each beat — gives the scope curve a fresh
        // topology every quarter note instead of staying static.
        const beatIndex = Math.floor(this.currentCycle * 4);
        if (beatIndex !== this.lissaLastBeatIndex) {
            this.lissaLastBeatIndex = beatIndex;
            // Walk through offset values that produce visually distinct shapes.
            const choices = [24, 48, 64, 96, 128, 160];
            this.lissaOffset = choices[((beatIndex % choices.length) + choices.length) % choices.length];
        }
    }

    private updateWaveTerrain(dt: number): void {
        if (!this.terrainHistory) this.initTerrain();
        if (!this.terrainHistory || !this.freqData) return;

        // Throttle row writes so the terrain rolls at a fixed musical rate
        // (independent of frame rate, like FlameGraph used to).
        this.terrainAccum += dt;
        if (this.terrainAccum < this.TERRAIN_ROW_DT) return;
        this.terrainAccum -= this.TERRAIN_ROW_DT;

        const bars = this.TERRAIN_BARS;
        const binCount = this.freqData.length;
        const usable = Math.max(8, Math.floor(binCount * 0.55));
        const head = this.terrainHead;

        // Sample raw FFT into this row with log-frequency mapping.
        for (let i = 0; i < bars; i++) {
            const t0 = i / bars;
            const t1 = (i + 1) / bars;
            const b0 = Math.floor(Math.pow(t0, 2) * usable);
            const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 2) * usable));
            let peak = 0;
            for (let b = b0; b < b1 && b < binCount; b++) {
                const v = this.freqData[b];
                if (v > peak) peak = v;
            }
            this.terrainHistory[head * bars + i] = (peak / 255) * this.sensitivity;
        }

        this.terrainHead = (head + 1) % this.TERRAIN_ROWS;
    }

    private updateTunnel(dt: number, _low: number, energy: number): void {
        // Constant forward drift + an instantaneous boost on the downbeat.
        const downbeatIdx = Math.floor(this.currentCycle);
        if (downbeatIdx !== this.tunnelLastDownbeat) {
            this.tunnelLastDownbeat = downbeatIdx;
            this.tunnelZVel = 3.6;
        }
        // Decay the boost smoothly so the tunnel lurches forward then settles.
        this.tunnelZVel = Math.max(0.9, this.tunnelZVel - dt * 5.5);

        // Audio energy mildly accelerates baseline drift.
        const drift = this.tunnelZVel * (0.55 + energy * 0.8);

        // Advance every ring; recycle ones past the camera back to the vanishing point.
        for (const ring of this.tunnelRings) {
            ring.z -= drift * dt * 0.45;
            if (ring.z <= 0) ring.z += 1;
        }
    }

    private updateFlameGraph(dt: number, _low: number, _mid: number, _high: number): void {
        if (!this.flameBars || !this.flamePeaks) this.initFlameBars();
        if (!this.flameBars || !this.flamePeaks || !this.freqData) return;

        const N = this.flameBars.length;
        const binCount = this.freqData.length;
        // Above ~half the bins is mostly air, use the bottom half for legibility.
        const usableBins = Math.max(8, Math.floor(binCount * 0.55));

        // Sample raw FFT with a log-frequency curve so bass occupies more
        // visual width (musical perception is logarithmic).
        for (let i = 0; i < N; i++) {
            const t0 = i / N;
            const t1 = (i + 1) / N;
            // pow(t, 2) gives bass more bars; ~1.6 is gentler if you want
            // more even spread.
            const b0 = Math.floor(Math.pow(t0, 2) * usableBins);
            const b1 = Math.max(b0 + 1, Math.floor(Math.pow(t1, 2) * usableBins));

            let peak = 0;
            for (let b = b0; b < b1 && b < binCount; b++) {
                const v = this.freqData[b];
                if (v > peak) peak = v;
            }
            const target = (peak / 255) * this.sensitivity;

            // Classic spectrum analyzer feel: instant rise, gradual fall.
            const curr = this.flameBars[i];
            this.flameBars[i] = target > curr
                ? target
                : Math.max(0, curr + (target - curr) * Math.min(1, dt * 4));

            // Peak-hold: matches current bar on rise, decays slowly on fall.
            const peakVal = this.flamePeaks[i];
            if (this.flameBars[i] >= peakVal) {
                this.flamePeaks[i] = this.flameBars[i];
            } else {
                this.flamePeaks[i] = Math.max(0, peakVal - dt * 0.55);
            }
        }

        // Light spatial smoothing — averages each bar with neighbors so the
        // flame silhouette flows instead of looking like a 32-pixel pixel art.
        const smoothed = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const a = this.flameBars[Math.max(0, i - 1)];
            const b = this.flameBars[i];
            const c = this.flameBars[Math.min(N - 1, i + 1)];
            smoothed[i] = a * 0.25 + b * 0.5 + c * 0.25;
        }
        this.flameBars.set(smoothed);

        // Rising tongue particles — only on loud bars.
        const spawnPx = this.height;
        for (let i = 0; i < N; i++) {
            const v = this.flameBars[i];
            if (v > 0.45 && Math.random() < v * dt * 5) {
                const px = ((i + 0.5) / N) * this.width;
                this.particles.push({
                    x: px + (Math.random() - 0.5) * 10,
                    y: spawnPx - v * spawnPx * 0.7,
                    vx: (Math.random() - 0.5) * 25,
                    vy: -40 - Math.random() * 55,
                    life: 0.45 + Math.random() * 0.35,
                    size: 1.8 + Math.random() * 1.4,
                    hue: barHue(i, N),
                });
            }
        }

        // Tongue physics — drift up, curl slightly, fade.
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy *= 0.96;
            p.vx *= 0.92;
            p.life -= dt * 1.6;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private updateMarbleDrop(dt: number, low: number, high: number): void {
        if (this.pegs.length === 0) this.initPegField();
        const mid = this.midEnergy;

        // ---- Spawn marbles ----
        //
        // We split the canvas into three "drum-machine lanes":
        //   left  (kicks/bass)   → low band   → magenta, biggest marble
        //   mid   (snares/toms)  → mid band   → yellow, mid marble
        //   right (hats/cymbals) → high band  → cyan,    smallest marble
        //
        // Each lane has its OWN consistent column so the same drum sound always
        // drops in the same place — that's what makes the rhythm legible.

        // Gate baseline spawns on actual audio activity so silent intros stay
        // empty (the song's first ~8 cycles are pre-roll).
        const totalEnergy = low + mid + high;
        const isActive = totalEnergy > 0.18;

        if (isActive) {
            // Forced 8th-note baseline — denser than before so 16th-note
            // drum passages get visible support. Downbeats are accented.
            const beatIndex = Math.floor(this.currentCycle * 8);
            if (beatIndex !== this.lastBeatIndex) {
                const isDownbeat = ((beatIndex % 8) + 8) % 8 === 0; // first of bar
                this.lastBeatIndex = beatIndex;
                // Baseline drop in a slightly randomized mid column (won't fight
                // with the drum lanes that hit on transients).
                const xFrac = 0.40 + Math.random() * 0.20;
                this.spawnMarble(xFrac, this.theme.neonHue, isDownbeat ? 6.5 : 4.5);
            }
        } else {
            this.lastBeatIndex = -1; // reset so first beat after silence triggers
        }

        // ---- Transient detection per band ----
        // Cooldowns prevent retriggers on sustained energy; deltas catch onset.
        this.highTransientCooldown = Math.max(0, this.highTransientCooldown - dt);
        this.midTransientCooldown  = Math.max(0, this.midTransientCooldown  - dt);
        this.lowTransientCooldown  = Math.max(0, this.lowTransientCooldown  - dt);
        const highDelta = high - this.prevHighEnergy;
        const midDelta  = mid  - this.prevMidEnergy;
        const lowDelta  = low  - this.prevLowEnergy;

        // Kicks: leftmost columns, big magenta marbles, longer cooldown so
        // sustained bass doesn't carpet-bomb. Threshold low enough to catch
        // 16th-note kick patterns.
        if (lowDelta > 0.08 && low > 0.25 && this.lowTransientCooldown <= 0) {
            this.spawnMarble(0.04 + Math.random() * 0.14, this.theme.secondaryHue, 6);
            this.lowTransientCooldown = 0.06;
        }

        // Snares / mid-band transients: center-left columns, yellow.
        if (midDelta > 0.09 && mid > 0.28 && this.midTransientCooldown <= 0) {
            this.spawnMarble(0.22 + Math.random() * 0.18, this.theme.activeHue, 5);
            this.midTransientCooldown = 0.05;
        }

        // Hi-hats / cymbals: rightmost columns, smaller cyan marbles, shortest
        // cooldown so 16th-note hat patterns visibly cascade.
        if (highDelta > 0.06 && high > 0.20 && this.highTransientCooldown <= 0) {
            this.spawnMarble(0.78 + Math.random() * 0.18, this.theme.neonHue, 3.5);
            this.highTransientCooldown = 0.035;
        }

        this.prevHighEnergy = high;
        this.prevMidEnergy  = mid;
        this.prevLowEnergy  = low;

        // ---- Physics ----
        const gravity = 320;
        const restitution = 0.58;
        const horizontalDamping = 0.98;
        const exitY = this.height - 20;

        for (let i = this.marbles.length - 1; i >= 0; i--) {
            const m = this.marbles[i];

            m.cooldown = Math.max(0, m.cooldown - dt);
            m.vy += gravity * dt;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            m.vx *= horizontalDamping;

            // Wall bounce
            if (m.x < m.radius) {
                m.x = m.radius;
                m.vx = -m.vx * restitution;
            } else if (m.x > this.width - m.radius) {
                m.x = this.width - m.radius;
                m.vx = -m.vx * restitution;
            }

            // Peg collision — only check pegs near this marble's y
            if (m.cooldown <= 0) {
                for (let p = 0; p < this.pegs.length; p++) {
                    const peg = this.pegs[p];
                    if (Math.abs(peg.y - m.y) > 22) continue;

                    const dx = m.x - peg.x;
                    const dy = m.y - peg.y;
                    const r = m.radius + peg.radius;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > r * r) continue;

                    const d = Math.sqrt(d2) || 0.0001;
                    const nx = dx / d;
                    const ny = dy / d;

                    // Push marble out of peg
                    m.x = peg.x + nx * r;
                    m.y = peg.y + ny * r;

                    // Reflect velocity around normal; add small horizontal jitter
                    // so two marbles hitting the same peg don't fall identically.
                    const vDotN = m.vx * nx + m.vy * ny;
                    m.vx = (m.vx - 2 * vDotN * nx) * restitution + (Math.random() - 0.5) * 30;
                    m.vy = (m.vy - 2 * vDotN * ny) * restitution;

                    peg.hit = 1;
                    m.cooldown = 0.04; // skip next ~2 frames of peg checks

                    // Small spark
                    this.particles.push({
                        x: peg.x,
                        y: peg.y,
                        vx: (Math.random() - 0.5) * 60,
                        vy: -Math.random() * 40,
                        life: 0.35,
                        size: 1.5,
                        hue: m.hue,
                    });
                    break;
                }
            }

            // Exit / fade
            if (m.y > exitY) m.life -= dt * 2.2;
            if (m.life <= 0 || m.y > this.height + 30) {
                this.marbles.splice(i, 1);
            }
        }

        // Cap total marbles to keep cost bounded — raised from 80 so dense
        // 16th-note passages don't flush previous cascades prematurely.
        const MAX_MARBLES = 140;
        if (this.marbles.length > MAX_MARBLES) {
            this.marbles.splice(0, this.marbles.length - MAX_MARBLES);
        }

        // Peg hit-glow decay
        for (const peg of this.pegs) {
            peg.hit *= 0.88;
        }

        // Spark particle update
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += gravity * dt * 0.5;
            p.life -= dt * 2.5;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private spawnMarble(xFrac: number, hue: number, radius: number = 4.5): void {
        const margin = 24;
        const x = margin + xFrac * (this.width - margin * 2);
        this.marbles.push({
            x,
            y: 12,
            vx: (Math.random() - 0.5) * 30,
            vy: 20 + Math.random() * 30,
            radius,
            hue,
            cooldown: 0,
            life: 1,
        });
    }

    private updateNeonCircuit(dt: number, _low: number, mid: number, high: number, energy: number): void {
        const cx = this.width / 2;
        const cy = this.height / 2;

        // Particle spawn rate tracks mid+high (transients)
        const spawnRate = (0.6 + mid * 1.8) * dt * 4;
        if (Math.random() < spawnRate) {
            const angle = Math.random() * TAU;
            const speed = 18 + high * 42 + Math.random() * 12;
            this.particles.push({
                x: cx + Math.cos(angle) * (40 + Math.random() * 80),
                y: cy + Math.sin(angle) * (30 + Math.random() * 60),
                vx: Math.cos(angle + (Math.random() - 0.5) * 0.8) * speed,
                vy: Math.sin(angle + (Math.random() - 0.5) * 0.8) * speed,
                life: 0.6 + energy * 0.9 + Math.random() * 0.5,
                size: 1.2 + high * 1.8,
                hue: this.theme.neonHue + (high - _low) * 35,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.985;
            p.vy *= 0.985;
            p.life -= dt * (0.7 + _low * 0.6);
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private updateMarbleCore(dt: number, low: number, _energy: number): void {
        // Rings & orbs are positioned from `currentCycle` directly in render —
        // here we only spawn FFT-driven impact particles on strong low hits.
        if (low > 0.55 && Math.random() < low * dt * 9) {
            const angle = Math.random() * TAU;
            const r = 70 + Math.random() * 160;
            this.particles.push({
                x: this.width / 2 + Math.cos(angle) * r,
                y: this.height / 2 + Math.sin(angle) * r * 0.6,
                vx: Math.cos(angle) * (22 + low * 35),
                vy: Math.sin(angle) * (18 + low * 28),
                life: 0.45 + low * 0.5,
                size: 2.5 + low * 3,
                hue: this.theme.activeHue + low * 30,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.96;
            p.vy *= 0.96;
            p.life -= dt * 1.4;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private render(): void {
        const { ctx, width, height } = this;

        // Lissajous + StrangeAttractor use a translucent fill instead of an
        // opaque clear so their strokes leave a fading trail across frames.
        // Plasma fades fast too — it composites additively, so a partial
        // clear keeps a faint after-image without ghosting.
        if (this.mode === FullscreenVizMode.Lissajous || this.mode === FullscreenVizMode.StrangeAttractor) {
            ctx.fillStyle = 'rgba(5, 6, 10, 0.16)';
        } else if (this.mode === FullscreenVizMode.Plasma) {
            ctx.fillStyle = 'rgba(5, 6, 10, 0.35)';
        } else {
            ctx.fillStyle = this.theme.bg;
        }
        ctx.fillRect(0, 0, width, height);

        this.drawScanlines(ctx, width, height);

        switch (this.mode) {
            case FullscreenVizMode.NeonCircuit:
                this.renderNeonCircuit(ctx, width, height);
                break;
            case FullscreenVizMode.MarbleCore:
                this.renderMarbleCore(ctx, width, height);
                break;
            case FullscreenVizMode.MarbleDrop:
                this.renderMarbleDrop(ctx, width, height);
                break;
            case FullscreenVizMode.FlameGraph:
                this.renderFlameGraph(ctx, width, height);
                break;
            case FullscreenVizMode.Lissajous:
                this.renderLissajous(ctx, width, height);
                break;
            case FullscreenVizMode.WaveTerrain:
                this.renderWaveTerrain(ctx, width, height);
                break;
            case FullscreenVizMode.Tunnel:
                this.renderTunnel(ctx, width, height);
                break;
            case FullscreenVizMode.StrangeAttractor:
                this.renderAttractor(ctx, width, height);
                break;
            case FullscreenVizMode.Plasma:
                this.renderPlasma(ctx, width, height);
                break;
            case FullscreenVizMode.Kaleidoscope:
                this.renderKaleidoscope(ctx, width, height);
                break;
            case FullscreenVizMode.AsciiArt:
                this.renderAsciiArt(ctx);
                break;
            case FullscreenVizMode.MatrixRain:
                if (this.rainCanvas) ctx.drawImage(this.rainCanvas, 0, 0, width, height);
                break;
        }

        this.drawVignette(ctx, width, height);
    }

    /**
     * Compose the ASCII scope: the phosphor etch layer, then the live beam —
     * the actual Lissajous curve, stroked faintly on top so you can see the
     * "pen" that is doing the etching.
     */
    private renderAsciiArt(ctx: CanvasRenderingContext2D): void {
        if (!this.artEtch) return;

        const box = this.artBox;
        ctx.drawImage(this.artEtch, box.x, box.y, box.w, box.h);

        // Beam trace only while there's actually signal — a silent scope
        // shows nothing at all.
        if (!this.artBeamOn || !this.timeData) return;
        const data = this.timeData;
        const N = data.length;
        const off = this.artOffset;
        if (N < off + 8) return;

        const beat = beatEnv(this.currentCycle * 4);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const amp = 0.49;
        const norm = 1 / this.artPeak;
        const usable = N - off;
        const step = Math.max(2, Math.floor(usable / 300));

        ctx.strokeStyle = `hsla(${this.theme.neonHue}, 90%, 72%, ${(0.05 + beat * 0.07).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < usable; i += step) {
            const x = cx + Math.max(-1, Math.min(1, (data[i] - 128) * norm)) * amp * box.w;
            const y = cy + Math.max(-1, Math.min(1, (data[i + off] - 128) * norm)) * amp * box.h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    /**
     * Project the Lorenz trail to screen space and stroke it as a polyline
     * with age-graded color. Most-recent end is brightest.
     */
    private renderAttractor(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (!this.attrTrail) return;

        const cx = w / 2;
        const cy = h * 0.55;
        // Lorenz coordinates roam roughly in [-30, 30] for x/y, [0, 50] for z.
        // Scale to fit the canvas with some headroom.
        const scale = Math.min(w, h) / 70;
        const trailCap = this.ATTR_TRAIL_CAP;
        const head = this.attrTrailHead;

        const baseHue = this.theme.neonHue;
        const secHue = this.theme.secondaryHue;
        const cycleHue = (this.currentCycle * 18) % 360;

        // Iterate oldest → newest so that newer segments paint over older.
        ctx.lineCap = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < trailCap; i++) {
            const idx = (head + i) % trailCap;
            const t = i / (trailCap - 1); // 0 = oldest, 1 = newest
            const x = this.attrTrail[idx * 3 + 0];
            const y = this.attrTrail[idx * 3 + 1];
            const z = this.attrTrail[idx * 3 + 2];
            // Project (x, y, z) → 2D. z shifts upward, y becomes vertical.
            const sx = cx + x * scale;
            const sy = cy + (y * 0.6 - z) * scale;

            if (!started) {
                ctx.moveTo(sx, sy);
                started = true;
            } else {
                ctx.lineTo(sx, sy);
            }

            // Periodically stroke segments so we can recolor by age. Stroking
            // every point is expensive; do it in batches.
            if ((i & 31) === 31 || i === trailCap - 1) {
                const hue = baseHue + (secHue - baseHue) * t * 0.6 + cycleHue;
                ctx.strokeStyle = `hsla(${hue}, 95%, ${50 + t * 35}%, ${0.05 + t * 0.6})`;
                ctx.lineWidth = 0.6 + t * 1.6;
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(sx, sy);
            }
        }

        // Bright head point — emphasizes "where we are now".
        const hx = cx + this.attrX * scale;
        const hy = cy + (this.attrY * 0.6 - this.attrZ) * scale;
        ctx.fillStyle = `hsla(${baseHue + cycleHue}, 100%, 85%, 0.9)`;
        ctx.beginPath();
        ctx.arc(hx, hy, 3, 0, TAU);
        ctx.fill();
    }

    /**
     * Render plasma metaballs as additively-blended radial gradients. When
     * two balls overlap, their gradients sum to give the classic "fused
     * liquid" look without per-pixel field calculation.
     */
    private renderPlasma(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (this.plasmaBalls.length === 0) {
            this.initPlasma();
            if (this.plasmaBalls.length === 0) return;
        }
        const low = this.plasmaBassPulse;

        ctx.globalCompositeOperation = 'lighter';
        for (const b of this.plasmaBalls) {
            const breath = 1 + Math.sin(b.phase) * 0.12;
            const pulse = 1 + low * 0.45;
            const r = b.baseR * breath * pulse;

            const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
            grad.addColorStop(0,    `hsla(${b.hue}, 95%, 65%, 0.55)`);
            grad.addColorStop(0.45, `hsla(${b.hue}, 95%, 55%, 0.18)`);
            grad.addColorStop(1,    `hsla(${b.hue}, 95%, 50%, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(b.x - r, b.y - r, r * 2, r * 2);
        }
        ctx.globalCompositeOperation = 'source-over';

        // Avoid lint warning by reading w/h without a no-op
        void w; void h;
    }

    /**
     * Kaleidoscope — render the single base wedge of particles, then rotate
     * (and alternately reflect) around the center for N-fold symmetry.
     */
    private renderKaleidoscope(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const cx = w / 2;
        const cy = h / 2;
        const slices = this.KALEIDO_SLICES;

        // Reusable lambda — draws all particles within the canonical wedge.
        const drawWedge = (): void => {
            for (const p of this.kaleidoParticles) {
                const px = Math.cos(p.angle) * p.r;
                const py = Math.sin(p.angle) * p.r;
                const a = Math.max(0.05, p.life);

                // Glow halo
                ctx.fillStyle = `hsla(${p.hue}, 95%, 70%, ${a * 0.18})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size * 3.2, 0, TAU);
                ctx.fill();

                // Core
                ctx.fillStyle = `hsla(${p.hue}, 95%, 82%, ${a * 0.85})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, TAU);
                ctx.fill();
            }

            // A faint outline of the wedge boundary helps the symmetry read
            const maxR = Math.min(w, h) * 0.5;
            ctx.strokeStyle = `hsla(${this.theme.neonHue}, 92%, 70%, 0.06)`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(maxR, 0);
            ctx.stroke();
        };

        ctx.save();
        ctx.translate(cx, cy);
        for (let s = 0; s < slices; s++) {
            ctx.save();
            ctx.rotate((s / slices) * TAU);
            // Mirror every other wedge for a true kaleidoscope reflection.
            if (s % 2 === 1) ctx.scale(1, -1);
            drawWedge();
            ctx.restore();
        }
        ctx.restore();

        // Center pulse — soft glow that breathes with the cycle.
        const pulse = beatEnv(this.currentCycle * 4);
        const coreR = 6 + pulse * 14;
        const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2);
        coreGrad.addColorStop(0, `hsla(${this.theme.neonHue}, 100%, 85%, ${0.4 + pulse * 0.4})`);
        coreGrad.addColorStop(1, `hsla(${this.theme.neonHue}, 100%, 60%, 0)`);
        ctx.fillStyle = coreGrad;
        ctx.fillRect(cx - coreR * 2, cy - coreR * 2, coreR * 4, coreR * 4);
    }

    /**
     * Lissajous Scope: plot the time-domain waveform against a delayed copy
     * of itself (x[i], x[i + offset]). Folds into complex symmetric curves
     * whose topology shifts on each beat. Trail-painted via the fading
     * background so motion smears beautifully.
     */
    private renderLissajous(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (!this.timeData) return;
        const data = this.timeData;
        const N = data.length;
        const off = this.lissaOffset;
        if (N < off + 4) return;

        const cx = w / 2;
        const cy = h / 2;
        const scale = Math.min(w, h) * 0.42;

        // Hue rotates slowly with the cycle for variety between beats.
        const hue = (this.currentCycle * 30) % 360;
        ctx.strokeStyle = `hsla(${hue}, 95%, 75%, 0.65)`;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        for (let i = 0; i < N - off; i++) {
            // Map 0..255 → -1..1, scale to fit
            const x = ((data[i]       - 128) / 128) * scale + cx;
            const y = ((data[i + off] - 128) / 128) * scale + cy;
            if (i === 0) ctx.moveTo(x, y);
            else         ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Subtle inner highlight stroke for a "phosphor" feel.
        ctx.strokeStyle = `hsla(${hue + 20}, 100%, 90%, 0.35)`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
    }

    /**
     * Wave Terrain: render the last ~1.5s of FFT history as a stack of
     * polylines with fake perspective. Newest row at bottom-front, older
     * rows recede toward a horizon. Reads like a topographic map of the
     * song's spectrum as it scrolls toward the viewer.
     */
    private renderWaveTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (!this.terrainHistory) {
            this.initTerrain();
            if (!this.terrainHistory) return;
        }

        const rows = this.TERRAIN_ROWS;
        const bars = this.TERRAIN_BARS;
        const head = this.terrainHead;
        const horizon = h * 0.18;
        const baseY = h * 0.92;
        const baseHalfW = w * 0.46;
        const horizonHalfW = w * 0.08;
        const peakH = (baseY - horizon) * 0.65;

        // Walk back-to-front so closer rows paint over farther ones.
        for (let r = rows - 1; r >= 0; r--) {
            // i = 0 is OLDEST (farthest, smallest), i = rows-1 is NEWEST (closest).
            const i = r;
            const idx = (head + i) % rows;
            const t = i / (rows - 1);                   // 0..1 far→near
            const rowY = horizon + (baseY - horizon) * t;
            const halfW = horizonHalfW + (baseHalfW - horizonHalfW) * t;
            const left = w / 2 - halfW;
            const right = w / 2 + halfW;
            const alpha = 0.15 + t * 0.55;
            const hue = this.theme.neonHue + (1 - t) * 60;

            // Build polyline across this row
            ctx.beginPath();
            for (let b = 0; b < bars; b++) {
                const v = this.terrainHistory[idx * bars + b];
                const x = left + (b / (bars - 1)) * (right - left);
                const y = rowY - v * peakH * (0.4 + t * 0.6);
                if (b === 0) ctx.moveTo(x, y);
                else         ctx.lineTo(x, y);
            }
            // Close back along the row baseline so we can fill under the line
            ctx.lineTo(right, rowY);
            ctx.lineTo(left, rowY);
            ctx.closePath();

            // Fill under the curve — translucent so layers blend
            ctx.fillStyle = `hsla(${hue}, 92%, 50%, ${alpha * 0.22})`;
            ctx.fill();

            // Stroke the top edge for ridgeline definition
            ctx.beginPath();
            for (let b = 0; b < bars; b++) {
                const v = this.terrainHistory[idx * bars + b];
                const x = left + (b / (bars - 1)) * (right - left);
                const y = rowY - v * peakH * (0.4 + t * 0.6);
                if (b === 0) ctx.moveTo(x, y);
                else         ctx.lineTo(x, y);
            }
            ctx.strokeStyle = `hsla(${hue}, 92%, 75%, ${alpha})`;
            ctx.lineWidth = 0.9;
            ctx.stroke();
        }

        // Horizon glow — soft cyan band where the terrain meets the sky.
        const skyGrad = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 4);
        skyGrad.addColorStop(0, `hsla(${this.theme.neonHue}, 92%, 60%, 0)`);
        skyGrad.addColorStop(1, `hsla(${this.theme.neonHue}, 92%, 60%, 0.25)`);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, horizon - 40, w, 44);
    }

    /**
     * Tunnel: concentric octagons receding to a vanishing point. Cycle-locked
     * rotation; on each downbeat a forward-velocity boost lurches the camera
     * deeper into the tunnel before settling back to baseline drift.
     */
    private renderTunnel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const cx = w / 2;
        const cy = h / 2;
        const maxR = Math.min(w, h) * 0.55;
        const SIDES = 8;
        const neonHue = this.theme.neonHue;
        const secHue = this.theme.secondaryHue;

        // Sort rings far-to-near so closer ones paint over farther ones.
        const ringsByZ = [...this.tunnelRings].sort((a, b) => b.z - a.z);

        const baseAngle = this.currentCycle * TAU * 0.25; // 1 full rotation per 4 bars

        for (const ring of ringsByZ) {
            // Perspective: scale falls off as z increases. Pinch near the
            // vanishing point so rings really shrink to a dot.
            const persp = 1 - ring.z;
            if (persp <= 0.01) continue;
            const r = maxR * persp;

            // Mix between cyan and magenta along the depth axis
            const hue = neonHue + (secHue - neonHue) * (1 - persp) * 0.6 + ring.hueShift;

            // Per-ring rotation phase — half rings spin clockwise, half CCW
            // for a "depth contrast" feel.
            const dir = (ring.hueShift / 22) % 2 === 0 ? 1 : -1;
            const angle = baseAngle * dir + ring.angle;

            ctx.beginPath();
            for (let s = 0; s <= SIDES; s++) {
                const a = angle + (s / SIDES) * TAU;
                const x = cx + Math.cos(a) * r;
                const y = cy + Math.sin(a) * r;
                if (s === 0) ctx.moveTo(x, y);
                else         ctx.lineTo(x, y);
            }
            ctx.closePath();

            // Alpha + thickness rise toward the camera
            ctx.strokeStyle = `hsla(${hue}, 92%, 72%, ${0.12 + persp * 0.55})`;
            ctx.lineWidth = 0.6 + persp * 2.2;
            ctx.stroke();

            // Subtle radial spokes at the brightest rings — emphasizes depth
            if (persp > 0.55) {
                ctx.strokeStyle = `hsla(${hue}, 92%, 78%, ${(persp - 0.55) * 0.35})`;
                ctx.lineWidth = 0.6;
                ctx.beginPath();
                for (let s = 0; s < SIDES; s++) {
                    const a = angle + (s / SIDES) * TAU;
                    const x1 = cx + Math.cos(a) * r * 0.78;
                    const y1 = cy + Math.sin(a) * r * 0.78;
                    const x2 = cx + Math.cos(a) * r;
                    const y2 = cy + Math.sin(a) * r;
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                }
                ctx.stroke();
            }
        }

        // Vanishing-point glow — gives the tunnel a "light at the end" feel.
        const vpGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.12);
        vpGrad.addColorStop(0, `hsla(${neonHue}, 100%, 85%, 0.55)`);
        vpGrad.addColorStop(1, `hsla(${neonHue}, 100%, 70%, 0)`);
        ctx.fillStyle = vpGrad;
        ctx.fillRect(cx - maxR * 0.12, cy - maxR * 0.12, maxR * 0.24, maxR * 0.24);
    }

    /**
     * Winamp-style spectrum flame: one big silhouette across the canvas
     * driven by FFT bins. Horizontal hue gradient assigns "track colors"
     * (bass=red, mid=orange/yellow, high=cyan); vertical gradient gives the
     * fire heat falloff. Peak-hold dots + rising tongue particles complete
     * the campfire feel.
     */
    private renderFlameGraph(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        if (!this.flameBars || !this.flamePeaks) {
            this.initFlameBars();
            if (!this.flameBars || !this.flamePeaks) return;
        }

        const N = this.flameBars.length;
        const baseY = h - 6;
        const maxH = h * 0.86;

        // Ember bed — a soft red glow strip along the base. Always present so
        // even silent passages show a faint hint of warmth.
        const emberGrad = ctx.createLinearGradient(0, baseY, 0, baseY - 60);
        emberGrad.addColorStop(0, 'hsla(10, 95%, 50%, 0.30)');
        emberGrad.addColorStop(1, 'hsla(20, 95%, 50%, 0)');
        ctx.fillStyle = emberGrad;
        ctx.fillRect(0, baseY - 60, w, 60);

        // Build the silhouette path — smooth quadratic curves between bar
        // midpoints so the flame's edge undulates instead of stepping.
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        for (let i = 0; i < N; i++) {
            const x = ((i + 0.5) / N) * w;
            const y = baseY - this.flameBars[i] * maxH;
            if (i === 0) {
                ctx.lineTo(0, y);
                ctx.lineTo(x, y);
            } else {
                const xPrev = ((i - 0.5) / N) * w;
                const yPrev = baseY - this.flameBars[i - 1] * maxH;
                const cx = (x + xPrev) * 0.5;
                const cy = (y + yPrev) * 0.5;
                ctx.quadraticCurveTo(xPrev, yPrev, cx, cy);
            }
        }
        ctx.lineTo(w, baseY);
        ctx.closePath();

        // Pass 1: horizontal HUE gradient — these are the "track colors".
        //   left  (low frequencies / bass)  → deep red
        //   mid   (mids / melody)           → orange → yellow
        //   right (highs / hats / cymbals)  → cyan
        const hueGrad = ctx.createLinearGradient(0, 0, w, 0);
        hueGrad.addColorStop(0.00, 'hsla(0,   95%, 50%, 0.85)');
        hueGrad.addColorStop(0.25, 'hsla(20,  95%, 55%, 0.85)');
        hueGrad.addColorStop(0.50, 'hsla(45,  95%, 65%, 0.80)');
        hueGrad.addColorStop(0.75, 'hsla(120, 90%, 70%, 0.65)');
        hueGrad.addColorStop(1.00, `hsla(${this.theme.neonHue}, 95%, 75%, 0.55)`);
        ctx.fillStyle = hueGrad;
        ctx.fill();

        // Pass 2: vertical brightness fade via screen blend — burns the tips
        // brighter and the base saturated, giving the heat falloff.
        const heatGrad = ctx.createLinearGradient(0, baseY, 0, baseY - maxH);
        heatGrad.addColorStop(0.00, 'hsla(0, 0%, 0%, 0)');
        heatGrad.addColorStop(0.55, 'hsla(0, 0%, 100%, 0.18)');
        heatGrad.addColorStop(1.00, 'hsla(0, 0%, 100%, 0.45)');
        ctx.fillStyle = heatGrad;
        ctx.globalCompositeOperation = 'screen';
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        // Bright outline along the flame's top edge — same shape, just stroke.
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
            const x = ((i + 0.5) / N) * w;
            const y = baseY - this.flameBars[i] * maxH;
            if (i === 0) ctx.moveTo(x, y);
            else {
                const xPrev = ((i - 0.5) / N) * w;
                const yPrev = baseY - this.flameBars[i - 1] * maxH;
                const cx = (x + xPrev) * 0.5;
                const cy = (y + yPrev) * 0.5;
                ctx.quadraticCurveTo(xPrev, yPrev, cx, cy);
            }
        }
        ctx.strokeStyle = 'hsla(50, 100%, 85%, 0.45)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Peak-hold dots — small floating sparks along each bar's recent max.
        for (let i = 0; i < N; i++) {
            const p = this.flamePeaks[i];
            if (p < 0.08) continue;
            const x = ((i + 0.5) / N) * w;
            const y = baseY - p * maxH;
            const hue = barHue(i, N);
            ctx.fillStyle = `hsla(${hue + 25}, 95%, 85%, 0.55)`;
            ctx.beginPath();
            ctx.arc(x, y, 1.8, 0, TAU);
            ctx.fill();
        }

        // Rising tongue particles — fade as they climb.
        for (const p of this.particles) {
            const a = Math.max(0.08, p.life);
            ctx.fillStyle = `hsla(${p.hue + 30}, 95%, 82%, ${a * 0.55})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, TAU);
            ctx.fill();
        }
    }

    private renderMarbleDrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const neonHue = this.theme.neonHue;

        // Static peg grid — translucent so the code stays readable behind
        for (const peg of this.pegs) {
            const hit = peg.hit;
            // Glow on recent hit
            if (hit > 0.05) {
                ctx.fillStyle = `hsla(${neonHue}, 92%, 80%, ${hit * 0.35})`;
                ctx.beginPath();
                ctx.arc(peg.x, peg.y, peg.radius * 4 * (1 + hit), 0, TAU);
                ctx.fill();
            }
            ctx.fillStyle = `hsla(${neonHue}, 60%, 70%, ${0.18 + hit * 0.5})`;
            ctx.beginPath();
            ctx.arc(peg.x, peg.y, peg.radius, 0, TAU);
            ctx.fill();
        }

        // Floor line — a faint guide where marbles exit
        ctx.strokeStyle = `hsla(${neonHue}, 80%, 60%, 0.12)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h - 20);
        ctx.lineTo(w, h - 20);
        ctx.stroke();

        // Spark trails from peg hits
        for (const p of this.particles) {
            const a = Math.max(0.05, p.life);
            ctx.fillStyle = `hsla(${p.hue}, 95%, 78%, ${a * 0.55})`;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }

        // Marbles — motion trail + glow halo + bright core + glassy highlight
        for (const m of this.marbles) {
            const life = Math.min(1, m.life);
            const fadeOut = m.y > h - 60 ? life : 1;
            const haloAlpha = 0.18 * fadeOut;
            const coreAlpha = 0.78 * fadeOut;

            // Velocity-aligned trail — gives marbles a "drop streak" that
            // reads beautifully on video without per-frame history tracking.
            const speed = Math.hypot(m.vx, m.vy);
            if (speed > 30) {
                const trailLen = Math.min(m.radius * 5, speed * 0.06);
                const nx = -m.vx / speed * trailLen;
                const ny = -m.vy / speed * trailLen;
                const grad = ctx.createLinearGradient(m.x, m.y, m.x + nx, m.y + ny);
                grad.addColorStop(0, `hsla(${m.hue}, 95%, 75%, ${0.55 * fadeOut})`);
                grad.addColorStop(1, `hsla(${m.hue}, 95%, 75%, 0)`);
                ctx.strokeStyle = grad;
                ctx.lineWidth = m.radius * 1.4;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(m.x, m.y);
                ctx.lineTo(m.x + nx, m.y + ny);
                ctx.stroke();
            }

            ctx.fillStyle = `hsla(${m.hue}, 95%, 70%, ${haloAlpha})`;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.radius * 3.5, 0, TAU);
            ctx.fill();

            ctx.fillStyle = `hsla(${m.hue}, 95%, 82%, ${coreAlpha})`;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.radius, 0, TAU);
            ctx.fill();

            // Highlight dot — gives the marble a glassy look
            ctx.fillStyle = `hsla(0, 0%, 100%, ${0.65 * fadeOut})`;
            ctx.beginPath();
            ctx.arc(m.x - m.radius * 0.35, m.y - m.radius * 0.35, m.radius * 0.32, 0, TAU);
            ctx.fill();
        }
    }

    private drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        ctx.strokeStyle = `hsla(${this.theme.neonHue}, 92%, 70%, 0.035)`;
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

    private renderNeonCircuit(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const high = this.highEnergy;
        const neonHue = this.theme.neonHue;
        const secondaryHue = this.theme.secondaryHue;
        const cx = w / 2;
        const cy = h / 2;

        // Cycle = 1 bar. Pulse at quarter-note (4×) for "beat" feel; downbeat
        // (1×) for once-per-bar accents. beatEnv = sharp attack, slow decay.
        const beat = beatEnv(this.currentCycle * 4);
        const downbeat = beatEnv(this.currentCycle);
        const cyclePhase = this.currentCycle * TAU;

        // Connections behind nodes — alpha pulses with the quarter-beat
        const beatBoost = 0.28 + beat * 0.55;
        ctx.lineWidth = 0.8 + beat * 1.4;
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i];
                const b = this.nodes[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 260 || dist < 18) continue;

                const alpha = Math.max(0.08, 0.55 - dist / 260) * (0.4 + mid * 0.9) * beatBoost;
                ctx.strokeStyle = `hsla(${neonHue}, 92%, 68%, ${alpha})`;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
        }

        // Particles (data packets)
        ctx.fillStyle = this.theme.neon;
        for (const p of this.particles) {
            const alpha = Math.max(0.15, p.life / 1.4);
            ctx.globalAlpha = alpha;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }
        ctx.globalAlpha = 1;

        // Nodes — radius driven by quarter-beat (1.0 → 0 each beat), much
        // bigger swing than before. Position breathes outward on the beat too.
        const breathePx = 12 * beat;
        for (const node of this.nodes) {
            // Offset per-node so nodes don't pulse in unison — gives a ripple
            const localBeat = beatEnv(this.currentCycle * 4 + node.offset * 0.25);
            const r = 3.5 + localBeat * 8 + high * 3;

            // Outward breathe — push nodes radially on the beat
            const dx = node.x - cx;
            const dy = node.y - cy;
            const d = Math.hypot(dx, dy) || 1;
            const px = node.x + (dx / d) * breathePx * 0.6;
            const py = node.y + (dy / d) * breathePx * 0.6;

            // Glow halo — translucent so code stays readable behind it
            ctx.fillStyle = `hsla(${neonHue}, 92%, 68%, ${0.04 + localBeat * 0.22})`;
            ctx.beginPath();
            ctx.arc(px, py, r * 3.2, 0, TAU);
            ctx.fill();

            // Core — also translucent, fully present only on the beat
            ctx.fillStyle = `hsla(${neonHue}, 92%, 70%, ${0.35 + localBeat * 0.55})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, TAU);
            ctx.fill();
        }

        // Downbeat shockwave — expanding ring from center on every bar
        if (downbeat > 0.02) {
            const t = 1 - downbeat;
            const ringR = Math.min(w, h) * 0.05 + t * Math.min(w, h) * 0.55;
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 70%, ${downbeat * 0.45})`;
            ctx.lineWidth = 1 + downbeat * 2.4;
            ctx.beginPath();
            ctx.arc(cx, cy, ringR, 0, TAU);
            ctx.stroke();
        }

        // Horizontal data bus — alpha also tracks the beat
        if (low > 0.2 || beat > 0.4) {
            const busAlpha = (0.2 + low * 0.35) * (0.4 + beat * 0.8);
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 65%, ${busAlpha})`;
            ctx.lineWidth = 1.5 + low * 1.2 + beat * 1.5;
            const y = h * (0.28 + Math.sin(cyclePhase * 0.5) * 0.12);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }

    private renderMarbleCore(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const cx = w / 2;
        const cy = h / 2;
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const cyclePhase = this.currentCycle * TAU;
        const beat = beatEnv(this.currentCycle * 4);
        const downbeat = beatEnv(this.currentCycle);

        // Sweeping "playhead" arm — one revolution per bar, very obvious
        // cycle-locked motion.
        const armAngle = cyclePhase;
        const armOuter = Math.min(w, h) * 0.45;
        const armGrad = ctx.createLinearGradient(
            cx, cy,
            cx + Math.cos(armAngle) * armOuter,
            cy + Math.sin(armAngle) * armOuter,
        );
        armGrad.addColorStop(0, `hsla(${this.theme.neonHue}, 92%, 70%, 0)`);
        armGrad.addColorStop(1, `hsla(${this.theme.neonHue}, 92%, 72%, 0.28)`);
        ctx.strokeStyle = armGrad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(armAngle) * armOuter, cy + Math.sin(armAngle) * armOuter);
        ctx.stroke();

        // Rings — rotation locked to integer ratios of the cycle. Brightness
        // pumps with quarter-beat so the cycle lock reads at a glance.
        for (const ring of this.rings) {
            const ringPhase = cyclePhase * ring.cyclesPerRev + ring.phaseOffset;
            const r = ring.radius + Math.sin(ringPhase) * (4 + low * 7) + downbeat * 6;
            // Each ring brightens when its own phase wraps — those local accents
            // are what make integer ratios visible.
            const ringBeat = beatEnv(ringPhase / TAU);
            const alpha = 0.22 + ringBeat * 0.4 + beat * 0.1;

            ctx.strokeStyle = `hsla(${ring.hue}, 88%, 72%, ${alpha})`;
            ctx.lineWidth = 1.6 + ringBeat * 1.8;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, TAU);
            ctx.stroke();

            // Longer, brighter tick marks — much more obvious rotation
            const tickCount = 8;
            const tickLen = 10 + ringBeat * 6;
            ctx.strokeStyle = `hsla(${ring.hue}, 95%, 82%, ${alpha * 0.9})`;
            ctx.lineWidth = 1.4;
            for (let i = 0; i < tickCount; i++) {
                const a = ringPhase + (i / tickCount) * TAU;
                const x1 = cx + Math.cos(a) * (r - tickLen * 0.5);
                const y1 = cy + Math.sin(a) * (r - tickLen * 0.5);
                const x2 = cx + Math.cos(a) * (r + tickLen * 0.5);
                const y2 = cy + Math.sin(a) * (r + tickLen * 0.5);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }

        // Orbs — orbit at integer rates with a beat-driven size pulse
        for (const orb of this.orbs) {
            const angle = orb.baseAngle + cyclePhase * orb.cyclesPerRev;
            const orbBeat = beatEnv(angle / TAU);
            const x = cx + Math.cos(angle) * orb.radius;
            const y = cy + Math.sin(angle) * orb.radius * 0.58;
            const sizeBoost = 1 + orbBeat * 1.4;

            ctx.fillStyle = `hsla(${orb.hue}, 95%, 75%, ${0.10 + orbBeat * 0.28})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * 2.6 * sizeBoost, 0, TAU);
            ctx.fill();

            ctx.fillStyle = `hsla(${orb.hue}, 92%, 82%, ${0.45 + orbBeat * 0.4})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * sizeBoost, 0, TAU);
            ctx.fill();
        }

        // Impact particles
        for (const p of this.particles) {
            const a = Math.max(0.1, p.life / 1.1);
            ctx.fillStyle = `hsla(${p.hue}, 90%, 78%, ${a})`;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }

        // FFT-reactive core glow
        const coreSize = 18 + (low + mid) * 11;
        const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, coreSize * 1.8);
        grad.addColorStop(0, `hsla(${this.theme.secondaryHue}, 90%, 60%, ${0.35 + (low + mid) * 0.25})`);
        grad.addColorStop(1, `hsla(${this.theme.neonHue}, 92%, 60%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreSize * 1.9, 0, TAU);
        ctx.fill();
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
        this.particles.length = 0;
        this.nodes.length = 0;
        this.rings.length = 0;
        this.orbs.length = 0;
        this.marbles.length = 0;
        this.pegs.length = 0;
    }
}

/**
 * Map a bar index (0..N-1) to a hue along the FlameGraph "track palette":
 * red (bass) → orange → yellow → green/cyan (highs). Matches the horizontal
 * gradient used to fill the flame silhouette so particles + peak dots stay
 * coherent with the column they came from.
 */
function barHue(i: number, N: number): number {
    const t = N <= 1 ? 0 : i / (N - 1);
    if (t < 0.25) return 0   + (t / 0.25) * 20;            // red → orange
    if (t < 0.50) return 20  + ((t - 0.25) / 0.25) * 25;   // orange → yellow
    if (t < 0.75) return 45  + ((t - 0.50) / 0.25) * 75;   // yellow → green
    return                 120 + ((t - 0.75) / 0.25) * 65; // green → cyan
}

/**
 * Beat envelope — sharp attack, fast decay across one beat. Takes a phase
 * value (cycles, not radians); returns 0..1. Snappy "drum hit" feel: ~30%
 * of the beat duration carries most of the energy, then it's flat.
 */
function beatEnv(phase: number): number {
    const t = phase - Math.floor(phase); // 0..1 within current beat
    // (1 - t)^4 → 1.0 at beat onset, fades sharply; back near 0 by t≈0.5
    const decay = 1 - t;
    const d2 = decay * decay;
    return d2 * d2;
}

/**
 * Parse `#rgb` / `#rrggbb` into components. Falls back if parsing fails.
 */
function rgbOf(color: string, fallback: [number, number, number]): [number, number, number] {
    const c = color.trim();
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        return [
            parseInt(c[1] + c[1], 16),
            parseInt(c[2] + c[2], 16),
            parseInt(c[3] + c[3], 16),
        ];
    }
    if (/^#[0-9a-f]{6}$/i.test(c)) {
        return [
            parseInt(c.slice(1, 3), 16),
            parseInt(c.slice(3, 5), 16),
            parseInt(c.slice(5, 7), 16),
        ];
    }
    return fallback;
}

/**
 * Extract a hue (0..360) from a CSS color string. Supports `#rrggbb`, `#rgb`,
 * and `hsl(h, ...)`. Falls back to the provided default if parsing fails.
 */
function hueOf(color: string, fallback: number): number {
    const c = color.trim();
    if (!c) return fallback;

    // hsl() / hsla()
    const hslMatch = c.match(/^hsla?\(\s*([-\d.]+)/i);
    if (hslMatch) {
        const h = parseFloat(hslMatch[1]);
        return Number.isFinite(h) ? ((h % 360) + 360) % 360 : fallback;
    }

    // #rgb / #rrggbb
    let r = 0, g = 0, b = 0;
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        r = parseInt(c[1] + c[1], 16);
        g = parseInt(c[2] + c[2], 16);
        b = parseInt(c[3] + c[3], 16);
    } else if (/^#[0-9a-f]{6}$/i.test(c)) {
        r = parseInt(c.slice(1, 3), 16);
        g = parseInt(c.slice(3, 5), 16);
        b = parseInt(c.slice(5, 7), 16);
    } else {
        return fallback;
    }

    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    if (d === 0) return fallback;

    let h: number;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;

    h = h * 60;
    if (h < 0) h += 360;
    return h;
}
