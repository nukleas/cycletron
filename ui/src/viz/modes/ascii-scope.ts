/**
 * ASCII SCOPE — a Lissajous-style phosphor scope that etches the bundled
 * ASCII artwork. The beam is the time-domain signal plotted against a delayed
 * copy of itself (delay re-picked each beat); wherever it passes it deposits
 * that cell's glyph onto a persistent etch layer that decays like CRT
 * phosphor. The image only exists where the music has recently drawn.
 * `atlas` holds one cell-sized sprite per glyph so splatting is drawImage,
 * not fillText. Etch layer + atlas live in device pixels (no transform).
 */

import artRaw from '../../assets/art.txt?raw';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {beatEnv} from '../util.js';

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

class AsciiScopeMode implements VizMode {
    private etch: HTMLCanvasElement | null = null;
    private etchCtx: CanvasRenderingContext2D | null = null;
    private atlas: HTMLCanvasElement | null = null;
    private spriteW = 0;
    private spriteH = 0;
    private box = {x: 0, y: 0, w: 0, h: 0};
    private cellW = 0;
    private cellH = 0;
    private offset = 48;
    private lastBeatIndex = -1;
    /**
     * Auto-gain peak tracker (byte deviation units, 8..128). Rises instantly
     * to the loudest sample, falls slowly — normalizes the beam so quiet
     * passages still sweep the whole portrait instead of a center blob.
     */
    private peak = 20;
    /** Seconds of continuous silence — drives the fade-out-then-clear. */
    private silence = 0;
    /** False while the signal is below the beam gate; render skips the trace. */
    private beamOn = false;

    layout(s: VizServices): void {
        if (s.width === 0 || s.height === 0) return;
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
        this.box = {
            x: (s.width - boxW) / 2,
            y: (s.height - boxH) / 2,
            w: boxW,
            h: boxH,
        };
        this.cellW = cellW;
        this.cellH = cellH;

        // Sprite atlas: one cell at full phosphor brightness per glyph, hue
        // drifting toward secondary with ink density so the portrait's
        // structure reads in two-tone neon as it gets etched.
        const sw = Math.max(1, Math.ceil(cellW * s.dpr));
        const sh = Math.max(1, Math.ceil(cellH * s.dpr));
        this.spriteW = sw;
        this.spriteH = sh;
        const atlas = document.createElement('canvas');
        atlas.width = sw * ART_GLYPHS.length;
        atlas.height = sh;
        const actx = atlas.getContext('2d')!;
        actx.font = `${(cellH * 0.92 * s.dpr).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
        actx.textAlign = 'center';
        actx.textBaseline = 'middle';
        for (let i = 0; i < ART_GLYPHS.length; i++) {
            const d = ART_DENSITY[ART_GLYPHS[i]];
            const hue = s.theme.neonHue + (s.theme.secondaryHue - s.theme.neonHue) * d * 0.7;
            actx.fillStyle = `hsl(${hue}, 80%, ${50 + d * 24}%)`;
            actx.fillText(ART_GLYPHS[i], (i + 0.5) * sw, sh * 0.52);
        }
        this.atlas = atlas;

        const etch = document.createElement('canvas');
        etch.width = Math.max(1, Math.ceil(boxW * s.dpr));
        etch.height = Math.max(1, Math.ceil(boxH * s.dpr));
        this.etch = etch;
        this.etchCtx = etch.getContext('2d')!;
    }

    update(dt: number, s: VizServices): void {
        if (!this.etchCtx) this.layout(s);
        const ectx = this.etchCtx;
        if (!ectx || !this.etch || !this.atlas) return;

        // Beam gate + auto-gain input — strided RMS and peak of the deviation
        // from center (128).
        let rms = 0;
        let maxDev = 0;
        if (s.timeData) {
            const td = s.timeData;
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
        this.peak = Math.min(128, Math.max(8, maxDev, this.peak - dt * 30));
        this.beamOn = rms >= 2.5;

        if (!this.beamOn) {
            // Silence: fade out fast, then hard-clear — destination-out
            // quantizes at low alpha and would otherwise leave a permanent
            // ghost hanging behind the editor.
            this.silence += dt;
            if (this.silence > 1.5) {
                ectx.clearRect(0, 0, this.etch.width, this.etch.height);
                return;
            }
            const fadeOut = 1 - Math.exp(-dt * 4);
            ectx.globalCompositeOperation = 'destination-out';
            ectx.fillStyle = `rgba(0, 0, 0, ${fadeOut.toFixed(4)})`;
            ectx.fillRect(0, 0, this.etch.width, this.etch.height);
            ectx.globalCompositeOperation = 'source-over';
            return;
        }
        this.silence = 0;

        // Phosphor decay — exponential, frame-rate independent.
        const fade = 1 - Math.exp(-dt * 1.5);
        ectx.globalCompositeOperation = 'destination-out';
        ectx.fillStyle = `rgba(0, 0, 0, ${fade.toFixed(4)})`;
        ectx.fillRect(0, 0, this.etch.width, this.etch.height);
        ectx.globalCompositeOperation = 'source-over';

        // Beat-switched delay offset — same topology trick as the Lissajous
        // scope: each beat the curve folds into a new figure.
        const beatIndex = Math.floor(s.cycle * 4);
        if (beatIndex !== this.lastBeatIndex) {
            this.lastBeatIndex = beatIndex;
            const choices = [24, 48, 64, 96, 128, 160];
            this.offset = choices[((beatIndex % choices.length) + choices.length) % choices.length];
        }

        const data = s.timeData!;
        const N = data.length;
        const off = this.offset;
        if (N < off + 8) return;

        const grid = getArtGrid();
        const beat = beatEnv(s.cycle * 4);
        const sw = this.spriteW;
        const sh = this.spriteH;
        const cellWDev = this.cellW * s.dpr;
        const cellHDev = this.cellH * s.dpr;
        const usable = N - off;
        const step = Math.max(1, Math.floor(usable / 600));
        const amp = 0.49;
        const norm = 1 / this.peak;

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
            ectx.drawImage(this.atlas, g * sw, 0, sw, sh,
                Math.round(c * cellWDev), Math.round(r * cellHDev), sw, sh);
        }
        ectx.globalAlpha = 1;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (!this.etch) return;

        const box = this.box;
        ctx.drawImage(this.etch, box.x, box.y, box.w, box.h);

        // Beam trace only while there's actually signal — a silent scope
        // shows nothing at all.
        if (!this.beamOn || !s.timeData) return;
        const data = s.timeData;
        const N = data.length;
        const off = this.offset;
        if (N < off + 8) return;

        const beat = beatEnv(s.cycle * 4);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const amp = 0.49;
        const norm = 1 / this.peak;
        const usable = N - off;
        const step = Math.max(2, Math.floor(usable / 300));

        ctx.strokeStyle = `hsla(${s.theme.neonHue}, 90%, 72%, ${(0.05 + beat * 0.07).toFixed(3)})`;
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
}

export const asciiScopeDef: VizModeDef = {
    id: 'ascii-scope',
    name: 'ASCII SCOPE',
    create: () => new AsciiScopeMode(),
};
