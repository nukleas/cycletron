/**
 * SPOT FIELD — a wild, fullscreen optical spot diagram. Every pattern track
 * is a gaussian ray-spot cloud orbiting the optical axis; hap onsets make a
 * cloud burst and refocus, the mids stretch the clouds astigmatically, the
 * highs split them into chromatic ghosts, and kick-family onsets defocus the
 * whole field and fire Airy rings from the center (FFT kick transients stand
 * in only when nothing is scheduled). Trail background smears the motion
 * like long-exposure film. Reticle chrome + live per-cloud RMS readouts keep
 * the optical-test-bench flavor without a single wiggly line chart.
 *
 * Idle (no pattern): three clouds follow the LOW / MID / HIGH bands.
 *
 * Spots are painted source-over, not additive: with the trail background,
 * 'lighter' stacked every frame's dense core into white and pushed the
 * track accent off-palette. Overlapping ghosts still read as a chromatic
 * fringe at these alphas.
 */

import {TrackModel, instrumentFamily, type VizTrack} from '../tracks.js';
import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {
    MONO_FONT, SeededRandom, TAU, TransientDetector, alphaRamp, beatEnv, rampAt, rgbOf,
} from '../util.js';

const SPOT_POINTS = 140;
const MAX_CLOUDS = 6;
const GOLDEN = 2.39996;
/** Fixed seed: the ray pattern is the same on every entry. */
const SPOT_SEED = 0x5f07f1e1;
const AIRY_SECS = 0.7;
const IDLE_BANDS = ['LOW', 'MID', 'HIGH'];
const NO_DASH: number[] = [];

/** Per-track animation state that outlives a single bar rebuild. */
interface CloudAnim {
    /** Onset burst envelope — 1 at hit, fast exponential decay. */
    burst: number;
    /** Smoothed vertical offset from the cloud's pitched notes. */
    noteOffset: number;
    /** Target for noteOffset, set on pitched onsets. */
    noteTarget: number;
}

/** One cloud's draw inputs, refilled in place every frame. */
interface Cloud {
    name: string;
    /** rgba ramp of the cloud's accent. */
    ramp: string[];
    energy: number;
    burst: number;
    noteOffset: number;
    slot: number;
    /** Live spot radius on the fictional µm scale, for the legend. */
    rms: number;
}

class SpotFieldMode implements VizMode {
    /** Shared unit-gaussian (x, y) pairs, scaled per cloud each frame. */
    private readonly unit = new Float32Array(SPOT_POINTS * 2);
    private readonly tracks = new TrackModel();
    private readonly anims = new Map<string, CloudAnim>();
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    private readonly clouds: Cloud[] = [];
    private cloudCount = 0;
    /** rgba ramps per accent CSS string — a handful of entries per session. */
    private readonly ramps = new Map<string, string[]>();
    private theme: Theme | null = null;
    private textRamp: string[] = [];
    private neonRamp: string[] = [];
    private redRamp: string[] = [];
    private idleRamps: string[][] = [];
    private panelRamp: string[] = [];
    private borderRamp: string[] = [];
    private driftT = 0;
    /** Seconds since the last kick — drives the Airy-ring flash. */
    private kickAge = 10;
    /** Global defocus envelope — kicks swell every cloud. */
    private defocus = 0;

    // Canvas-relative metrics, recomputed in layout().
    private u = 1;
    private pt = 2;
    private line = 1;
    private fontPx = 10;
    private font = `10px ${MONO_FONT}`;
    /** Monospace advance (≈0.6 em) and chrome inset. */
    private charW = 6;
    private margin = 10;
    private dashEdge = [4, 6];
    private dashAiry = [6, 5];

    constructor() {
        const rng = new SeededRandom(SPOT_SEED);
        for (let i = 0; i < SPOT_POINTS; i++) {
            // Box–Muller
            const a = rng.next() || 1e-6;
            const b = rng.next();
            const mag = Math.sqrt(-2 * Math.log(a));
            this.unit[i * 2] = mag * Math.cos(TAU * b);
            this.unit[i * 2 + 1] = mag * Math.sin(TAU * b);
        }
        for (let i = 0; i < MAX_CLOUDS; i++) {
            this.clouds.push({ name: '', ramp: [], energy: 0, burst: 0, noteOffset: 0, slot: 0, rms: 0 });
        }
    }

    layout(s: VizServices): void {
        const u = Math.min(s.width, s.height) / 720;
        this.u = u;
        this.pt = Math.max(1.25, 2 * u);
        this.line = Math.min(1.75, Math.max(1, Math.sqrt(u)));
        this.fontPx = Math.round(Math.min(11, Math.max(9, 10 * u)));
        this.font = `${this.fontPx}px ${MONO_FONT}`;
        this.dashEdge = [4 * this.line, 6 * this.line];
        this.dashAiry = [6 * this.line, 5 * this.line];
        this.charW = this.fontPx * 0.6;
        this.margin = Math.round(Math.max(8, 16 * u));

        if (s.theme !== this.theme) {
            this.theme = s.theme;
            this.textRamp = alphaRamp(s.theme.textRgb);
            this.neonRamp = alphaRamp(rgbOf(s.theme.neon, s.theme.accentPool[0]));
            this.redRamp = alphaRamp(rgbOf(s.theme.red, [239, 126, 130]));
            this.panelRamp = alphaRamp(s.theme.bgLightRgb);
            this.borderRamp = alphaRamp(s.theme.borderRgb);
            this.ramps.clear();
            const pool = s.theme.accentPool;
            this.idleRamps = [0, 1, 2].map((i) => alphaRamp(pool[i * 2 % pool.length]));
        }
    }

    private animFor(name: string): CloudAnim {
        let a = this.anims.get(name);
        if (!a) {
            a = { burst: 0, noteOffset: 0, noteTarget: 0 };
            this.anims.set(name, a);
        }
        return a;
    }

    private rampFor(track: VizTrack): string[] {
        let r = this.ramps.get(track.accentCss);
        if (!r) {
            r = alphaRamp(track.accent);
            this.ramps.set(track.accentCss, r);
        }
        return r;
    }

    private kick(): void {
        this.kickAge = 0;
        this.defocus = 1;
    }

    /** Hap onsets: burst the track's cloud; pitched notes steer it; kicks defocus. */
    private readonly onOnset = (track: VizTrack, e: number): void => {
        const anim = this.animFor(track.name);
        anim.burst = 1;
        const note = track.notes[e];
        if (Number.isFinite(note)) {
            // C4-centered: low notes sink, high notes rise.
            anim.noteTarget = -((note - 60) / 36);
        } else if (instrumentFamily(track.name) === 'kick') {
            this.kick();
        }
    };

    update(dt: number, s: VizServices): void {
        this.driftT += dt;
        this.kickAge += dt;

        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        // Anim envelopes.
        const burstDecay = Math.exp(-dt * 7);
        const noteK = 1 - Math.exp(-dt * 6);
        for (const anim of this.anims.values()) {
            anim.burst *= burstDecay;
            anim.noteOffset += (anim.noteTarget - anim.noteOffset) * noteK;
        }
        // Drop anim state for tracks that no longer exist (rare, off the hot path).
        if (this.anims.size > this.tracks.tracks.length + 8) {
            const live = new Set(this.tracks.tracks.map((t) => t.name));
            for (const name of this.anims.keys()) {
                if (!live.has(name)) this.anims.delete(name);
            }
        }

        // FFT kicks stand in for the schedule only when nothing is playing.
        const hits = this.transients.update(dt, s.low, s.mid, s.high);
        if (!sync.pattern && hits.kick) this.kick();
        this.defocus *= Math.exp(-dt * 3.5);
    }

    /** Fill `this.clouds` from the tracks, or from the bands when idle. */
    private gatherClouds(s: VizServices): void {
        let n = 0;
        const tracks = this.tracks.tracks;
        if (tracks.length > 0) {
            for (let i = 0; i < tracks.length && n < MAX_CLOUDS; i++) {
                const t = tracks[i];
                const anim = this.animFor(t.name);
                const c = this.clouds[n++];
                c.name = t.name;
                c.ramp = this.rampFor(t);
                c.energy = t.activity;
                c.burst = anim.burst;
                c.noteOffset = anim.noteOffset;
                c.slot = t.slot;
            }
        } else {
            for (let i = 0; i < 3; i++) {
                const c = this.clouds[n++];
                c.name = IDLE_BANDS[i];
                c.ramp = this.idleRamps[i];
                c.energy = Math.min(1, i === 0 ? s.low : i === 1 ? s.mid : s.high);
                c.burst = 0;
                c.noteOffset = 0;
                c.slot = i;
            }
        }
        this.cloudCount = n;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        if (w <= 0 || h <= 0) return;
        const low = Math.min(1.5, s.low);
        const mid = Math.min(1.5, s.mid);
        const high = Math.min(1.5, s.high);
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) * 0.36;
        const u = this.u;
        const line = this.line;
        const beat = beatEnv(s.cycle * 4);
        const text = this.textRamp;

        ctx.save();
        ctx.lineWidth = line;

        // ---- Reticle chrome — re-asserted every frame over the trails ----
        ctx.strokeStyle = rampAt(text, 0.10 + beat * 0.08);
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(w, cy);
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        // Axis ticks every R/4 along both axes.
        const tick = 4 * line;
        for (let m = 1; m <= 6; m++) {
            const off = (R * m) / 4;
            ctx.moveTo(cx + off, cy - tick);
            ctx.lineTo(cx + off, cy + tick);
            ctx.moveTo(cx - off, cy - tick);
            ctx.lineTo(cx - off, cy + tick);
            ctx.moveTo(cx - tick, cy + off);
            ctx.lineTo(cx + tick, cy + off);
            ctx.moveTo(cx - tick, cy - off);
            ctx.lineTo(cx + tick, cy - off);
        }
        ctx.stroke();
        // Field-edge circle.
        ctx.setLineDash(this.dashEdge);
        ctx.strokeStyle = rampAt(text, 0.14);
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.28, 0, TAU);
        ctx.stroke();

        // ---- Kick Airy rings — expanding from the axis on every kick ----
        if (this.kickAge < AIRY_SECS) {
            const t = this.kickAge / AIRY_SECS;
            ctx.setLineDash(this.dashAiry);
            for (let ring = 0; ring < 3; ring++) {
                const alpha = (1 - t) * (0.4 - ring * 0.1);
                if (alpha <= 0.01) continue;
                ctx.strokeStyle = rampAt(this.neonRamp, alpha);
                ctx.lineWidth = line * (1.5 - ring * 0.4);
                ctx.beginPath();
                ctx.arc(cx, cy, (t * 1.4 + ring * 0.18) * R, 0, TAU);
                ctx.stroke();
            }
            ctx.lineWidth = line;
        }
        ctx.setLineDash(NO_DASH);

        // ---- Clouds — one per track, band-driven fallback when idle ----
        this.gatherClouds(s);
        const clouds = this.clouds;
        const count = this.cloudCount;
        const pt = this.pt;
        const core = pt * 1.2;
        const ghostA = 0.12 + high * 0.12;
        for (let ci = 0; ci < count; ci++) {
            const cloud = clouds[ci];
            const energy = Math.min(1, cloud.energy);
            const ramp = cloud.ramp;

            // Orbit: each cloud owns a stable bearing (slot × golden angle),
            // crawling with the drift clock; bass widens the whole formation.
            const bearing = cloud.slot * GOLDEN + this.driftT * 0.12;
            const orbit = count === 1 ? 0 : R * (0.55 + low * 0.25);
            const ocx = cx + Math.cos(bearing) * orbit;
            const ocy = cy + Math.sin(bearing) * orbit * 0.72
                + cloud.noteOffset * h * 0.18;

            // Radius: bursts blow the cloud open, defocus (kicks) swells all,
            // then everything refocuses tight. Mids stretch astigmatically.
            const base = R * (0.10 + energy * 0.16);
            const rx = base * (1 + cloud.burst * 2.4 + this.defocus * 0.9);
            const ry = rx * (1 + mid * 1.6);
            const ang = this.driftT * (0.5 + energy * 1.6) + cloud.slot * 1.7;
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);

            // Chromatic ghosts: two passes split by the highs, then the
            // accent-colored core on top.
            const split = (high * 9 + cloud.burst * 4) * u;
            if (split >= 0.8) {
                this.drawSpots(ctx, ocx - split, ocy, rx, ry, ca, sa, pt, rampAt(this.neonRamp, ghostA));
                this.drawSpots(ctx, ocx + split, ocy, rx, ry, ca, sa, pt, rampAt(this.redRamp, ghostA));
            }
            this.drawSpots(ctx, ocx, ocy, rx, ry, ca, sa, core,
                rampAt(ramp, Math.min(0.9, 0.35 + energy * 0.4 + cloud.burst * 0.2)));

            // Burst ring — expands as the burst decays.
            if (cloud.burst > 0.04) {
                ctx.strokeStyle = rampAt(ramp, cloud.burst * 0.8);
                ctx.lineWidth = line * 1.5;
                ctx.beginPath();
                ctx.arc(ocx, ocy, rx * 0.8 + (1 - cloud.burst) * R * 0.5, 0, TAU);
                ctx.stroke();
                ctx.lineWidth = line;
            }

            // Tiny unlabeled centroid tick; the readouts live on the legend
            // rail, where the trails can't smear them.
            const tk = 2.5 * line;
            ctx.strokeStyle = rampAt(ramp, 0.7);
            ctx.beginPath();
            ctx.moveTo(ocx - tk, ocy);
            ctx.lineTo(ocx + tk, ocy);
            ctx.moveTo(ocx, ocy - tk);
            ctx.lineTo(ocx, ocy + tk);
            ctx.stroke();

            cloud.rms = (rx / R) * 42; // fictional µm scale, moves honestly
        }

        // Chrome is painted over an opaque panel every frame, so the trail
        // fade never ghosts it.
        this.drawHeader(ctx, s);
        this.drawLegend(ctx, s);
        ctx.restore();
    }

    /** Top-left readout strip: title + bar / defocus stats. */
    private drawHeader(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const f = this.fontPx;
        const m = this.margin;
        const text = this.textRamp;
        const stripH = f * 2;
        const stripW = Math.min(s.width - m * 2, this.charW * 60 + f * 2);
        ctx.fillStyle = rampAt(this.panelRamp, 0.92);
        ctx.fillRect(m, m, stripW, stripH);
        ctx.strokeStyle = rampAt(this.borderRamp, 0.8);
        ctx.lineWidth = 1;
        ctx.strokeRect(m + 0.5, m + 0.5, stripW - 1, stripH - 1);

        const y = m + stripH / 2;
        ctx.font = this.font;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = rampAt(text, 0.6 + beatEnv(s.cycle) * 0.3);
        ctx.fillText('SPOT FIELD', m + f, y);
        ctx.fillStyle = rampAt(text, 0.45);
        ctx.fillText(
            `BAR ${Math.max(0, Math.floor(s.cycle))}   FLD 0.7   DEFOCUS ${this.defocus.toFixed(2)}   λ d/F/C`,
            m + f + this.charW * 12, y,
        );
    }

    /**
     * Bottom-left legend rail in the cockpit SIGNAL BANK idiom: one row per
     * cloud — accent swatch, name, RMS, scheduled-activity bar. Rows are
     * capped by pane height; the title shows any overflow.
     */
    private drawLegend(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const count = this.cloudCount;
        if (count === 0) return;
        const f = this.fontPx;
        const m = this.margin;
        const cw = this.charW;
        const text = this.textRamp;
        const rowH = Math.round(f * 1.9);
        const titleH = Math.round(f * 2.2);
        const maxRows = Math.max(1, Math.floor((s.height * 0.42 - titleH) / rowH));
        const rows = Math.min(count, maxRows);
        const hidden = Math.max(this.tracks.tracks.length, count) - rows;

        const railW = Math.min(s.width - m * 2, cw * 34 + f * 2);
        const railH = titleH + rows * rowH + f * 0.6;
        const x = m;
        const y = s.height - m - railH;
        ctx.fillStyle = rampAt(this.panelRamp, 0.92);
        ctx.fillRect(x, y, railW, railH);
        ctx.strokeStyle = rampAt(this.borderRamp, 0.8);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, railW - 1, railH - 1);

        ctx.font = this.font;
        ctx.textBaseline = 'middle';
        const inner = x + f;
        const right = x + railW - f;
        ctx.textAlign = 'left';
        ctx.fillStyle = rampAt(text, 0.55);
        ctx.fillText('SPOT RMS', inner, y + titleH / 2);
        if (hidden > 0) {
            ctx.textAlign = 'right';
            ctx.fillStyle = rampAt(text, 0.45);
            ctx.fillText(`+${hidden}`, right, y + titleH / 2);
        }
        ctx.fillStyle = rampAt(this.borderRamp, 1);
        ctx.fillRect(inner, y + titleH - 1, right - inner, 1);

        // Columns: swatch | name | RMS | activity bar (dropped when narrow).
        const nameX = inner + f * 0.8;
        const rmsX = nameX + cw * 20; // right edge of the RMS column
        const barX = rmsX + cw * 1.5;
        const barW = right - barX;
        const maxChars = Math.max(3, Math.floor((rmsX - cw * 8 - nameX) / cw));
        for (let i = 0; i < rows; i++) {
            const c = this.clouds[i];
            const yy = y + titleH + i * rowH + rowH / 2;
            const energy = Math.min(1, c.energy);
            ctx.fillStyle = rampAt(c.ramp, 1);
            ctx.fillRect(inner, yy - f * 0.4, Math.max(2, f * 0.3), f * 0.8);

            const name = c.name.length > maxChars ? c.name.slice(0, maxChars - 1) + '…' : c.name;
            ctx.textAlign = 'left';
            ctx.fillStyle = rampAt(text, 0.55 + energy * 0.4);
            ctx.fillText(name.toUpperCase(), nameX, yy);
            ctx.textAlign = 'right';
            ctx.fillStyle = rampAt(text, 0.5);
            ctx.fillText(`${c.rms.toFixed(1)}µm`, rmsX, yy);

            if (barW > cw * 3) {
                const bh = Math.max(2, f * 0.45);
                ctx.fillStyle = rampAt(this.borderRamp, 1);
                ctx.fillRect(barX, yy - bh / 2, barW, bh);
                ctx.fillStyle = rampAt(c.ramp, 0.9);
                ctx.fillRect(barX, yy - bh / 2, barW * Math.sqrt(energy), bh);
            }
        }
    }

    /** One pass of the shared ray pattern, scaled + rotated, as flat squares. */
    private drawSpots(
        ctx: CanvasRenderingContext2D, ox: number, oy: number, rx: number, ry: number,
        ca: number, sa: number, size: number, color: string,
    ): void {
        const unit = this.unit;
        const sx = rx * 0.45;
        const sy = ry * 0.45;
        const half = size / 2;
        ctx.fillStyle = color;
        for (let i = 0; i < SPOT_POINTS; i++) {
            const px = unit[i * 2] * sx;
            const py = unit[i * 2 + 1] * sy;
            ctx.fillRect(ox + px * ca - py * sa - half, oy + px * sa + py * ca - half, size, size);
        }
    }
}

export const spotFieldDef: VizModeDef = {
    id: 'spot-field',
    name: 'SPOT FIELD',
    trailFade: 0.22,
    create: () => new SpotFieldMode(),
};
