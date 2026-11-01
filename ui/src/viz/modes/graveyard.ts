/**
 * GRAVEYARD — a graveyard at night where every note is a skeleton. Rows of
 * graves sit on a hill under the moon: the front row is the bass register,
 * the middle the mids, the back the leads, and a note's pitch picks its
 * column. A skeleton climbs out of its grave just before its onset, dances
 * while the note sounds and sinks back after it; a held note rises as a
 * ghost instead. Kicks thump the ground, snares strike lightning, hats send
 * bats across the moon.
 *
 * Every grave is decided once, when the hap enters the field, so a dancer
 * never moves between frames. render() is pure: bolts and bats are spawned
 * in update() from the hap's seed.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {type FieldHap, type FieldTeam, HapField, type Rgb} from '../hap-field.js';
import {TAU, alphaRamp, clamp01, hash32, lerpRgb, mixRgb, rand01, rgbOf} from '../util.js';
import {type Role, halloweenRole, isLong, registerPos} from './halloween/roles.js';
import {type Pose, drawSkeleton, makePose, skeletonPose} from './halloween/skeleton.js';
import {type Bat, type Bolt, GradientCache, ageBats, ageBolts, boltFlash, drawBats, drawBolt, drawGhost, drawMoon, drawStars, makeBat, makeBolt} from './halloween/sky.js';

const REFERENCE_HEIGHT = 1080;
const LOOKAHEAD = 2;
const MAX_HAPS = 400;
const MAX_PER_TRACK = 64;
const DRUM_CAP = 16;
const IDLE_RATE = 0.25;
/** Cycles a skeleton takes to climb out before its onset, and to sink after. */
const RISE = 0.12;
const SINK = 0.3;
export const COLS = 12;
const HORIZON = 0.56;
const MOON_X = 0.78;
const MOON_Y = 0.2;
const MAX_BOLTS = 4;
const MAX_BATS = 24;
const STARS = 90;
const GRASS = 14;

/** Back to front: the lead, mid and bass registers. */
const ROWS = [
    {y: 0.6, scale: 0.55},
    {y: 0.7, scale: 0.75},
    {y: 0.86, scale: 1},
] as const;
const ROW_OF: Record<string, number> = {lead: 0, mid: 1, bass: 2};

interface Team extends FieldTeam {}

interface Dancer extends FieldHap<Team> {
    role: Role;
    long: boolean;
    style: number;
    row: number;
    col: number;
    /** Offset in columns when the grave is shared. */
    xOff: number;
    reach: number;
    /** Dance phase offset so a chorus isn't in lockstep. */
    phaseOff: number;
    flash: number;
}

/**
 * The column a new dancer takes: its pitch column, else the nearest free
 * one, stepping outward with the first side from the seed; -1 when the row
 * is full.
 */
export function graveFor(col: number, seed: number, taken: Uint8Array): number {
    const first = (seed & 1) === 0 ? 1 : -1;
    for (let d = 0; d < taken.length; d++) {
        for (const side of d === 0 ? [0] : [first, -first]) {
            const c = col + side * d;
            if (c >= 0 && c < taken.length && !taken[c]) return c;
        }
    }
    return -1;
}

const taken = new Uint8Array(COLS);

class GraveyardMode implements VizMode {
    private readonly field = new HapField<Team, Dancer>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_HAPS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_RATE,
        team: (base) => base,
        hap: (base) => this.makeDancer(base),
        cap: (_team, note) => (Number.isFinite(note) ? Infinity : DRUM_CAP),
        keep: (h, cycle) => h.end + (h.long ? 1 : SINK) + 0.05 >= cycle,
    });
    private readonly pose: Pose = makePose();
    private readonly bolts: Bolt[] = [];
    private readonly bats: Bat[] = [];
    private readonly sky = new GradientCache();
    private readonly moonGlow = new GradientCache();
    private readonly fogs = [new GradientCache(), new GradientCache(), new GradientCache()];
    private readonly drawList: Dancer[] = [];
    private thump = 0;
    private lastIdleBat = -1;

    private vw = 0;
    private vh = 0;
    private renderScale = 1;
    private hill: Path2D | null = null;
    private readonly tombs: Path2D[] = [];
    private skyTop = '';
    private skyHorizon = '';
    private moon = '';
    private moonGlowRgb: Rgb = [255, 243, 176];
    private starRamp: string[] = [];
    private hillCss = '';
    private fogRgb: Rgb = [0, 0, 0];
    private tomb = '';
    private tombEdge = '';
    private bone = '';
    private socket = '';
    private ghostRgb: Rgb = [255, 255, 255];
    private flashRgb: Rgb = [255, 255, 255];
    private grass = '';
    private silhouette = '';
    private bat = '';
    private readonly white: Rgb = [255, 255, 255];

    layout(s: VizServices): void {
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.bakePalette(s.theme);
        this.buildHill();
        this.buildTombs();
        this.field.invalidate();
    }

    private bakePalette(t: Theme): void {
        const bg = t.bgRgb;
        const violet = rgbOf(t.violet, [90, 42, 154]);
        const active = rgbOf(t.active, [255, 243, 176]);
        const neon = rgbOf(t.neon, [255, 122, 26]);
        this.skyTop = t.bg;
        this.skyHorizon = lerpRgb(bg, violet, 0.35);
        this.moon = t.active;
        this.moonGlowRgb = active;
        this.starRamp = alphaRamp(mixRgb(t.textRgb, this.white, 0.4), 16);
        this.hillCss = lerpRgb(bg, violet, 0.12);
        this.fogRgb = mixRgb(t.bgLightRgb, violet, 0.25);
        this.tomb = lerpRgb(t.bgLighterRgb, t.textRgb, 0.3);
        this.tombEdge = lerpRgb(t.bgRgb, t.borderRgb, 0.9);
        this.bone = lerpRgb(t.textRgb, this.white, 0.6);
        this.socket = t.bg;
        this.ghostRgb = mixRgb(t.textRgb, this.white, 0.5);
        this.flashRgb = mixRgb(active, this.white, 0.6);
        this.grass = lerpRgb(bg, neon, 0.1);
        this.silhouette = lerpRgb(bg, violet, 0.06);
        this.bat = lerpRgb(bg, violet, 0.03);
    }

    private buildHill(): void {
        const {vw, vh} = this;
        const p = new Path2D();
        p.moveTo(0, vh);
        for (let i = 0; i <= 64; i++) {
            const u = i / 64;
            p.lineTo(u * vw, this.hillY(u));
        }
        p.lineTo(vw, vh);
        p.closePath();
        this.hill = p;
    }

    private hillY(u: number): number {
        return this.vh * (HORIZON + 0.025 * Math.sin(u * 3.1 + 0.4) + 0.012 * Math.sin(u * 7.3 + 2) - 0.03 * Math.sin(u * 1.7));
    }

    /** Four tombstone shapes in a unit box, drawn scaled per row. */
    private buildTombs(): void {
        this.tombs.length = 0;
        const round = new Path2D();
        round.moveTo(0, 1);
        round.lineTo(0, 0.35);
        round.arc(0.5, 0.35, 0.5, Math.PI, 0);
        round.lineTo(1, 1);
        round.closePath();
        const cross = new Path2D();
        cross.rect(0.38, 0, 0.24, 1);
        cross.rect(0.08, 0.22, 0.84, 0.2);
        const point = new Path2D();
        point.moveTo(0.1, 1);
        point.lineTo(0.1, 0.3);
        point.lineTo(0.5, 0);
        point.lineTo(0.9, 0.3);
        point.lineTo(0.9, 1);
        point.closePath();
        const slab = new Path2D();
        slab.moveTo(0, 1);
        slab.lineTo(0.05, 0.25);
        slab.lineTo(0.95, 0.18);
        slab.lineTo(1, 1);
        slab.closePath();
        this.tombs.push(round, cross, point, slab);
    }

    private colX(row: number, col: number): number {
        const width = 0.84 / COLS;
        return this.vw * (0.08 + width * (col + 0.5 + (row === 0 ? 0.5 : 0)));
    }

    private groundY(row: number): number {
        return this.vh * ROWS[row].y;
    }

    // ---- schedule ---------------------------------------------------------------

    private makeDancer(base: FieldHap<Team>): Dancer {
        const role = halloweenRole(base.team.name, base.note);
        const long = isLong(base.begin, base.end);
        const r = (n: number) => rand01(hash32(base.seed, n));
        let row = 1;
        let col = Math.floor(r(2) * COLS);
        let xOff = 0;
        if (role === 'bass' || role === 'mid' || role === 'lead') {
            row = ROW_OF[role];
            const want = Math.round(registerPos(base.note) * (COLS - 1));
            taken.fill(0);
            const lo = base.begin - RISE;
            const hi = base.end + (long ? 1 : SINK);
            for (const h of this.field.haps) {
                if (h.row !== row || h.col < 0 || (h.role !== 'bass' && h.role !== 'mid' && h.role !== 'lead')) continue;
                if (h.begin - RISE < hi && h.end + (h.long ? 1 : SINK) > lo) taken[h.col] = 1;
            }
            col = graveFor(want, base.seed, taken);
            if (col < 0) {
                col = want;
                xOff = (r(3) - 0.5) * 0.6;
            }
        }
        return {
            ...base, role, long, row, col, xOff,
            style: base.seed & 3,
            reach: Number.isFinite(base.note) ? registerPos(base.note) : 0,
            phaseOff: r(7) * 0.25,
            flash: 0,
        };
    }

    update(dt: number, s: VizServices): void {
        const field = this.field;
        field.update(dt, s);
        if (field.restarted) {
            this.bolts.length = 0;
            this.bats.length = 0;
            this.thump = 0;
        }
        let bats = 0;
        for (const h of field.haps) {
            h.flash *= Math.exp(-dt * 4);
            if (!field.crossed(h)) continue;
            h.done = true;
            h.flash = 1;
            h.team.activity = 1;
            switch (h.role) {
                case 'kick': this.thump = 1; break;
                case 'tom': this.thump = Math.max(this.thump, 0.4); break;
                case 'snare': this.strike(h.seed, 1, 0.25); break;
                case 'crash': this.strike(h.seed, 2, 0.5); break;
                case 'hat':
                    if (bats < 2 && this.bats.length < MAX_BATS) { this.bats.push(makeBat(h.seed, this.vw, this.vh)); bats++; }
                    break;
                default: break;
            }
        }
        if (!field.locked) {
            const tick = Math.floor(field.cycle / 4);
            if (tick !== this.lastIdleBat) {
                this.lastIdleBat = tick;
                if (this.bats.length < MAX_BATS) this.bats.push(makeBat(hash32(tick, 1), this.vw, this.vh));
            }
        }
        ageBolts(this.bolts, dt);
        ageBats(this.bats, dt);
        this.thump *= Math.exp(-dt * 9);
    }

    private strike(seed: number, forks: number, life: number): void {
        if (this.bolts.length >= MAX_BOLTS) return;
        const x = (0.15 + 0.7 * rand01(hash32(seed, 9))) * this.vw;
        this.bolts.push(makeBolt(seed, x, -0.02 * this.vh, this.hillY(x / this.vw), forks, life));
    }

    // ---- render -----------------------------------------------------------------

    render(ctx: CanvasRenderingContext2D): void {
        const {vw, vh, field} = this;
        const cycle = field.cycle;
        const flash = boltFlash(this.bolts);
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);

        ctx.fillStyle = this.sky.linear(ctx, 0, 0, 0, vh * HORIZON, [[0, this.skyTop], [1, this.skyHorizon]]);
        ctx.fillRect(0, 0, vw, vh);
        drawStars(ctx, vw, vh * HORIZON, cycle, STARS, this.starRamp);
        const breathe = field.locked ? 0.3 : 0.5 + 0.5 * Math.sin(TAU * cycle / 4);
        drawMoon(ctx, this.moonGlow, vw * MOON_X, vh * MOON_Y, vh * 0.07, this.moon, this.moonGlowRgb, breathe);
        drawBats(ctx, this.bats, vh, this.bat);
        const flashCss = `rgb(${this.flashRgb[0]}, ${this.flashRgb[1]}, ${this.flashRgb[2]})`;
        for (const b of this.bolts) drawBolt(ctx, b, flashCss, 2);
        if (flash > 0.01) {
            ctx.fillStyle = `rgba(${this.flashRgb[0]}, ${this.flashRgb[1]}, ${this.flashRgb[2]}, ${(0.35 * flash).toFixed(3)})`;
            ctx.fillRect(0, 0, vw, vh);
        }

        // The hill keeps its colour, so the stones go dark against it in a flash.
        ctx.fillStyle = this.hillCss;
        if (this.hill) ctx.fill(this.hill);

        for (let row = 0; row < ROWS.length; row++) {
            this.drawFog(ctx, row, 0.5);
            this.drawTombs(ctx, row, flash);
            this.drawDancers(ctx, row, cycle, flash);
        }
        this.drawGrass(ctx, cycle);
        this.drawFog(ctx, 2, 0.9);
        ctx.restore();
    }

    private drawFog(ctx: CanvasRenderingContext2D, row: number, strength: number): void {
        const {vw, vh} = this;
        const y = this.groundY(row);
        const h = vh * 0.07 * ROWS[row].scale;
        const [r, g, b] = this.fogRgb;
        const a = (0.22 * strength).toFixed(3);
        ctx.fillStyle = this.fogs[row].linear(ctx, 0, y - h, 0, y + h * 0.6, [
            [0, `rgba(${r}, ${g}, ${b}, 0)`], [0.6, `rgba(${r}, ${g}, ${b}, ${a})`], [1, `rgba(${r}, ${g}, ${b}, 0)`],
        ]);
        ctx.fillRect(0, y - h, vw, h * 1.6);
    }

    private drawTombs(ctx: CanvasRenderingContext2D, row: number, flash: number): void {
        const {vh} = this;
        const rs = ROWS[row].scale;
        const tw = vh * 0.045 * rs;
        const th = vh * 0.065 * rs;
        const hop = -6 * rs * this.thump;
        const gy = this.groundY(row) + hop;
        const fill = flash > 0.02 ? this.silhouette : this.tomb;
        for (let col = 0; col < COLS; col++) {
            const shape = this.tombs[hash32(row * 31 + col, 3) & 3];
            const x = this.colX(row, col) + (rand01(hash32(row, col)) - 0.5) * tw * 0.5;
            ctx.save();
            ctx.translate(x - tw / 2, gy - th);
            ctx.scale(tw, th);
            ctx.fillStyle = fill;
            ctx.fill(shape);
            ctx.restore();
            // Base line of the grave.
            ctx.strokeStyle = this.tombEdge;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x - tw * 1.1, gy);
            ctx.lineTo(x + tw * 1.1, gy);
            ctx.stroke();
        }
    }

    private drawDancers(ctx: CanvasRenderingContext2D, row: number, cycle: number, flash: number): void {
        const {vh} = this;
        const rs = ROWS[row].scale;
        const width = this.vw * 0.84 / COLS;
        const scale = vh * 0.2 * rs;
        const gy = this.groundY(row) - 4 * rs * this.thump;
        const list = this.drawList;
        list.length = 0;
        for (const h of this.field.haps) {
            if (h.row !== row || (h.role !== 'bass' && h.role !== 'mid' && h.role !== 'lead')) continue;
            list.push(h);
        }
        list.sort((a, b) => (a.col + a.xOff) - (b.col + b.xOff) || a.begin - b.begin);
        const bone = flash > 0.02 ? lerpRgb(this.flashRgb, this.white, 0.5) : this.bone;
        for (const h of list) {
            const x = this.colX(row, h.col) + h.xOff * width;
            if (h.long) {
                this.drawRisingGhost(ctx, h, x, gy, rs, cycle);
                continue;
            }
            let up: number;
            if (cycle < h.begin) up = smooth((cycle - (h.begin - RISE)) / RISE);
            else if (cycle < h.end) up = 1;
            else up = 1 - smooth((cycle - h.end) / SINK);
            if (up <= 0) continue;
            const sustaining = cycle >= h.begin && cycle < h.end;
            const intensity = clamp01(h.flash + (sustaining ? 0.5 : 0));
            const lean = (rand01(hash32(h.seed, 11)) - 0.5) * 0.1;
            skeletonPose(this.pose, cycle * 4 + h.phaseOff, intensity, h.style, up * h.fade, h.reach);
            ctx.save();
            ctx.translate(x, gy);
            ctx.transform(1, 0, lean, 1, 0, 0);
            drawSkeleton(ctx, this.pose, 0, 0, scale, bone, this.socket, intensity > 0.3 ? h.team.css : null);
            ctx.restore();
        }
    }

    private drawRisingGhost(ctx: CanvasRenderingContext2D, h: Dancer, x: number, gy: number, rs: number, cycle: number): void {
        const t = cycle - h.begin;
        if (t < 0) return;
        const dur = h.end - h.begin;
        const alpha = 0.6 * clamp01(1 - t / (dur + 1)) * clamp01(t / 0.15) * h.fade;
        const w = this.vh * 0.07 * rs;
        const y = gy - w * 0.9 - this.vh * 0.18 * rs * t;
        const sway = Math.sin(TAU * t * 0.6 + h.seed) * w * 0.3;
        const fill = lerpRgb(h.team.rgb, this.ghostRgb, 0.6);
        drawGhost(ctx, x + sway, y, w, w * 1.5, alpha, fill, this.socket, cycle * TAU * 0.5 + h.seed);
    }

    private drawGrass(ctx: CanvasRenderingContext2D, cycle: number): void {
        const {vw, vh} = this;
        ctx.strokeStyle = this.grass;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        for (let i = 0; i < GRASS; i++) {
            const x = (0.02 + 0.96 * rand01(hash32(i, 51))) * vw;
            const y = vh * (0.88 + 0.1 * rand01(hash32(i, 53)));
            const h = vh * (0.02 + 0.025 * rand01(hash32(i, 57)));
            const sway = Math.sin(TAU * cycle * 0.25 + i * 1.3) * 3;
            ctx.beginPath();
            for (let b = -1; b <= 1; b++) {
                ctx.moveTo(x, y);
                ctx.quadraticCurveTo(x + b * 4 + sway * 0.5, y - h * 0.6, x + b * 7 + sway, y - h);
            }
            ctx.stroke();
        }
    }
}

function smooth(t: number): number {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
}

export const graveyardDef: VizModeDef = {
    id: 'graveyard',
    name: 'GRAVEYARD',
    create: () => new GraveyardMode(),
};
