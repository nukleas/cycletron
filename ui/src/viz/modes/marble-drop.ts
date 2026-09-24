/**
 * MARBLE DROP — a Galton board played by the schedule. Every scheduled hap
 * drops a marble into the peg field; it rattles down and lands in the bins at
 * the bottom, which fill into a slowly draining histogram of where the music
 * fell.
 *
 * Mapping:
 *   track           → a lane across the top (labelled), marble in its accent
 *   hap onset       → one marble, dropped on the exact scheduled onset
 *   pitch           → offset within the lane (melodies spread the drop) and
 *                     size (low notes heavy, high notes small)
 *   drum family     → size: kick largest, then snare, perc, hat
 *   no pattern      → FFT transients drop marbles instead (kick left, snare
 *                     centre, hat right) — the board is never driven by a
 *                     synthetic beat
 *
 * Physics runs in CSS px with gravity, drag and sizes scaled to the canvas,
 * in 2–4 substeps per frame so fast marbles can't tunnel through pegs.
 */

import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {SeededRandom, TAU, TransientDetector, alphaRamp, clamp01, drawLabel, rampAt} from '../util.js';

const POOL = 192;
/** Past this many falling marbles the oldest starts fading out. */
const SOFT_CAP = 150;
const MAX_SPARKS = 128;
const RESTITUTION = 0.5;

/** Marble radius per drum family, in layout units. */
const FAMILY_RADIUS = {kick: 7, snare: 5.5, perc: 4.5, hat: 3.5};

class MarbleDropMode implements VizMode {
    // Marble pool, struct of arrays. life <= 0 = free slot.
    private readonly mx = new Float32Array(POOL);
    private readonly my = new Float32Array(POOL);
    private readonly mvx = new Float32Array(POOL);
    private readonly mvy = new Float32Array(POOL);
    private readonly mr = new Float32Array(POOL);
    private readonly life = new Float32Array(POOL);
    /** 0 = falling, 1 = fading (landed or retired at the cap). */
    private readonly fading = new Uint8Array(POOL);
    private readonly born = new Float64Array(POOL);
    private readonly color: string[] = new Array<string>(POOL).fill('');
    private spawnCount = 0;

    private readonly sx = new Float32Array(MAX_SPARKS);
    private readonly sy = new Float32Array(MAX_SPARKS);
    private readonly svx = new Float32Array(MAX_SPARKS);
    private readonly svy = new Float32Array(MAX_SPARKS);
    private readonly slife = new Float32Array(MAX_SPARKS);
    private readonly scolor: string[] = new Array<string>(MAX_SPARKS).fill('');
    private nextSpark = 0;

    // Peg grid: rows × cols, odd rows offset half a column (one peg fewer).
    private rows = 0;
    private cols = 0;
    private pegHit = new Float32Array(0);
    private pegColor: string[] = [];
    private binLevel = new Float32Array(0);
    private binColor: string[] = [];

    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.06, 0.05, 0.035);
    private readonly rng = new SeededRandom(0x3a7b1e);

    // Layout, CSS px.
    private w = 0;
    private h = 0;
    private u = 1;
    private lw = 1;
    private cs = 1;         // column spacing
    private rs = 1;         // row spacing
    private pegR = 2;
    private labelY = 0;
    private spawnY = 0;
    private fieldTop = 0;
    private floorY = 0;
    private binBottom = 0;
    private gravity = 1;

    private theme: Theme | null = null;
    private textRamp: string[] = [];
    private fftColors: [string, string, string] = ['', '', ''];
    private labelSize = 10;

    layout(s: VizServices): void {
        const w = s.width;
        const h = s.height;
        if (w === 0 || h === 0) return;
        const oldW = this.w, oldH = this.h, oldU = this.u;

        const u = Math.max(0.45, Math.min(w, h) / 720);
        this.u = u;
        this.lw = Math.max(1, Math.min(2, u));
        this.labelSize = Math.round(Math.max(9, Math.min(11, 10 * u)));
        this.labelY = Math.max(8, 14 * u);
        this.spawnY = this.labelY + Math.max(8, 14 * u);
        this.fieldTop = this.spawnY + Math.max(8, 18 * u);
        this.binBottom = h - Math.max(3, 6 * u);
        this.floorY = this.binBottom - Math.max(14, h * 0.09);
        this.gravity = h * 1.2;

        const cols = Math.max(5, Math.round(w / (58 * u)));
        const cs = w / cols;
        const fieldH = Math.max(1, this.floorY - this.fieldTop - cs * 0.3);
        const rows = Math.max(3, Math.floor(fieldH / (cs * 0.85)));
        this.cs = cs;
        this.rs = fieldH / rows;
        this.pegR = Math.max(1.5, 3 * u);

        if (rows !== this.rows || cols !== this.cols) this.regrid(rows, cols);

        // Rescale anything in flight rather than restarting the board.
        if (oldW > 0 && oldH > 0 && (oldW !== w || oldH !== h)) {
            const kx = w / oldW, ky = h / oldH, kr = u / oldU;
            for (let i = 0; i < POOL; i++) {
                this.mx[i] *= kx; this.my[i] *= ky;
                this.mvx[i] *= kx; this.mvy[i] *= ky;
                this.mr[i] *= kr;
            }
            for (let i = 0; i < MAX_SPARKS; i++) {
                this.sx[i] *= kx; this.sy[i] *= ky;
            }
        }
        this.w = w;
        this.h = h;
    }

    /** New grid dimensions: nearest-resample the hit glow and bin levels. */
    private regrid(rows: number, cols: number): void {
        const hit = new Float32Array(rows * cols);
        const pc = new Array<string>(rows * cols).fill('');
        const bins = new Float32Array(cols);
        const bc = new Array<string>(cols).fill('');
        if (this.rows > 0 && this.cols > 0) {
            for (let r = 0; r < rows; r++) {
                const or = Math.min(this.rows - 1, Math.floor((r + 0.5) * this.rows / rows));
                for (let c = 0; c < cols; c++) {
                    const oc = Math.min(this.cols - 1, Math.floor((c + 0.5) * this.cols / cols));
                    hit[r * cols + c] = this.pegHit[or * this.cols + oc];
                    pc[r * cols + c] = this.pegColor[or * this.cols + oc];
                }
            }
            for (let c = 0; c < cols; c++) {
                const oc = Math.min(this.cols - 1, Math.floor((c + 0.5) * this.cols / cols));
                bins[c] = this.binLevel[oc];
                bc[c] = this.binColor[oc];
            }
        }
        this.rows = rows;
        this.cols = cols;
        this.pegHit = hit;
        this.pegColor = pc;
        this.binLevel = bins;
        this.binColor = bc;
    }

    private pegX(r: number, c: number): number {
        return (c + (r & 1 ? 1 : 0.5)) * this.cs;
    }

    private pegY(r: number): number {
        return this.fieldTop + (r + 0.5) * this.rs;
    }

    private ensurePalette(t: Theme): void {
        if (t === this.theme) return;
        this.theme = t;
        this.textRamp = alphaRamp(t.textRgb);
        this.fftColors = [t.neonSecondary, t.active, t.neon];
    }

    private spawn(x: number, radiusUnits: number, color: string): void {
        // Soft cap: the oldest falling marble fades rather than vanishing.
        let falling = 0, oldest = -1, free = -1, stalest = 0;
        for (let i = 0; i < POOL; i++) {
            if (this.life[i] <= 0) {
                if (free < 0) free = i;
                continue;
            }
            if (this.born[i] < this.born[stalest] || this.life[stalest] <= 0) stalest = i;
            if (this.fading[i]) continue;
            falling++;
            if (oldest < 0 || this.born[i] < this.born[oldest]) oldest = i;
        }
        if (falling >= SOFT_CAP && oldest >= 0) this.fading[oldest] = 1;
        const i = free >= 0 ? free : stalest;

        const r = radiusUnits * this.u;
        this.mx[i] = Math.min(this.w - r, Math.max(r, x));
        this.my[i] = this.spawnY;
        this.mvx[i] = this.rng.range(-0.3, 0.3) * this.cs;
        this.mvy[i] = this.h * 0.05;
        this.mr[i] = r;
        this.life[i] = 1;
        this.fading[i] = 0;
        this.born[i] = this.spawnCount++;
        this.color[i] = color;
    }

    private laneCenter(index: number, count: number): number {
        return ((index + 0.5) / count) * this.w;
    }

    private readonly onOnset = (track: VizTrack, e: number): void => {
        const list = this.tracks.tracks;
        const laneW = this.w / list.length;
        let x = this.laneCenter(list.indexOf(track), list.length);
        let radius: number;
        const note = track.notes[e];
        if (Number.isFinite(note)) {
            const n = clamp01((note - 36) / 48);
            x += (n - 0.5) * laneW * 0.6;
            radius = 6.5 - n * 3.3;
        } else {
            radius = FAMILY_RADIUS[instrumentFamily(track.name)];
            x += this.rng.range(-0.2, 0.2) * Math.min(laneW, this.cs * 2);
        }
        this.spawn(x, radius, track.accentCss);
    };

    update(dt: number, s: VizServices): void {
        if (this.w === 0 || this.h === 0 || this.rows === 0) return;
        this.ensurePalette(s.theme);

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        // Always fed so its deltas stay current; only drops marbles when
        // there's no schedule to follow.
        const hits = this.transients.update(dt, s.low, s.mid, s.high);
        if (!sync.pattern) {
            const w = this.w;
            if (hits.kick) this.spawn(w * this.rng.range(0.12, 0.24), FAMILY_RADIUS.kick, this.fftColors[0]);
            if (hits.snare) this.spawn(w * this.rng.range(0.44, 0.56), FAMILY_RADIUS.snare, this.fftColors[1]);
            if (hits.hat) this.spawn(w * this.rng.range(0.76, 0.88), FAMILY_RADIUS.hat, this.fftColors[2]);
        }

        const sub = Math.min(4, Math.max(2, Math.ceil(dt * 240)));
        const h = dt / sub;
        for (let k = 0; k < sub; k++) this.step(h);

        const fade = dt * 3.5;
        for (let i = 0; i < POOL; i++) {
            if (this.life[i] > 0 && this.fading[i]) this.life[i] -= fade;
        }

        const pegDecay = Math.exp(-dt * 6);
        for (let p = 0; p < this.pegHit.length; p++) this.pegHit[p] *= pegDecay;
        const binDecay = Math.exp(-dt * 0.35);
        for (let c = 0; c < this.cols; c++) this.binLevel[c] *= binDecay;

        const sparkDrag = Math.exp(-dt * 3);
        for (let i = 0; i < MAX_SPARKS; i++) {
            if (this.slife[i] <= 0) continue;
            this.sx[i] += this.svx[i] * dt;
            this.sy[i] += this.svy[i] * dt;
            this.svx[i] *= sparkDrag;
            this.svy[i] = this.svy[i] * sparkDrag + this.gravity * 0.3 * dt;
            this.slife[i] -= dt * 2.8;
        }
    }

    /** One physics substep for every live marble. */
    private step(h: number): void {
        const g = this.gravity;
        // Drag sets a terminal velocity of ~0.85 canvas heights per second.
        const drag = Math.exp(-h * 1.4);
        const damp = Math.exp(-h * 0.8);
        const {w, cs, rs, pegR, fieldTop, rows, cols} = this;
        for (let i = 0; i < POOL; i++) {
            if (this.life[i] <= 0) continue;
            const r = this.mr[i];
            let vx = this.mvx[i] * damp;
            let vy = (this.mvy[i] + g * h) * drag;
            let x = this.mx[i] + vx * h;
            let y = this.my[i] + vy * h;

            if (x < r) { x = r; vx = Math.abs(vx) * RESTITUTION; }
            else if (x > w - r) { x = w - r; vx = -Math.abs(vx) * RESTITUTION; }

            if (y < this.floorY) {
                // Only the pegs in the neighbouring rows and columns can touch.
                const rr = Math.round((y - fieldTop) / rs - 0.5);
                const reach = r + pegR;
                for (let pr = Math.max(0, rr - 1); pr <= Math.min(rows - 1, rr + 1); pr++) {
                    const py = this.pegY(pr);
                    if (Math.abs(y - py) > reach) continue;
                    const odd = pr & 1;
                    const nc = odd ? cols - 1 : cols;
                    const cc = Math.round(x / cs - (odd ? 1 : 0.5));
                    for (let pc = Math.max(0, cc - 1); pc <= Math.min(nc - 1, cc + 1); pc++) {
                        const px = this.pegX(pr, pc);
                        const dx = x - px, dy = y - py;
                        const d2 = dx * dx + dy * dy;
                        if (d2 >= reach * reach) continue;
                        const d = Math.sqrt(d2) || 1e-4;
                        const nx = dx / d, ny = dy / d;
                        x = px + nx * reach;
                        y = py + ny * reach;
                        const vn = vx * nx + vy * ny;
                        if (vn < 0) {
                            vx = (vx - 2 * vn * nx) * RESTITUTION + this.rng.range(-0.5, 0.5) * cs;
                            vy = (vy - 2 * vn * ny) * RESTITUTION;
                            const p = pr * cols + pc;
                            this.pegHit[p] = 1;
                            this.pegColor[p] = this.color[i];
                            if (-vn > this.h * 0.15) this.spark(px, py - pegR, this.color[i]);
                        }
                    }
                }
            } else if (!this.fading[i]) {
                // Landed: count it into the bin under it and fade out there.
                const c = Math.min(cols - 1, Math.max(0, Math.floor(x / cs)));
                this.binLevel[c] = Math.min(1, this.binLevel[c] + 0.12);
                this.binColor[c] = this.color[i];
                this.fading[i] = 1;
            }
            if (y > this.binBottom - r) {
                y = this.binBottom - r;
                vy = 0;
                vx *= 0.5;
            }
            this.mx[i] = x;
            this.my[i] = y;
            this.mvx[i] = vx;
            this.mvy[i] = vy;
        }
    }

    private spark(x: number, y: number, color: string): void {
        const i = this.nextSpark;
        this.nextSpark = (i + 1) % MAX_SPARKS;
        this.sx[i] = x;
        this.sy[i] = y;
        this.svx[i] = this.rng.range(-1, 1) * this.cs;
        this.svy[i] = -this.rng.range(0.3, 0.8) * this.cs;
        this.slife[i] = 1;
        this.scolor[i] = color;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {w, h, u, lw, cs, rows, cols, pegR} = this;
        if (w === 0 || h === 0 || rows === 0) return;
        this.ensurePalette(s.theme);
        ctx.save();

        // Pegs at rest: one batched path.
        ctx.fillStyle = rampAt(this.textRamp, 0.3);
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
            const y = this.pegY(r);
            const nc = r & 1 ? cols - 1 : cols;
            for (let c = 0; c < nc; c++) {
                const x = this.pegX(r, c);
                ctx.moveTo(x + pegR, y);
                ctx.arc(x, y, pegR, 0, TAU);
            }
        }
        ctx.fill();

        // Struck pegs light in the striking marble's colour, with a thin ring.
        ctx.lineWidth = lw;
        for (let r = 0; r < rows; r++) {
            const y = this.pegY(r);
            const nc = r & 1 ? cols - 1 : cols;
            for (let c = 0; c < nc; c++) {
                const hit = this.pegHit[r * cols + c];
                if (hit < 0.03) continue;
                const x = this.pegX(r, c);
                const col = this.pegColor[r * cols + c];
                ctx.globalAlpha = hit;
                ctx.fillStyle = col;
                ctx.strokeStyle = col;
                ctx.beginPath();
                ctx.arc(x, y, pegR, 0, TAU);
                ctx.fill();
                ctx.globalAlpha = hit * 0.6;
                ctx.beginPath();
                ctx.arc(x, y, pegR * (1.8 + (1 - hit) * 1.2), 0, TAU);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        this.drawBins(ctx);
        this.drawLanes(ctx);

        // Sparks.
        const ss = Math.max(1.2, 1.8 * u);
        for (let i = 0; i < MAX_SPARKS; i++) {
            const life = this.slife[i];
            if (life <= 0) continue;
            ctx.globalAlpha = life * 0.7;
            ctx.fillStyle = this.scolor[i];
            ctx.fillRect(this.sx[i] - ss * 0.5, this.sy[i] - ss * 0.5, ss, ss);
        }

        // Marbles: a short velocity streak, then a flat disc.
        ctx.lineCap = 'round';
        for (let i = 0; i < POOL; i++) {
            const life = this.life[i];
            if (life <= 0) continue;
            const x = this.mx[i], y = this.my[i], r = this.mr[i];
            const a = Math.min(1, life);
            const vx = this.mvx[i], vy = this.mvy[i];
            const speed = Math.hypot(vx, vy);
            ctx.strokeStyle = this.color[i];
            ctx.fillStyle = this.color[i];
            if (speed > cs) {
                const len = Math.min(r * 4, speed * 0.05) / speed;
                ctx.globalAlpha = a * 0.35;
                ctx.lineWidth = r * 0.9;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x - vx * len, y - vy * len);
                ctx.stroke();
            }
            ctx.globalAlpha = a * 0.9;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
        }
        ctx.restore();
    }

    /** Bin dividers under the field and the landing histogram inside them. */
    private drawBins(ctx: CanvasRenderingContext2D): void {
        const {cs, cols, floorY, binBottom, lw} = this;
        const binH = binBottom - floorY;
        const gap = Math.max(1, cs * 0.12);
        for (let c = 0; c < cols; c++) {
            const level = this.binLevel[c];
            if (level < 0.01) continue;
            const bh = level * binH * 0.92;
            ctx.globalAlpha = 0.25 + level * 0.45;
            ctx.fillStyle = this.binColor[c];
            ctx.fillRect(c * cs + gap, binBottom - bh, cs - gap * 2, bh);
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = rampAt(this.textRamp, 0.3);
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let c = 0; c <= cols; c++) {
            const x = Math.min(this.w - lw * 0.5, Math.max(lw * 0.5, c * cs));
            ctx.moveTo(x, floorY);
            ctx.lineTo(x, binBottom);
        }
        ctx.moveTo(0, binBottom);
        ctx.lineTo(this.w, binBottom);
        ctx.stroke();
    }

    /** Track lanes along the top: name label and a drop tick that flashes. */
    private drawLanes(ctx: CanvasRenderingContext2D): void {
        const list = this.tracks.tracks;
        const n = list.length;
        if (n === 0) return;
        const laneW = this.w / n;
        const fs = this.labelSize;
        const tick = Math.max(3, 6 * this.u);
        ctx.lineWidth = this.lw;
        for (let i = 0; i < n; i++) {
            const t = list[i];
            const x = this.laneCenter(i, n);
            if (t.name.length * fs * 0.62 + 6 < laneW) {
                drawLabel(ctx, t.name, x, this.labelY, rampAt(this.textRamp, 0.4 + t.activity * 0.5), fs, 'center');
            }
            ctx.globalAlpha = 0.3 + t.activity * 0.7;
            ctx.strokeStyle = t.accentCss;
            ctx.beginPath();
            ctx.moveTo(x - tick, this.spawnY - tick * 0.5);
            ctx.lineTo(x + tick, this.spawnY - tick * 0.5);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }
}

export const marbleDropDef: VizModeDef = {
    id: 'marble-drop',
    name: 'MARBLE DROP',
    create: () => new MarbleDropMode(),
};
