/**
 * PLASMA — metaballs as a flat contour map. Each ball contributes r²/d² to a
 * scalar field sampled on a small fixed grid (budgeted by cell count, so the
 * cost is the same in a sidebar pane and on a 4K stage); marching squares
 * turns three nested thresholds into flat, stacked bands with a fine outline
 * round the outermost. Where blobs fuse, the inner bands split along a smooth
 * dominance curve, so every track keeps its own colour inside the liquid.
 *
 *   scheduled track → one ball (accent colour, slot-seeded home + orbit),
 *                     fading in/out as the track appears/leaves
 *   onset           → the ball swells (fast attack, slow release; kicks most)
 *   pitched note    → steers the ball's height (C4 at home, higher rises)
 *   no pattern      → three theme-coloured balls drifting slowly, breathing
 *                     with the smoothed low / mid / high bands
 */

import {TrackModel, instrumentFamily} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {
    TAU, drawLabel, follow, hash32, mixRgb, rampAt, alphaRamp, rand01, rgbOf,
} from '../util.js';

const MAX_BALLS = 8;
/** Grid node budget — cols × rows ≈ this, shaped to the canvas aspect. */
const NODE_BUDGET = 4800;
const MAX_NODES = NODE_BUDGET * 2;
/** Field thresholds, outermost first. */
const LEVELS = [1.0, 1.7, 3.0];

/** Colour-cache keys for the idle balls (theme changes clear the cache). */
const IDLE_KEYS = ['idle-low', 'idle-mid', 'idle-high'];

function clampBand(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(1.2, v)) : 0;
}

class PlasmaMode implements VizMode {
    private readonly tracks = new TrackModel();
    private readonly field = new Float32Array(MAX_NODES);
    /** Per-ball contributions (ball-major) and the strongest one per node —
     *  they split the inner bands between the balls of a fused blob. */
    private readonly contrib = new Float32Array(MAX_NODES * MAX_BALLS);
    private readonly peak = new Float32Array(MAX_NODES);
    private readonly part = new Float32Array(MAX_NODES);
    private cols = 0;
    private rows = 0;
    private cellW = 0;
    private cellH = 0;
    private w = 0;
    private h = 0;
    private m = 0; // min(w, h)
    private u = 1;

    // Per-ball state (index = track slot % MAX_BALLS, or band index when idle).
    private readonly presence = new Float32Array(MAX_BALLS);
    private readonly swell = new Float32Array(MAX_BALLS);
    private readonly swellTarget = new Float32Array(MAX_BALLS);
    private readonly pitch = new Float32Array(MAX_BALLS);
    private readonly pitchTarget = new Float32Array(MAX_BALLS);
    private readonly bx = new Float32Array(MAX_BALLS); // px, this frame
    private readonly by = new Float32Array(MAX_BALLS);
    private readonly br = new Float32Array(MAX_BALLS);
    private readonly wanted = new Uint8Array(MAX_BALLS);
    private readonly ballKey: string[] = new Array(MAX_BALLS).fill('');
    private readonly ballName: string[] = new Array(MAX_BALLS).fill('');
    private readonly midCss: string[] = new Array(MAX_BALLS).fill('');
    private readonly coreCss: string[] = new Array(MAX_BALLS).fill('');

    private theme: Theme | null = null;
    private outerCss = '';
    private outlineCss = '';
    private labelRamp: string[] = [];
    /** Label placement scratch: per placed label (x, y, half width). */
    private readonly labelBoxes = new Float32Array(MAX_BALLS * 3);
    private readonly labelOrder: number[] = new Array<number>(MAX_BALLS).fill(0);
    private readonly byPresence = (a: number, b: number): number => this.presence[b] - this.presence[a];
    private t = 0;
    private readonly bands = new Float32Array(3);

    layout(s: VizServices): void {
        this.w = s.width;
        this.h = s.height;
        this.m = Math.min(s.width, s.height);
        this.u = Math.max(0.4, this.m / 720);
        if (s.width <= 0 || s.height <= 0) {
            this.cols = this.rows = 0;
            return;
        }
        const aspect = s.width / s.height;
        const cols = Math.max(8, Math.round(Math.sqrt(NODE_BUDGET * aspect)));
        const rows = Math.max(6, Math.round(NODE_BUDGET / cols));
        // Nodes = (cols+1)(rows+1); clamp to the preallocated grid.
        const scale = Math.min(1, Math.sqrt(MAX_NODES / ((cols + 1) * (rows + 1))));
        this.cols = Math.max(2, Math.floor(cols * scale));
        this.rows = Math.max(2, Math.floor(rows * scale));
        this.cellW = s.width / this.cols;
        this.cellH = s.height / this.rows;
        this.syncTheme(s.theme);
    }

    private syncTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        const neon = rgbOf(theme.neon, theme.textRgb);
        const o = mixRgb(theme.bgRgb, theme.bgLighterRgb, 0.9);
        this.outerCss = `rgb(${o[0]}, ${o[1]}, ${o[2]})`;
        this.outlineCss = `rgba(${neon[0]}, ${neon[1]}, ${neon[2]}, 0.7)`;
        this.labelRamp = alphaRamp(theme.textRgb, 16);
        this.ballKey.fill(''); // force colour rebuild against the new bg
    }

    /** Point a ball at a colour; mixes rebuild only when it changes. */
    private setBallColour(i: number, key: string, rgb: readonly [number, number, number]): void {
        if (this.ballKey[i] === key) return;
        this.ballKey[i] = key;
        const bg = this.theme!.bgRgb;
        const mid = mixRgb(bg, rgb, 0.4);
        const core = mixRgb(bg, rgb, 0.85);
        this.midCss[i] = `rgb(${mid[0]}, ${mid[1]}, ${mid[2]})`;
        this.coreCss[i] = `rgb(${core[0]}, ${core[1]}, ${core[2]})`;
    }

    update(dt: number, s: VizServices): void {
        this.syncTheme(s.theme);
        this.t += dt;
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, (track, e) => {
            const i = track.slot % MAX_BALLS;
            const fam = instrumentFamily(track.name);
            const hit = fam === 'kick' ? 1 : fam === 'snare' ? 0.7 : fam === 'hat' ? 0.3 : 0.55;
            this.swellTarget[i] = Math.max(this.swellTarget[i], hit);
            const note = track.notes[e];
            if (Number.isFinite(note)) this.pitchTarget[i] = Math.max(-1, Math.min(1, (note - 60) / 30));
        });
        this.tracks.decay(dt);

        this.bands[0] = follow(this.bands[0], clampBand(s.low), dt, 8, 3);
        this.bands[1] = follow(this.bands[1], clampBand(s.mid), dt, 8, 3);
        this.bands[2] = follow(this.bands[2], clampBand(s.high), dt, 8, 3);

        this.wanted.fill(0);
        const theme = this.theme!;
        if (sync.pattern && this.tracks.tracks.length > 0) {
            for (const track of this.tracks.tracks) {
                if (track.count === 0 && track.activity < 0.02) continue;
                const i = track.slot % MAX_BALLS;
                this.wanted[i] = 1;
                this.setBallColour(i, track.accentCss, track.accent);
                this.ballName[i] = track.name;
            }
        } else {
            const pool = theme.accentPool;
            for (let i = 0; i < 3; i++) {
                const rgb = pool[(i * 2) % pool.length] ?? theme.textRgb;
                this.wanted[i] = 1;
                this.setBallColour(i, IDLE_KEYS[i], rgb);
                this.ballName[i] = '';
            }
        }

        const m = this.m;
        for (let i = 0; i < MAX_BALLS; i++) {
            this.presence[i] = follow(this.presence[i], this.wanted[i], dt, 2.5, 1.5);
            this.swellTarget[i] *= Math.exp(-dt * 10);
            this.swell[i] = follow(this.swell[i], this.swellTarget[i], dt, 30, 5);
            this.pitch[i] = follow(this.pitch[i], this.pitchTarget[i], dt, 4, 4);

            // Stable seeded home and a slow elliptical orbit around it.
            const hx = 0.2 + rand01(hash32(i, 0x9a11)) * 0.6;
            const hy = 0.25 + rand01(hash32(i, 0x9a12)) * 0.5;
            const w0 = 0.08 + rand01(hash32(i, 0x9a13)) * 0.12;
            const ph = rand01(hash32(i, 0x9a14)) * TAU;
            const orbit = m * (0.06 + rand01(hash32(i, 0x9a15)) * 0.06);
            const a = this.t * w0 * (i % 2 === 0 ? 1 : -1) + ph;
            this.bx[i] = hx * this.w + Math.cos(a) * orbit * 1.4;
            this.by[i] = hy * this.h + Math.sin(a) * orbit - this.pitch[i] * this.h * 0.2;

            const idle = !sync.pattern && i < 3;
            const breath = idle ? this.bands[i] * 0.35 + Math.sin(this.t * 0.6 + ph) * 0.05 : 0;
            this.br[i] = m * 0.1 * this.presence[i] * (1 + this.swell[i] * 0.45 + breath);
        }
    }

    private evalField(): void {
        const {cols, rows, cellW, cellH} = this;
        const stride = cols + 1;
        const nodes = (rows + 1) * stride;
        for (let j = 0; j <= rows; j++) {
            const y = j * cellH;
            for (let k = 0; k <= cols; k++) {
                const x = k * cellW;
                const n = j * stride + k;
                let sum = 0, best = 0;
                for (let i = 0; i < MAX_BALLS; i++) {
                    const r = this.br[i];
                    let v = 0;
                    if (r >= 0.5) {
                        const dx = x - this.bx[i], dy = y - this.by[i];
                        v = (r * r) / (dx * dx + dy * dy + 1);
                    }
                    this.contrib[i * nodes + n] = v;
                    sum += v;
                    if (v > best) best = v;
                }
                this.field[n] = sum;
                this.peak[n] = best;
            }
        }
    }

    /**
     * Ball i's share of the fused field: the total, attenuated by how far i
     * is from dominating. Smooth, so the colour split inside a fused blob is
     * a clean curve rather than a staircase of grid cells.
     */
    private partition(i: number): Float32Array {
        const nodes = (this.rows + 1) * (this.cols + 1);
        const base = i * nodes;
        for (let n = 0; n < nodes; n++) {
            const peak = this.peak[n];
            const q = peak > 0 ? this.contrib[base + n] / peak : 0;
            const q2 = q * q;
            this.part[n] = this.field[n] * q2 * q2;
        }
        return this.part;
    }

    /**
     * Add the marching-squares polygons of `field` ≥ `level` to the current
     * path; fully-inside cells are merged into horizontal runs.
     */
    private fillLevel(ctx: CanvasRenderingContext2D, field: Float32Array, level: number): boolean {
        const {cols, rows, cellW, cellH} = this;
        const stride = cols + 1;
        let any = false;
        for (let j = 0; j < rows; j++) {
            let runStart = -1;
            const y0 = j * cellH;
            for (let k = 0; k <= cols; k++) {
                let full = false;
                if (k < cols) {
                    const n0 = j * stride + k;
                    const v0 = field[n0], v1 = field[n0 + 1];
                    const v2 = field[n0 + stride + 1], v3 = field[n0 + stride];
                    const inside = (v0 >= level ? 1 : 0) + (v1 >= level ? 1 : 0)
                        + (v2 >= level ? 1 : 0) + (v3 >= level ? 1 : 0);
                    full = inside === 4;
                    if (inside > 0 && !full) {
                        this.cellPolygon(ctx, k * cellW, y0, v0, v1, v2, v3, level);
                        any = true;
                    }
                }
                if (full && runStart < 0) runStart = k;
                if (!full && runStart >= 0) {
                    ctx.rect(runStart * cellW, y0, (k - runStart) * cellW, cellH);
                    runStart = -1;
                    any = true;
                }
            }
        }
        return any;
    }

    /** The cell square clipped to field ≥ level, walked tl → tr → br → bl. */
    private cellPolygon(
        ctx: CanvasRenderingContext2D, x: number, y: number,
        v0: number, v1: number, v2: number, v3: number, level: number,
    ): void {
        const cw = this.cellW, ch = this.cellH;
        this.started = false;
        // Corners in walk order with edge interpolation to the next corner.
        if (v0 >= level) this.pt(ctx, x, y);
        if ((v0 >= level) !== (v1 >= level)) this.pt(ctx, x + cw * (level - v0) / (v1 - v0), y);
        if (v1 >= level) this.pt(ctx, x + cw, y);
        if ((v1 >= level) !== (v2 >= level)) this.pt(ctx, x + cw, y + ch * (level - v1) / (v2 - v1));
        if (v2 >= level) this.pt(ctx, x + cw, y + ch);
        if ((v2 >= level) !== (v3 >= level)) this.pt(ctx, x + cw - cw * (level - v2) / (v3 - v2), y + ch);
        if (v3 >= level) this.pt(ctx, x, y + ch);
        if ((v3 >= level) !== (v0 >= level)) this.pt(ctx, x, y + ch - ch * (level - v3) / (v0 - v3));
        ctx.closePath();
    }

    private started = false;

    private pt(ctx: CanvasRenderingContext2D, x: number, y: number): void {
        if (this.started) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); this.started = true; }
    }

    /** Contour segments of `level` (exit crossing → next entry crossing). */
    private strokeLevel(ctx: CanvasRenderingContext2D, field: Float32Array, level: number): void {
        const {cols, rows, cellW: cw, cellH: ch} = this;
        const stride = cols + 1;
        const xs = this.crossX, ys = this.crossY;
        for (let j = 0; j < rows; j++) {
            const y = j * ch;
            for (let k = 0; k < cols; k++) {
                const n0 = j * stride + k;
                const v0 = field[n0], v1 = field[n0 + 1];
                const v2 = field[n0 + stride + 1], v3 = field[n0 + stride];
                const i0 = v0 >= level, i1 = v1 >= level, i2 = v2 >= level, i3 = v3 >= level;
                if (i0 === i1 && i1 === i2 && i2 === i3) continue;
                const x = k * cw;
                let c = 0;
                if (i0 !== i1) { xs[c] = x + cw * (level - v0) / (v1 - v0); ys[c++] = y; }
                if (i1 !== i2) { xs[c] = x + cw; ys[c++] = y + ch * (level - v1) / (v2 - v1); }
                if (i2 !== i3) { xs[c] = x + cw - cw * (level - v2) / (v3 - v2); ys[c++] = y + ch; }
                if (i3 !== i0) { xs[c] = x; ys[c++] = y + ch - ch * (level - v3) / (v0 - v3); }
                // Walk starts at corner 0: if it is inside, crossing 0 exits.
                const first = i0 ? 0 : 1;
                for (let p = 0; p < c; p += 2) {
                    const a = (first + p) % c, b = (first + p + 1) % c;
                    ctx.moveTo(xs[a], ys[a]);
                    ctx.lineTo(xs[b], ys[b]);
                }
            }
        }
    }

    private readonly crossX = new Float32Array(4);
    private readonly crossY = new Float32Array(4);

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.cols === 0 || this.w <= 0 || this.h <= 0) return;
        this.syncTheme(s.theme);
        this.evalField();
        ctx.save();

        // Outermost band: one neutral fill + fine neon contour.
        ctx.fillStyle = this.outerCss;
        ctx.beginPath();
        if (this.fillLevel(ctx, this.field, LEVELS[0])) ctx.fill();
        ctx.strokeStyle = this.outlineCss;
        ctx.lineWidth = Math.max(1, this.u * 1.2);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        this.strokeLevel(ctx, this.field, LEVELS[0]);
        ctx.stroke();

        // Inner bands, each ball's share of the field in its own accent.
        for (let l = 1; l < LEVELS.length; l++) {
            for (let i = 0; i < MAX_BALLS; i++) {
                if (this.br[i] < 0.5) continue;
                ctx.beginPath();
                if (!this.fillLevel(ctx, this.partition(i), LEVELS[l])) continue;
                ctx.fillStyle = l === 1 ? this.midCss[i] : this.coreCss[i];
                ctx.fill();
            }
        }

        // Track labels under each ball, most present first; a label that
        // would overlap one already placed is skipped rather than stacked.
        const size = Math.max(9, Math.min(11, 9 * this.u));
        const order = this.labelOrder;
        for (let i = 0; i < MAX_BALLS; i++) order[i] = i;
        order.sort(this.byPresence);
        let placed = 0;
        for (let k = 0; k < MAX_BALLS; k++) {
            const i = order[k];
            const name = this.ballName[i];
            if (!name || this.presence[i] < 0.3) continue;
            const halfW = name.length * size * 0.3 + size * 0.5;
            const x = this.bx[i];
            const y = this.by[i] + this.br[i] * 1.25 + size;
            let clear = true;
            for (let j = 0; j < placed && clear; j++) {
                const r = j * 3;
                clear = Math.abs(x - this.labelBoxes[r]) >= halfW + this.labelBoxes[r + 2]
                    || Math.abs(y - this.labelBoxes[r + 1]) >= size * 1.2;
            }
            if (!clear) continue;
            this.labelBoxes[placed * 3] = x;
            this.labelBoxes[placed * 3 + 1] = y;
            this.labelBoxes[placed * 3 + 2] = halfW;
            placed++;
            drawLabel(ctx, name.toUpperCase(), x, y,
                rampAt(this.labelRamp, 0.45 * this.presence[i]), size, 'center');
        }
        ctx.restore();
    }
}

export const plasmaDef: VizModeDef = {
    id: 'plasma',
    name: 'PLASMA',
    create: () => new PlasmaMode(),
};
