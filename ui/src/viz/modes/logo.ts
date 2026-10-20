/**
 * LOGO — the Cycletron icon and wordmark drawn in ASCII, playing the music.
 * The icon's parts keep their roles: the screen is a spectrum, the antennae
 * light on the drums, the grille reads the three bands.
 *
 * Mapping:
 *   FFT bands         → the screen's bars, mirrored about its centre line
 *   kick / snare haps → the left / right antenna tip flares
 *   low / mid / high  → the three grille lines
 *   high energy       → glyphs in the wordmark flicker and re-settle
 *   silence           → a low pilot level in every bar, so the logo still reads
 *
 * The geometry is a grid of glyph cells laid out once per resize: each cell
 * knows its part of the logo and its static glyph (edges pick `- | / \` from
 * the outline's direction). A frame only re-weights the moving parts. Glyph
 * sprites come from an atlas, one row per colour.
 */

import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {MONO_FONT, follow, hash32, mixRgb, rand01, rgbOf} from '../util.js';
import {SpectrumSampler} from './flame-graph/spectrum.js';

const GLYPHS = [' ', '.', ':', '-', '=', '+', '|', '/', '\\', 'x', 'X', '$', '&', '#', '@', 'o', '*'] as const;
const G = Object.fromEntries(GLYPHS.map((g, i) => [g, i])) as Record<(typeof GLYPHS)[number], number>;
/** Ink ramp for the wordmark, by coverage. */
const RAMP = [G['.'], G[':'], G['+'], G['x'], G['X'], G['$'], G['&'], G['#']];

/** Colour rows of the atlas. WORD..WORD+3 run neon → secondary across the wordmark. */
const EDGE = 0, DIM = 1, NEON = 2, PINK = 3, WHITE = 4, WORD = 5;
const COLORS = 9;

/** What a cell belongs to. */
const NONE = 0, HALO = 1, BODY = 2, FILL = 3, SCREEN = 4, BAR = 5, GRILLE_BOX = 6, GRILLE = 7, STEM = 8, TIP = 9, WORDMARK = 10;

/** Rows of glyph cells down the frame; a cell is 0.6 as wide as it is tall. */
const ROWS = 72;
/** Body side against the frame height, and its centre. */
const BODY_SIDE = 0.3;
const BODY_Y = 0.41;
const WORD_TOP = 0.6;
const WORD_ROWS = 13;
/** A wide, open bold face: its letters survive a dozen rows of glyphs. */
const WORD_FONT = "Verdana, 'DejaVu Sans', sans-serif";
/** Pilot bar level, so a silent screen isn't empty. */
const PILOT = 0.08;

/** Signed distance to a rounded box centred on the origin. */
function roundBox(x: number, y: number, hw: number, hh: number, r: number): number {
    const qx = Math.abs(x) - hw + r;
    const qy = Math.abs(y) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** The outline glyph for an edge whose outward normal is (nx, ny), y down. */
function edgeGlyph(nx: number, ny: number): number {
    const len = Math.hypot(nx, ny) || 1;
    const ax = Math.abs(nx / len), ay = Math.abs(ny / len);
    if (ay > 0.9) return G['-'];
    if (ax > 0.9) return G['|'];
    return nx * ny > 0 ? G['/'] : G['\\'];
}

class LogoMode implements VizMode {
    private readonly tracks = new TrackModel();
    private sampler: SpectrumSampler | null = null;
    private target = new Float32Array(0);
    private levels = new Float32Array(0);
    private kick = 0;
    private snare = 0;
    private low = 0;
    private mid = 0;
    private high = 0;

    // Cell grid.
    private cols = 0;
    private rows = 0;
    private cellW = 0;
    private cellH = 0;
    private x0 = 0;
    private kind = new Uint8Array(0);
    private glyph = new Uint8Array(0);
    private color = new Uint8Array(0);
    /** Static weight 0..1: edge strength, wordmark coverage, halo falloff. */
    private weight = new Float32Array(0);
    /** BAR: the bar index; GRILLE: the line; TIP: the antenna. */
    private aux = new Int16Array(0);
    /** BAR: distance from the screen's centre line, 0..1. */
    private span = new Float32Array(0);
    private bars = 0;

    private atlas: HTMLCanvasElement | null = null;
    private spriteW = 0;
    private spriteH = 0;
    private atlasKey = '';

    layout(s: VizServices): void {
        if (s.width === 0 || s.height === 0) return;
        const ch = s.height / ROWS;
        const cw = ch * 0.6;
        this.cellH = ch;
        this.cellW = cw;
        this.rows = ROWS;
        this.cols = Math.floor(s.width / cw);
        this.x0 = (s.width - this.cols * cw) / 2;
        this.buildCells(s);
        this.buildAtlas(s);
    }

    private buildCells(s: VizServices): void {
        const {cols, rows, cellW: cw, cellH: ch} = this;
        const n = cols * rows;
        this.kind = new Uint8Array(n);
        this.glyph = new Uint8Array(n);
        this.color = new Uint8Array(n);
        this.weight = new Float32Array(n);
        this.aux = new Int16Array(n);
        this.span = new Float32Array(n);

        // The icon, in units of its body side, centred on the body.
        const side = Math.min(s.height * BODY_SIDE, s.width * 0.5);
        const cx = s.width / 2;
        const cy = s.height * BODY_Y;
        const ux = (c: number): number => (this.x0 + (c + 0.5) * cw - cx) / side;
        const uy = (r: number): number => ((r + 0.5) * ch - cy) / side;
        type Shape = (x: number, y: number) => number;
        const body: Shape = (x, y) => roundBox(x, y, 0.5, 0.5, 0.13);
        const screen: Shape = (x, y) => roundBox(x, y + 0.165, 0.36, 0.135, 0.06);
        // The grille: three lines two rows apart, its box a row and a half outside them.
        const grilleRow = Math.round((cy + 0.2 * side) / ch - 0.5);
        const grilleY = uy(grilleRow);
        const grille: Shape = (x, y) => roundBox(x, y - grilleY, 0.29, (3.6 * ch) / side, 0.03);
        const lines = [grilleRow - 2, grilleRow, grilleRow + 2];
        const antennae = [-0.36, 0.36];
        const tipY = -0.64;
        /** Inside the shape with a neighbour outside it: the outline's cell. */
        const outline = (f: Shape, c: number, r: number): boolean =>
            f(ux(c), uy(r)) < 0
            && (f(ux(c - 1), uy(r)) >= 0 || f(ux(c + 1), uy(r)) >= 0 || f(ux(c), uy(r - 1)) >= 0 || f(ux(c), uy(r + 1)) >= 0);
        const normal = (f: Shape, x: number, y: number): number => {
            const e = 0.004;
            return edgeGlyph(f(x + e, y) - f(x - e, y), f(x, y + e) - f(x, y - e));
        };

        // Screen columns: bars on alternate columns, inset from its outline.
        let firstCol = -1, lastCol = -1;
        const screenRow = Math.round((cy - 0.165 * side) / ch - 0.5);
        for (let c = 0; c < cols; c++) {
            if (screen(ux(c), uy(screenRow)) < 0 && !outline(screen, c, screenRow)) {
                if (firstCol < 0) firstCol = c + 1;
                lastCol = c - 1;
            }
        }
        lastCol -= (lastCol - firstCol) % 2;
        this.bars = Math.max(1, Math.floor((lastCol - firstCol) / 2) + 1);
        if (this.levels.length !== this.bars) {
            this.sampler = new SpectrumSampler(this.bars);
            this.target = new Float32Array(this.bars);
            this.levels = new Float32Array(this.bars);
        }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const x = ux(c);
                const y = uy(r);
                const set = (kind: number, glyph: number, color: number, weight: number): void => {
                    this.kind[i] = kind;
                    this.glyph[i] = glyph;
                    this.color[i] = color;
                    this.weight[i] = weight;
                };

                // Antennae: a tip above each top corner, on a one-column stem.
                let placed = false;
                for (let a = 0; a < 2; a++) {
                    const dx = (x - antennae[a]) * side;
                    const tip = Math.hypot(dx, (y - tipY) * side) / ch;
                    if (tip < 1.6) {
                        set(TIP, tip < 0.6 ? G['@'] : G['o'], PINK, 1 - tip / 1.6);
                        this.aux[i] = a;
                        placed = true;
                    } else if (Math.abs(dx) < cw * 0.5 && y > tipY && y < 0 && body(x, y) >= 0) {
                        set(STEM, G['|'], DIM, 0.8);
                        placed = true;
                    }
                }
                if (placed) continue;

                const d = body(x, y);
                if (d >= 0) {
                    // A faint halo outside the body, like the icon's glow.
                    const out = (d * side) / ch;
                    if (out < 1.6) set(HALO, G[':'], WHITE, 0.14 * (1 - out / 1.6));
                    continue;
                }
                if (outline(body, c, r)) {
                    set(BODY, normal(body, x, y), EDGE, 0.9);
                    continue;
                }
                if (outline(screen, c, r)) {
                    set(SCREEN, normal(screen, x, y), NEON, 0.95);
                    continue;
                }
                if (screen(x, y) < 0) {
                    const bar = c - firstCol;
                    if (bar >= 0 && c <= lastCol && bar % 2 === 0) {
                        set(BAR, G['#'], NEON, 1);
                        this.aux[i] = bar / 2;
                        // 0 on the centre line, 1 at the screen's inner edge.
                        this.span[i] = Math.abs(y + 0.165) * side / (0.135 * side - ch);
                    } else if (r % 2 === 0) {
                        set(FILL, G['.'], NEON, 0.08);
                    }
                    continue;
                }
                if (outline(grille, c, r)) {
                    set(GRILLE_BOX, normal(grille, x, y), DIM, 0.7);
                    continue;
                }
                const line = lines.indexOf(r);
                if (grille(x, y) < 0 && line >= 0 && !outline(grille, c - 1, r) && !outline(grille, c + 1, r)) {
                    set(GRILLE, G['='], PINK, 1);
                    this.aux[i] = line;
                    continue;
                }

                // The body's own surface: a sparse, still texture.
                if (rand01(hash32(c, r)) < 0.07) set(FILL, G['.'], DIM, 0.35);
            }
        }

        this.buildWordmark(s);
    }

    /** CYCLETRON in a heavy face, rasterised to coverage per cell. */
    private buildWordmark(s: VizServices): void {
        const {cols, cellW: cw, cellH: ch} = this;
        const top = Math.round((s.height * WORD_TOP) / ch);
        const over = 6;
        const canvas = document.createElement('canvas');
        canvas.width = cols * over;
        canvas.height = WORD_ROWS * over;
        const g = canvas.getContext('2d', {willReadFrequently: true})!;
        // Draw in frame pixels; the canvas holds `over`² samples per cell.
        g.setTransform(over / cw, 0, 0, over / ch, 0, 0);
        const size = WORD_ROWS * ch * 0.95;
        g.font = `700 ${size}px ${WORD_FONT}`;
        const fit = Math.min(1, (cols * cw * 0.6) / g.measureText('CYCLETRON').width);
        g.font = `700 ${size * fit}px ${WORD_FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = '#fff';
        g.fillText('CYCLETRON', (cols * cw) / 2, (WORD_ROWS * ch) / 2);
        const px = g.getImageData(0, 0, canvas.width, canvas.height).data;

        let left = cols, right = 0;
        const cover = new Float32Array(cols * WORD_ROWS);
        for (let r = 0; r < WORD_ROWS; r++) {
            for (let c = 0; c < cols; c++) {
                let sum = 0;
                for (let y = 0; y < over; y++) {
                    for (let x = 0; x < over; x++) sum += px[((r * over + y) * canvas.width + c * over + x) * 4 + 3];
                }
                const v = sum / (over * over * 255);
                cover[r * cols + c] = v;
                if (v > 0.08) {
                    left = Math.min(left, c);
                    right = Math.max(right, c);
                }
            }
        }
        for (let r = 0; r < WORD_ROWS; r++) {
            for (let c = 0; c < cols; c++) {
                const v = cover[r * cols + c];
                if (v <= 0.08 || top + r >= this.rows) continue;
                const i = (top + r) * cols + c;
                this.kind[i] = WORDMARK;
                // Solid strokes, with lighter glyphs only where a stroke's edge cuts the cell.
                this.glyph[i] = v > 0.6 ? G['#'] : RAMP[Math.min(RAMP.length - 1, Math.floor(v * 1.6 * RAMP.length))];
                this.weight[i] = v;
                this.color[i] = WORD + Math.round(((c - left) / Math.max(1, right - left)) * 3);
            }
        }
    }

    private buildAtlas(s: VizServices): void {
        const t = s.theme;
        const sw = Math.max(1, Math.ceil(this.cellW * s.dpr));
        const sh = Math.max(1, Math.ceil(this.cellH * s.dpr));
        const key = `${sw}x${sh}:${t.neon}:${t.neonSecondary}:${t.textRgb.join()}`;
        if (key === this.atlasKey) return;
        this.atlasKey = key;
        this.spriteW = sw;
        this.spriteH = sh;
        const neon = rgbOf(t.neon, [71, 246, 255]);
        const pink = rgbOf(t.neonSecondary, [255, 43, 214]);
        const colors: [number, number, number][] = [
            mixRgb(t.textRgb, [255, 255, 255], 0.35),
            t.borderRgb,
            neon,
            pink,
            [255, 255, 255],
            ...[0, 1, 2, 3].map((k) => mixRgb(mixRgb(neon, [255, 255, 255], 0.25), pink, k / 3)),
        ];
        const atlas = document.createElement('canvas');
        atlas.width = sw * GLYPHS.length;
        atlas.height = sh * COLORS;
        const a = atlas.getContext('2d')!;
        a.font = `700 ${(sh * 0.9).toFixed(2)}px ${MONO_FONT}`;
        a.textAlign = 'center';
        a.textBaseline = 'middle';
        for (let k = 0; k < COLORS; k++) {
            const [r, g, b] = colors[k];
            a.fillStyle = `rgb(${r}, ${g}, ${b})`;
            // Neon rows glow; the body's own lines stay crisp.
            a.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
            a.shadowBlur = k === EDGE || k === DIM ? 0 : sh * 0.35;
            for (let gi = 1; gi < GLYPHS.length; gi++) a.fillText(GLYPHS[gi], (gi + 0.5) * sw, (k + 0.54) * sh);
        }
        this.atlas = atlas;
    }

    private readonly onOnset = (track: VizTrack): void => {
        const family = instrumentFamily(track.name);
        if (family === 'kick') this.kick = 1;
        else if (family === 'snare') this.snare = 1;
    };

    update(dt: number, s: VizServices): void {
        if (!this.atlas) this.layout(s);
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
        this.kick *= Math.exp(-dt * 5);
        this.snare *= Math.exp(-dt * 5);
        this.low = follow(this.low, s.low, dt, 25, 5);
        this.mid = follow(this.mid, s.mid, dt, 25, 5);
        this.high = follow(this.high, s.high, dt, 25, 5);

        if (this.sampler && s.freqData && s.freqData.length >= 8) {
            this.sampler.sample(s.freqData, s.sampleRate, s.sensitivity, this.target);
        } else {
            this.target.fill(0);
        }
        for (let b = 0; b < this.bars; b++) {
            this.levels[b] = follow(this.levels[b], Math.max(PILOT, Math.min(1, this.target[b] * 1.15)), dt, 30, 7);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const atlas = this.atlas;
        if (!atlas) return;
        const {cols, rows, cellW: cw, cellH: ch, spriteW: sw, spriteH: sh} = this;
        const grille = [this.low, this.mid, this.high];
        const tips = [this.kick, this.snare];
        // Wordmark flicker: a fresh draw of cells each sixteenth.
        const tick = Math.floor(s.cycle * 16);
        const flicker = 0.01 + this.high * 0.12;

        ctx.save();
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const i = r * cols + c;
                const kind = this.kind[i];
                if (kind === NONE) continue;
                let glyph = this.glyph[i];
                let alpha = this.weight[i];
                switch (kind) {
                    case BAR: {
                        const level = this.levels[this.aux[i]];
                        const span = this.span[i];
                        if (span > level) continue;
                        glyph = span > level - 0.18 ? G['+'] : G['#'];
                        alpha = 0.55 + 0.45 * level;
                        break;
                    }
                    case GRILLE:
                        alpha = 0.3 + 0.7 * Math.min(1, grille[this.aux[i]] * 1.4);
                        break;
                    case TIP: {
                        const flare = tips[this.aux[i]];
                        alpha = Math.min(1, (0.35 + 0.65 * flare) * (0.4 + alpha));
                        if (flare > 0.5 && glyph === G['o']) glyph = G['*'];
                        break;
                    }
                    case WORDMARK: {
                        const h = rand01(hash32(i, tick));
                        if (h < flicker * alpha) glyph = RAMP[Math.floor(rand01(hash32(tick, i)) * RAMP.length)];
                        alpha = Math.min(1, 0.45 + 0.55 * alpha + this.kick * 0.15);
                        break;
                    }
                    case FILL:
                        alpha *= 1 + this.low;
                        break;
                }
                ctx.globalAlpha = alpha;
                ctx.drawImage(atlas, glyph * sw, this.color[i] * sh, sw, sh, this.x0 + c * cw, r * ch, cw, ch);
            }
        }
        ctx.restore();
    }
}

export const logoDef: VizModeDef = {
    id: 'logo',
    name: 'LOGO',
    create: () => new LogoMode(),
};
