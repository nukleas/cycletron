/**
 * HAUNTED HOUSE — a house on a hill whose windows are the score. Each floor
 * is a register (bass at the ground, mids above, leads under the gable, the
 * tower for the very top) and a note's pitch picks the window, which lights
 * up with a dancer in it for as long as the note sounds. Kicks swing the
 * front door open, hats flare the jack-o'-lanterns on the steps, held notes
 * puff ghosts out of the chimney, snares strike lightning behind the roof,
 * and the weathervane turns once a bar.
 *
 * Window assignment happens once per hap. render() is pure; the door and
 * lanterns are followers advanced in update().
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {type FieldHap, type FieldTeam, HapField, type Rgb} from '../hap-field.js';
import {TAU, alphaRamp, clamp01, follow, hash32, lerpRgb, mixRgb, rand01, rgbOf} from '../util.js';
import {type Role, halloweenRole, isLong, registerPos} from './halloween/roles.js';
import {type Pose, drawSilhouette, makePose, skeletonPose} from './halloween/skeleton.js';
import {type Bolt, GradientCache, ageBolts, boltFlash, drawBolt, drawGhost, drawMoon, drawStars, makeBolt} from './halloween/sky.js';
import {graveFor} from './graveyard.js';

const REFERENCE_HEIGHT = 1080;
const LOOKAHEAD = 2;
const MAX_HAPS = 400;
const MAX_PER_TRACK = 64;
const DRUM_CAP = 16;
const IDLE_RATE = 0.25;
/** Cycles before its onset a window starts to glow. */
const EARLY = 0.05;
const MAX_BOLTS = 4;
const MAX_GHOSTS = 12;
const STARS = 80;
const LANTERNS = 5;
const STEPS = 5;
/** Notes from here up take the tower. */
const TOWER_NOTE = 84;
const FLOOR_H = 0.11;
const GROUND = 0.74;

interface Team extends FieldTeam {}

interface Light extends FieldHap<Team> {
    role: Role;
    long: boolean;
    style: number;
    /** Window index, or -1 for a drum. */
    win: number;
    phaseOff: number;
    flash: number;
}

interface Window {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Window groups by register: index lists into `windows`. */
interface Groups {
    bass: number[];
    mid: number[];
    lead: number[];
    tower: number[];
}

const taken = new Uint8Array(8);

class HauntedHouseMode implements VizMode {
    private readonly field = new HapField<Team, Light>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_HAPS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_RATE,
        team: (base) => base,
        hap: (base) => this.makeLight(base),
        cap: (_team, note) => (Number.isFinite(note) ? Infinity : DRUM_CAP),
        keep: (h, cycle) => h.end + (h.long ? 1 : 0.1) >= cycle,
    });
    private readonly pose: Pose = makePose();
    private readonly bolts: Bolt[] = [];
    private readonly sky = new GradientCache();
    private readonly moonGlow = new GradientCache();
    private readonly fog = new GradientCache();
    private readonly lanterns = new Float32Array(LANTERNS);
    private readonly lit = new Float32Array(24);
    private readonly litBy: (Light | null)[] = new Array(24).fill(null);
    private door = 0;
    private doorHold = 0;
    private doorAmp = 1;
    private vaneKick = 0;

    private vw = 0;
    private vh = 0;
    private renderScale = 1;
    private readonly windows: Window[] = [];
    private groups: Groups = {bass: [], mid: [], lead: [], tower: []};
    private parts: {body: Path2D; roof: Path2D} | null = null;
    private left = 0;
    private doorX = 0;
    private doorW = 0;
    private doorH = 0;
    private chimneyX = 0;
    private chimneyTop = 0;
    private vaneX = 0;
    private vaneY = 0;

    private skyTop = '';
    private skyHorizon = '';
    private moon = '';
    private moonGlowRgb: Rgb = [255, 243, 176];
    private starRamp: string[] = [];
    private tree = '';
    private ground = '';
    private wall = '';
    private wallEdge = '';
    private roof = '';
    private pane = '';
    private lampRgb: Rgb = [255, 243, 176];
    private spill = '';
    private silhouette = '';
    private lantern = '';
    private face = '';
    private fogRgb: Rgb = [0, 0, 0];
    private ghostRgb: Rgb = [255, 255, 255];
    private flashRgb: Rgb = [255, 255, 255];
    private readonly white: Rgb = [255, 255, 255];

    layout(s: VizServices): void {
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.bakePalette(s.theme);
        this.buildHouse();
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
        this.tree = lerpRgb(bg, violet, 0.08);
        this.ground = lerpRgb(bg, violet, 0.14);
        this.wall = lerpRgb(bg, violet, 0.1);
        this.wallEdge = lerpRgb(bg, t.borderRgb, 1);
        this.roof = lerpRgb(bg, violet, 0.05);
        this.pane = lerpRgb(bg, neon, 0.03);
        this.lampRgb = mixRgb(active, this.white, 0.2);
        this.spill = lerpRgb(active, neon, 0.4);
        this.silhouette = t.bg;
        this.lantern = t.neon;
        this.face = t.bg;
        this.fogRgb = mixRgb(t.bgLightRgb, violet, 0.25);
        this.ghostRgb = mixRgb(t.textRgb, this.white, 0.5);
        this.flashRgb = mixRgb(active, this.white, 0.6);
    }

    /** Geometry in frame units: a tower on the left, a three-floor block, a gable, a porch and a chimney. */
    private buildHouse(): void {
        const {vw, vh} = this;
        const u = vh;
        const g = vh * GROUND;
        const cx = vw / 2;
        const left = cx - 0.42 * u;
        this.left = left;
        const towerW = 0.16 * u;
        const blockL = left + towerW;
        const blockR = left + 0.84 * u;
        const blockW = blockR - blockL;
        const bodyH = 3 * FLOOR_H * u;
        const gableH = 0.14 * u;
        const towerH = 0.5 * u;
        const towerRoofH = 0.14 * u;

        const body = new Path2D();
        body.rect(left, g - towerH, towerW, towerH);
        body.rect(blockL, g - bodyH, blockW, bodyH);
        // Chimney.
        const chimneyX = blockL + blockW * 0.82;
        const chimneyW = 0.05 * u;
        this.chimneyX = chimneyX + chimneyW / 2;
        this.chimneyTop = g - bodyH - gableH * 0.9;
        body.rect(chimneyX, this.chimneyTop, chimneyW, gableH * 0.9 + 0.02 * u);
        // Porch roof and posts.
        const porchY = g - FLOOR_H * u * 0.95;
        body.rect(blockL - 0.02 * u, porchY, blockW + 0.04 * u, 0.012 * u);
        for (const px of [blockL - 0.02 * u, blockL + blockW / 2 - 0.09 * u, blockL + blockW / 2 + 0.09 * u, blockR + 0.02 * u]) {
            body.rect(px - 0.004 * u, porchY, 0.008 * u, g - porchY);
        }

        const roof = new Path2D();
        // Gable.
        roof.moveTo(blockL - 0.03 * u, g - bodyH);
        roof.lineTo(cx + 0.08 * u, g - bodyH - gableH);
        roof.lineTo(blockR + 0.03 * u, g - bodyH);
        roof.closePath();
        // Tower spire.
        roof.moveTo(left - 0.02 * u, g - towerH);
        roof.lineTo(left + towerW / 2, g - towerH - towerRoofH);
        roof.lineTo(left + towerW + 0.02 * u, g - towerH);
        roof.closePath();
        this.parts = {body, roof};
        this.vaneX = left + towerW / 2;
        this.vaneY = g - towerH - towerRoofH;

        // Door.
        this.doorW = 0.07 * u;
        this.doorH = 0.085 * u;
        this.doorX = blockL + blockW / 2;

        // Windows: three floors of six, two in the gable, four in the tower.
        const wins = this.windows;
        wins.length = 0;
        const ww = 0.045 * u;
        const wh = 0.065 * u;
        const groups: Groups = {bass: [], mid: [], lead: [], tower: []};
        for (let f = 0; f < 3; f++) {
            const y = g - f * FLOOR_H * u - FLOOR_H * u * 0.6;
            for (let c = 0; c < 6; c++) {
                // Leave the middle of the ground floor to the door.
                const slot = c < 3 ? c : c + 1;
                const x = blockL + blockW * ((slot + 0.5) / 7);
                wins.push({x, y, w: ww, h: wh});
                (f === 0 ? groups.bass : f === 1 ? groups.mid : groups.lead).push(wins.length - 1);
            }
        }
        for (let c = 0; c < 2; c++) {
            wins.push({x: cx + 0.08 * u + (c === 0 ? -0.09 : 0.09) * u, y: g - bodyH - gableH * 0.38, w: ww * 0.8, h: wh * 0.75});
            groups.lead.push(wins.length - 1);
        }
        for (let i = 0; i < 4; i++) {
            wins.push({x: left + towerW / 2, y: g - 0.07 * u - i * FLOOR_H * u, w: ww * 0.7, h: wh});
            groups.tower.push(wins.length - 1);
        }
        this.groups = groups;
    }

    // ---- schedule ---------------------------------------------------------------

    private makeLight(base: FieldHap<Team>): Light {
        const role = halloweenRole(base.team.name, base.note);
        const long = isLong(base.begin, base.end);
        let win = -1;
        if (role === 'bass' || role === 'mid' || role === 'lead') {
            const group = base.note >= TOWER_NOTE ? this.groups.tower : this.groups[role];
            const pos = base.note >= TOWER_NOTE ? clamp01((base.note - TOWER_NOTE) / 12) : registerPos(base.note);
            const want = Math.round(pos * (group.length - 1));
            const slots = taken.subarray(0, group.length);
            slots.fill(0);
            const lo = base.begin - EARLY;
            const hi = base.end + (long ? 1 : 0.1);
            for (const h of this.field.haps) {
                const at = h.win < 0 ? -1 : group.indexOf(h.win);
                if (at < 0) continue;
                if (h.begin - EARLY < hi && h.end + (h.long ? 1 : 0.1) > lo) slots[at] = 1;
            }
            const slot = graveFor(want, base.seed, slots);
            win = group[slot < 0 ? want : slot];
        }
        return {
            ...base, role, long, win,
            style: base.seed & 3,
            phaseOff: rand01(hash32(base.seed, 7)) * 0.25,
            flash: 0,
        };
    }

    update(dt: number, s: VizServices): void {
        const field = this.field;
        field.update(dt, s);
        if (field.restarted) {
            this.bolts.length = 0;
            this.doorHold = 0;
        }
        for (const h of field.haps) {
            h.flash *= Math.exp(-dt * 4);
            if (!field.crossed(h)) continue;
            h.done = true;
            h.flash = 1;
            h.team.activity = 1;
            switch (h.role) {
                case 'kick': this.doorHold = 0.15; this.doorAmp = 1; break;
                case 'tom': if (this.doorHold <= 0) { this.doorHold = 0.15; this.doorAmp = 0.5; } break;
                case 'hat': this.lanterns[h.seed % LANTERNS] = 1; break;
                case 'snare': this.strike(h.seed, 1, 0.25); break;
                case 'crash': this.strike(h.seed, 2, 0.5); break;
                case 'perc': this.vaneKick = 1; break;
                default: break;
            }
        }
        this.door = follow(this.door, this.doorHold > 0 ? this.doorAmp : 0, dt, 18, 4);
        this.doorHold -= dt;
        const k = Math.exp(-dt * 7);
        for (let i = 0; i < LANTERNS; i++) this.lanterns[i] *= k;
        this.vaneKick *= Math.exp(-dt * 5);
        ageBolts(this.bolts, dt);
    }

    private strike(seed: number, forks: number, life: number): void {
        if (this.bolts.length >= MAX_BOLTS) return;
        const x = this.left + (0.1 + 0.7 * rand01(hash32(seed, 9))) * 0.84 * this.vh;
        this.bolts.push(makeBolt(seed, x, -0.02 * this.vh, this.vh * (GROUND - 0.36), forks, life));
    }

    // ---- render -----------------------------------------------------------------

    render(ctx: CanvasRenderingContext2D): void {
        const {vw, vh, field} = this;
        const cycle = field.cycle;
        const flash = boltFlash(this.bolts);
        const g = vh * GROUND;
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);

        ctx.fillStyle = this.sky.linear(ctx, 0, 0, 0, g, [[0, this.skyTop], [1, this.skyHorizon]]);
        ctx.fillRect(0, 0, vw, vh);
        drawStars(ctx, vw, g * 0.9, cycle, STARS, this.starRamp);
        const breathe = field.locked ? 0.3 : 0.5 + 0.5 * Math.sin(TAU * cycle / 4);
        drawMoon(ctx, this.moonGlow, vw * 0.17, vh * 0.17, vh * 0.065, this.moon, this.moonGlowRgb, breathe);
        const flashCss = `rgb(${this.flashRgb[0]}, ${this.flashRgb[1]}, ${this.flashRgb[2]})`;
        for (const b of this.bolts) drawBolt(ctx, b, flashCss, 2);
        if (flash > 0.01) {
            ctx.fillStyle = `rgba(${this.flashRgb[0]}, ${this.flashRgb[1]}, ${this.flashRgb[2]}, ${(0.35 * flash).toFixed(3)})`;
            ctx.fillRect(0, 0, vw, vh);
        }
        this.drawTrees(ctx, g, flash);
        ctx.fillStyle = flash > 0.02 ? this.silhouette : this.ground;
        ctx.fillRect(0, g, vw, vh - g);

        this.drawHouse(ctx, flash);
        this.gatherLights(cycle);
        this.drawWindows(ctx, cycle, flash);
        this.drawDoor(ctx, g);
        this.drawSteps(ctx, g, cycle);
        this.drawChimneyGhosts(ctx, cycle);
        this.drawVane(ctx, cycle);

        const [fr, fg, fb] = this.fogRgb;
        ctx.fillStyle = this.fog.linear(ctx, 0, g - 0.03 * vh, 0, vh, [[0, `rgba(${fr}, ${fg}, ${fb}, 0)`], [0.4, `rgba(${fr}, ${fg}, ${fb}, 0.22)`], [1, `rgba(${fr}, ${fg}, ${fb}, 0.05)`]]);
        ctx.fillRect(0, g - 0.03 * vh, vw, vh);
        ctx.restore();
    }

    private drawTrees(ctx: CanvasRenderingContext2D, g: number, flash: number): void {
        const {vw, vh} = this;
        ctx.fillStyle = flash > 0.02 ? this.silhouette : this.tree;
        ctx.beginPath();
        for (let i = 0; i < 26; i++) {
            const x = (i / 25) * vw + (rand01(hash32(i, 61)) - 0.5) * vw * 0.03;
            const h = vh * (0.05 + 0.08 * rand01(hash32(i, 67)));
            const w = h * 0.35;
            ctx.moveTo(x - w, g + 1);
            ctx.lineTo(x, g - h);
            ctx.lineTo(x + w, g + 1);
        }
        ctx.fill();
    }

    private drawHouse(ctx: CanvasRenderingContext2D, flash: number): void {
        if (!this.parts) return;
        const dark = flash > 0.02;
        ctx.fillStyle = dark ? this.silhouette : this.wall;
        ctx.fill(this.parts.body);
        ctx.fillStyle = dark ? this.silhouette : this.roof;
        ctx.fill(this.parts.roof);
        ctx.strokeStyle = this.wallEdge;
        ctx.lineWidth = 1;
        ctx.stroke(this.parts.body);
        ctx.stroke(this.parts.roof);
    }

    /** Which window each sounding hap lights, and how much. */
    private gatherLights(cycle: number): void {
        this.lit.fill(0);
        this.litBy.fill(null);
        for (const h of this.field.haps) {
            if (h.win < 0 || cycle < h.begin - EARLY) continue;
            const sustaining = cycle >= h.begin && cycle < h.end;
            const early = cycle < h.begin ? 0.3 : 0;
            const lit = Math.max(h.flash, sustaining ? 0.7 : 0, early) * h.fade;
            if (lit > this.lit[h.win]) {
                this.lit[h.win] = lit;
                this.litBy[h.win] = h;
            }
        }
    }

    private drawWindows(ctx: CanvasRenderingContext2D, cycle: number, flash: number): void {
        const idleWin = this.field.locked ? -1 : hash32(Math.floor(cycle * 0.5), 3) % this.windows.length;
        for (let i = 0; i < this.windows.length; i++) {
            const w = this.windows[i];
            const x0 = w.x - w.w / 2;
            const y0 = w.y - w.h / 2;
            ctx.fillStyle = this.pane;
            ctx.fillRect(x0, y0, w.w, w.h);
            let lit = this.lit[i];
            const by = this.litBy[i];
            if (i === idleWin) lit = Math.max(lit, 0.35 + 0.25 * Math.sin(cycle * 23));
            if (lit <= 0.03) continue;
            const rgb = by ? mixRgb(by.team.rgb, this.lampRgb, 0.4) : this.lampRgb;
            const a = lit.toFixed(3);
            // Glow past the frame, then the pane.
            ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(lit * 0.2).toFixed(3)})`;
            ctx.fillRect(x0 - w.w * 0.25, y0 - w.h * 0.2, w.w * 1.5, w.h * 1.4);
            ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
            ctx.fillRect(x0, y0, w.w, w.h);
            if (by && lit > 0.05 && !by.long) {
                const sustaining = cycle >= by.begin && cycle < by.end;
                const intensity = clamp01(by.flash + (sustaining ? 0.5 : 0));
                skeletonPose(this.pose, cycle * 4 + by.phaseOff, intensity, by.style, 1, 0.3);
                ctx.save();
                ctx.beginPath();
                ctx.rect(x0, y0, w.w, w.h);
                ctx.clip();
                drawSilhouette(ctx, this.pose, w.x, y0 + w.h * 0.98, w.h * 0.85, this.silhouette);
                ctx.restore();
            }
            // Mullions.
            ctx.strokeStyle = flash > 0.02 ? this.silhouette : this.wallEdge;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(w.x, y0);
            ctx.lineTo(w.x, y0 + w.h);
            ctx.moveTo(x0, w.y);
            ctx.lineTo(x0 + w.w, w.y);
            ctx.stroke();
        }
    }

    private drawDoor(ctx: CanvasRenderingContext2D, g: number): void {
        const {doorX, doorW, doorH, door} = this;
        const x0 = doorX - doorW / 2;
        const y0 = g - doorH;
        // The opening, lit from inside as the door swings.
        const [lr, lg, lb] = this.lampRgb;
        ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${(0.15 + 0.75 * door).toFixed(3)})`;
        ctx.fillRect(x0, y0, doorW, doorH);
        if (door > 0.02) {
            // Light spill down the steps.
            ctx.save();
            ctx.globalAlpha = door * 0.5;
            ctx.fillStyle = this.spill;
            ctx.beginPath();
            ctx.moveTo(x0, g);
            ctx.lineTo(x0 + doorW, g);
            ctx.lineTo(x0 + doorW * 2.2, g + this.vh * 0.07);
            ctx.lineTo(x0 - doorW * 1.2, g + this.vh * 0.07);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
        // The leaf, hinged on the left, swinging toward us.
        const open = door * (70 / 180) * Math.PI;
        const k = Math.cos(open);
        ctx.save();
        ctx.translate(x0, g);
        ctx.transform(k, 0.22 * Math.sin(open), 0, 1, 0, 0);
        ctx.fillStyle = this.roof;
        ctx.fillRect(0, -doorH, doorW, doorH);
        ctx.strokeStyle = this.wallEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(0, -doorH, doorW, doorH);
        ctx.fillStyle = this.wallEdge;
        ctx.fillRect(doorW * 0.8, -doorH * 0.5, doorW * 0.08, doorW * 0.08);
        ctx.restore();
    }

    private drawSteps(ctx: CanvasRenderingContext2D, g: number, cycle: number): void {
        const {vh, doorX} = this;
        const stepH = vh * 0.012;
        let w = this.doorW * 1.8;
        for (let i = 0; i < STEPS; i++) {
            ctx.fillStyle = i % 2 === 0 ? this.wall : this.roof;
            ctx.fillRect(doorX - w / 2, g + i * stepH, w, stepH);
            w += this.doorW * 0.9;
        }
        // Lanterns along the step edges, alternating sides.
        const r = vh * 0.009;
        const [nr, ng, nb] = rgbOf(this.lantern, [255, 122, 26]);
        for (let i = 0; i < LANTERNS; i++) {
            const side = i % 2 === 0 ? -1 : 1;
            const sw = this.doorW * 1.8 + this.doorW * 0.9 * i;
            const x = doorX + side * (sw / 2 - r * 1.3);
            const y = g + i * stepH - r * 0.9;
            const glow = 0.5 + 0.2 * Math.sin(TAU * (cycle * 3 + i * 0.37)) + this.lanterns[i];
            ctx.fillStyle = `rgba(${nr}, ${ng}, ${nb}, ${(0.14 * glow).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, r * (1.4 + glow), 0, TAU);
            ctx.fill();
            ctx.fillStyle = this.lantern;
            ctx.beginPath();
            ctx.ellipse(x, y, r * 1.1, r, 0, 0, TAU);
            ctx.fill();
            ctx.fillStyle = this.face;
            ctx.beginPath();
            ctx.moveTo(x - r * 0.55, y - r * 0.1);
            ctx.lineTo(x - r * 0.2, y - r * 0.1);
            ctx.lineTo(x - r * 0.38, y - r * 0.45);
            ctx.moveTo(x + r * 0.55, y - r * 0.1);
            ctx.lineTo(x + r * 0.2, y - r * 0.1);
            ctx.lineTo(x + r * 0.38, y - r * 0.45);
            ctx.closePath();
            ctx.fill();
            ctx.fillRect(x - r * 0.5, y + r * 0.25, r, Math.max(1, r * 0.18));
        }
    }

    private drawChimneyGhosts(ctx: CanvasRenderingContext2D, cycle: number): void {
        let n = 0;
        for (const h of this.field.haps) {
            if (!h.long || h.win < 0 || cycle < h.begin) continue;
            if (n++ >= MAX_GHOSTS) break;
            const t = cycle - h.begin;
            const dur = h.end - h.begin;
            const alpha = 0.55 * clamp01(1 - t / (dur + 1)) * clamp01(t / 0.2) * h.fade;
            const w = this.vh * 0.05;
            const x = this.chimneyX - this.vh * 0.08 * t + Math.sin(TAU * t * 0.5 + h.seed) * w * 0.4;
            const y = this.chimneyTop - w * 0.6 - this.vh * 0.14 * t;
            drawGhost(ctx, x, y, w, w * 1.5, alpha, lerpRgb(h.team.rgb, this.ghostRgb, 0.6), this.silhouette, cycle * TAU * 0.5 + h.seed);
        }
    }

    /** A full turn in the first quarter of every bar, plus a twitch on perc. */
    private drawVane(ctx: CanvasRenderingContext2D, cycle: number): void {
        const bar = Math.floor(cycle);
        const turn = bar + smoother(Math.min(1, (cycle - bar) / 0.25));
        const a = TAU * turn + this.vaneKick * 0.5;
        const r = this.vh * 0.028;
        ctx.save();
        ctx.translate(this.vaneX, this.vaneY);
        ctx.strokeStyle = this.wallEdge;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -r * 1.2);
        ctx.stroke();
        ctx.translate(0, -r * 1.2);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(-r, 0);
        ctx.lineTo(r, 0);
        ctx.moveTo(r, 0);
        ctx.lineTo(r * 0.65, -r * 0.25);
        ctx.moveTo(r, 0);
        ctx.lineTo(r * 0.65, r * 0.25);
        ctx.stroke();
        ctx.fillStyle = this.wallEdge;
        ctx.fillRect(-r, -r * 0.2, r * 0.3, r * 0.4);
        ctx.restore();
    }
}

/** Quintic smootherstep, clamped. */
function smoother(t: number): number {
    const x = clamp01(t);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

export const hauntedHouseDef: VizModeDef = {
    id: 'haunted-house',
    name: 'HAUNTED HOUSE',
    create: () => new HauntedHouseMode(),
};
