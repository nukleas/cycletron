/**
 * ASCII SCOPE — a phase-plot phosphor scope that etches the bundled ASCII
 * artwork. The beam is the signal plotted against a delayed copy of itself;
 * wherever it passes it deposits that cell's glyph onto a persistent etch
 * layer that decays like CRT phosphor, so the portrait only exists where the
 * music has recently drawn.
 *
 *   beam signal   → ScopeSignal: the analyser's waveform while it moves; when
 *                   it stalls (WebKit #80) but a pattern plays, a waveform
 *                   rebuilt from the schedule — pitches from the sounding
 *                   notes, amplitude from each track's onset envelope.
 *   delay offset  → switched on every beat from a fixed table, bar-aligned,
 *                   so each beat folds the curve into a new figure.
 *   splat bright  → scheduled onsets (FFT transients with no pattern).
 *   beam gate     → signal RMS against a sensitivity-scaled threshold.
 *   idle          → the whole portrait at ~4% plus a slow 3:2 reference beam
 *                   tracing it, so the scope is never blank.
 *
 * `atlas` holds one cell-sized sprite per glyph so splatting is drawImage,
 * not fillText. Etch layer, ghost and atlas live in device pixels.
 */

import artRaw from '../../assets/art.txt?raw';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel} from '../tracks.js';
import {
    MONO_FONT, TAU, TransientDetector, alphaRamp, drawLabel, follow, mixRgb, rampAt, rgbOf,
} from '../util.js';
import {ScopeSignal} from './scope/signal.js';

/**
 * Glyph ramp of the ASCII artwork, ascending ink coverage. Index = sprite
 * column in the atlas; density drives sprite colour (denser = more secondary).
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

/** Delay offsets (samples), one per beat; odd bars use the second row. */
const OFFSETS = [24, 64, 128, 48, 96, 160, 32, 112] as const;
/** Deposited alpha is quantized, so fade in chunks at least this large —
 *  smaller destination-out steps round to nothing and leave a residue. */
const MIN_FADE_STEP = 0.1;
/** Phosphor decay rate (1/s). */
const DECAY = 1.5;
/** Beam extent as a fraction of the art box, per side. */
const AMP = 0.49;
/** Ghost portrait alpha — always visible, so the idle scope is never blank. */
const GHOST_ALPHA = 0.04;
/** Idle reference beam: 3:2 figure, one loop per this many seconds. */
const IDLE_LOOP_SECONDS = 6;
/** Idle figure extent — inside the overscanned box so it stays on screen. */
const IDLE_AMP = 0.75;

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

class AsciiScopeMode implements VizMode {
    private etch: HTMLCanvasElement | null = null;
    private etchCtx: CanvasRenderingContext2D | null = null;
    private ghost: HTMLCanvasElement | null = null;
    private atlas: HTMLCanvasElement | null = null;
    private spriteW = 0;
    private spriteH = 0;
    private readonly box = {x: 0, y: 0, w: 0, h: 0};
    private cellW = 0;
    private cellH = 0;
    private lineWidth = 1;
    /** Layout key — the atlas and ghost only rebuild when it changes. */
    private layoutKey = '';
    private beamRamp: string[] = [];
    private labelColor = '';

    private readonly tracks = new TrackModel();
    private readonly signal = new ScopeSignal();
    private readonly transients = new TransientDetector(0.12, 0.1, 0.08);
    private offset: number = OFFSETS[0];
    /**
     * Auto-gain peak follower (signal units). Rises fast to the loudest
     * sample, falls slowly — normalizes the beam so quiet passages still
     * sweep the whole portrait instead of a center blob.
     */
    private peak = 0.15;
    /** Onset flash — scheduled onsets bump it, exponential decay. */
    private flash = 0;
    /** Etch fade owed but not yet applied (see MIN_FADE_STEP). */
    private pendingFade = 0;
    /** Reference-beam parameter while idle, radians. */
    private idleT = 0;
    private beamOn = false;

    private readonly onOnset = (): void => {
        this.flash = 1;
    };

    layout(s: VizServices): void {
        if (!(s.width > 0 && s.height > 0)) return;
        const grid = getArtGrid();
        if (grid.rows === 0 || grid.cols === 0) return;

        // Monospace cell aspect (advance width / line height) as the art
        // would read in an editor — keeps the image proportions intact.
        const CHAR_ASPECT = 0.52;
        // Overscan past the contain fit so the portrait dominates the screen;
        // centered, so the overflow crops equally on opposite edges. Capped
        // at cover-fit — no point growing past filling the whole canvas.
        const GROW = 1.6;
        const containCellH = Math.min(s.height / grid.rows, s.width / (grid.cols * CHAR_ASPECT));
        const coverCellH = Math.max(s.height / grid.rows, s.width / (grid.cols * CHAR_ASPECT));
        const cellH = Math.min(containCellH * GROW, coverCellH);
        const cellW = cellH * CHAR_ASPECT;
        const boxW = cellW * grid.cols;
        const boxH = cellH * grid.rows;
        this.box.x = (s.width - boxW) / 2;
        this.box.y = (s.height - boxH) / 2;
        this.box.w = boxW;
        this.box.h = boxH;
        this.cellW = cellW;
        this.cellH = cellH;
        const u = Math.min(s.width, s.height) / 720;
        this.lineWidth = Math.min(2, Math.max(1, u));

        const t = s.theme;
        const neon = rgbOf(t.neon, [71, 246, 255]);
        const secondary = rgbOf(t.neonSecondary, [255, 43, 214]);
        this.beamRamp = alphaRamp(neon, 32);
        this.labelColor = rampAt(alphaRamp(t.textRgb, 16), 0.4);

        const sw = Math.max(1, Math.ceil(cellW * s.dpr));
        const sh = Math.max(1, Math.ceil(cellH * s.dpr));
        const key = `${sw}x${sh}:${t.neon}:${t.neonSecondary}`;
        if (key !== this.layoutKey) {
            this.layoutKey = key;
            this.spriteW = sw;
            this.spriteH = sh;
            this.atlas = this.buildAtlas(sw, sh, cellH * s.dpr, neon, secondary);
            this.ghost = this.buildGhost(grid, sw, sh, cellW * s.dpr, cellH * s.dpr);
        }

        // Resize keeps what's etched: the old layer is scaled into the new.
        const ew = Math.max(1, Math.ceil(boxW * s.dpr));
        const eh = Math.max(1, Math.ceil(boxH * s.dpr));
        if (!this.etch || this.etch.width !== ew || this.etch.height !== eh) {
            const etch = document.createElement('canvas');
            etch.width = ew;
            etch.height = eh;
            const ectx = etch.getContext('2d')!;
            if (this.etch) ectx.drawImage(this.etch, 0, 0, ew, eh);
            this.etch = etch;
            this.etchCtx = ectx;
        }
    }

    /** One cell sprite per glyph, blending neon → secondary with ink density
     *  so the portrait's structure reads in two-tone neon as it's etched. */
    private buildAtlas(
        sw: number, sh: number, fontPx: number,
        neon: [number, number, number], secondary: [number, number, number],
    ): HTMLCanvasElement {
        const atlas = document.createElement('canvas');
        atlas.width = sw * ART_GLYPHS.length;
        atlas.height = sh;
        const actx = atlas.getContext('2d')!;
        actx.font = `${(fontPx * 0.92).toFixed(2)}px ${MONO_FONT}`;
        actx.textAlign = 'center';
        actx.textBaseline = 'middle';
        for (let i = 0; i < ART_GLYPHS.length; i++) {
            const c = mixRgb(neon, secondary, ART_DENSITY[ART_GLYPHS[i]] * 0.7);
            actx.fillStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
            actx.fillText(ART_GLYPHS[i], (i + 0.5) * sw, sh * 0.52);
        }
        return atlas;
    }

    /** The complete portrait, shown faintly underneath the etch. */
    private buildGhost(grid: ArtGrid, sw: number, sh: number, cellWDev: number, cellHDev: number): HTMLCanvasElement {
        const ghost = document.createElement('canvas');
        ghost.width = Math.max(1, Math.ceil(cellWDev * grid.cols));
        ghost.height = Math.max(1, Math.ceil(cellHDev * grid.rows));
        const gctx = ghost.getContext('2d')!;
        for (let r = 0; r < grid.rows; r++) {
            for (let c = 0; c < grid.cols; c++) {
                const g = grid.glyph[r * grid.cols + c];
                if (g < 0) continue;
                gctx.drawImage(this.atlas!, g * sw, 0, sw, sh,
                    Math.round(c * cellWDev), Math.round(r * cellHDev), sw, sh);
            }
        }
        return ghost;
    }

    update(dt: number, s: VizServices): void {
        if (!this.etchCtx) this.layout(s);
        const ectx = this.etchCtx;
        if (!ectx || !this.etch || !this.atlas) return;

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
        const scheduled = sync.pattern !== null;
        if (!scheduled) {
            const hits = this.transients.update(dt, s.low, s.mid, s.high);
            if (hits.kick || hits.snare) this.flash = 1;
            else if (hits.hat) this.flash = Math.max(this.flash, 0.5);
        }
        this.flash *= Math.exp(-dt * 7);

        const sig = this.signal;
        sig.update(dt, s, this.tracks.tracks, sync.phase, scheduled);
        // Sensitivity-aware gate: higher sensitivity lets quieter signal draw.
        const gate = 0.02 / Math.max(0.3, s.sensitivity);
        this.beamOn = sig.source !== 'idle' && sig.rms >= gate;
        // Fast attack, slow release so the scale doesn't pump; the floor
        // keeps a whisper from being amplified into a full-screen scribble.
        if (this.beamOn) this.peak = follow(this.peak, Math.max(0.06, sig.peak), dt, 30, 0.6);

        // Phosphor decay — exponential, frame-rate independent, applied in
        // chunks large enough to survive 8-bit alpha rounding.
        this.pendingFade += dt;
        const fade = 1 - Math.exp(-this.pendingFade * DECAY);
        if (fade >= MIN_FADE_STEP) {
            this.pendingFade = 0;
            ectx.globalCompositeOperation = 'destination-out';
            ectx.globalAlpha = fade;
            ectx.fillStyle = '#000';
            ectx.fillRect(0, 0, this.etch.width, this.etch.height);
            ectx.globalCompositeOperation = 'source-over';
            ectx.globalAlpha = 1;
        }

        // Beat-switched delay: each beat folds the curve into a new figure.
        const beat = Math.floor(s.cycle * 4);
        const bar = Math.floor(s.cycle);
        const beatInBar = ((beat % 4) + 4) % 4;
        this.offset = OFFSETS[(bar & 1) * 4 + beatInBar];

        if (this.beamOn) this.etchSignal(ectx, s);
        else this.etchIdle(ectx, dt, s);
    }

    private etchSignal(ectx: CanvasRenderingContext2D, s: VizServices): void {
        const sig = this.signal;
        const data = sig.data;
        const off = this.offset;
        const usable = sig.length - off;
        if (usable < 8) return;

        const grid = getArtGrid();
        const step = Math.max(1, Math.floor(usable / 600));
        const norm = 1 / this.peak;
        const cellWDev = this.cellW * s.dpr;
        const cellHDev = this.cellH * s.dpr;
        // Kept well under 1.0 so the etch reads as a glow behind the editor
        // rather than competing with the code for attention.
        ectx.globalAlpha = 0.3 + this.flash * 0.25;
        let lastCell = -1;
        for (let i = 0; i < usable; i += step) {
            const x = Math.max(-1, Math.min(1, data[i] * norm));
            const y = Math.max(-1, Math.min(1, data[i + off] * norm));
            lastCell = this.splat(ectx, grid, x, y, lastCell, cellWDev, cellHDev);
        }
        ectx.globalAlpha = 1;
    }

    /** Idle: a slow 3:2 reference beam, a comet of phosphor tracing the art. */
    private etchIdle(ectx: CanvasRenderingContext2D, dt: number, s: VizServices): void {
        const t0 = this.idleT;
        const span = (TAU / IDLE_LOOP_SECONDS) * dt;
        this.idleT = (t0 + span) % (TAU * 64);
        const grid = getArtGrid();
        const cellWDev = this.cellW * s.dpr;
        const cellHDev = this.cellH * s.dpr;
        const drift = t0 * 0.05;
        ectx.globalAlpha = 0.24;
        let lastCell = -1;
        const SAMPLES = 24;
        for (let k = 0; k <= SAMPLES; k++) {
            const t = t0 + (span * k) / SAMPLES;
            lastCell = this.splat(ectx, grid, IDLE_AMP * Math.sin(3 * t + drift), IDLE_AMP * Math.sin(2 * t),
                lastCell, cellWDev, cellHDev);
        }
        ectx.globalAlpha = 1;
    }

    /** Stamp the glyph under beam position (x, y ∈ -1..1); returns its cell. */
    private splat(
        ectx: CanvasRenderingContext2D, grid: ArtGrid, x: number, y: number,
        lastCell: number, cellWDev: number, cellHDev: number,
    ): number {
        const c = Math.floor((0.5 + x * AMP) * grid.cols);
        const r = Math.floor((0.5 + y * AMP) * grid.rows);
        if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return lastCell;
        const cell = r * grid.cols + c;
        if (cell === lastCell) return cell;
        const g = grid.glyph[cell];
        if (g >= 0) {
            ectx.drawImage(this.atlas!, g * this.spriteW, 0, this.spriteW, this.spriteH,
                Math.round(c * cellWDev), Math.round(r * cellHDev), this.spriteW, this.spriteH);
        }
        return cell;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (!this.etch) return;
        const box = this.box;
        ctx.save();
        if (this.ghost) {
            ctx.globalAlpha = GHOST_ALPHA;
            ctx.drawImage(this.ghost, box.x, box.y, box.w, box.h);
            ctx.globalAlpha = 1;
        }
        ctx.drawImage(this.etch, box.x, box.y, box.w, box.h);

        const sig = this.signal;
        if (this.beamOn) {
            const data = sig.data;
            const off = this.offset;
            const usable = sig.length - off;
            if (usable >= 8) {
                const cx = box.x + box.w / 2;
                const cy = box.y + box.h / 2;
                const norm = 1 / this.peak;
                const step = Math.max(2, Math.floor(usable / 300));
                ctx.strokeStyle = rampAt(this.beamRamp, 0.05 + this.flash * 0.07);
                ctx.lineWidth = this.lineWidth;
                ctx.lineJoin = 'round';
                ctx.beginPath();
                for (let i = 0; i < usable; i += step) {
                    const x = cx + Math.max(-1, Math.min(1, data[i] * norm)) * AMP * box.w;
                    const y = cy + Math.max(-1, Math.min(1, data[i + off] * norm)) * AMP * box.h;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
        }

        // Say so when the beam is being rebuilt from the schedule.
        if (sig.source === 'synthetic' && s.width >= 240) {
            const pad = Math.max(10, Math.min(s.width, s.height) * 0.025);
            drawLabel(ctx, 'SCOPE · FROM SCHEDULE', pad, s.height - pad, this.labelColor, 10);
        }
        ctx.restore();
    }
}

export const asciiScopeDef: VizModeDef = {
    id: 'ascii-scope',
    name: 'ASCII SCOPE',
    create: () => new AsciiScopeMode(),
};
