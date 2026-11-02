/**
 * HAUNTED HOUSE — a NES mansion. Each floor is a register and pitch picks
 * the window, lit around a pixel monster. Kicks open the door, hats light
 * the porch pumpkins, held notes leave as chimney ghosts, and a crash puts
 * a Big Boo in the attic for a bar.
 *
 * Painted into a 320×180 buffer. The door and lanterns advance in update().
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {type FieldHap, type FieldTeam, type Rgb, HapField} from '../hap-field.js';
import {clamp01, follow, hash32, rand01} from '../util.js';
import {graveFor} from './halloween/graves.js';
import {HOUSE, drawShell} from './halloween/mansion.js';
import {drawBigBoo, drawWindowMonster, windowMonster} from './halloween/monsters.js';
import {bakePix, drawHud, drawSprite, frameRect, nearest, PW, PxScreen, type Pix} from './halloween/pixel.js';
import {type Role, halloweenRole, isLong, registerPos} from './halloween/roles.js';
import {PUMPS} from './halloween/sprites.js';
import {type Bolt, ageBolts, boltFlash, drawBolt, drawGhostAt, drawNight, makeBolt} from './halloween/sky.js';

const LOOKAHEAD = 2;
const MAX_HAPS = 400;
const MAX_PER_TRACK = 64;
const DRUM_CAP = 16;
const IDLE_RATE = 0.25;
const EARLY = 0.05;
const MAX_BOLTS = 4;
const MAX_GHOSTS = 12;
const LANTERNS = 5;
const TOWER_NOTE = 84;

interface Team extends FieldTeam {}

interface Light extends FieldHap<Team> {
    role: Role;
    long: boolean;
    style: number;
    win: number;
    phaseOff: number;
    flash: number;
}

const taken = new Uint8Array(12);
const DIRS: readonly (readonly [number, number])[] = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

class HauntedHouseMode implements VizMode {
    private readonly screen = new PxScreen();
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
    private readonly bolts: Bolt[] = [];
    private readonly lanterns = new Float32Array(LANTERNS);
    private readonly lit = new Float32Array(HOUSE.windows.length);
    private readonly litBy: (Light | null)[] = HOUSE.windows.map(() => null);
    private readonly colors = new Map<number, string>();
    private door = 0;
    private doorHold = 0;
    private doorAmp = 1;
    private vaneKick = 0;
    private thump = 0;
    private booUntil = 0;
    private booRgb: Rgb = [255, 46, 77];
    private pix!: Pix;

    layout(s: VizServices): void {
        this.pix = bakePix(s.theme);
        this.colors.clear();
        this.field.invalidate();
    }

    private makeLight(base: FieldHap<Team>): Light {
        const role = halloweenRole(base.team.name, base.note);
        const long = isLong(base.begin, base.end);
        let win = -1;
        if (role === 'bass' || role === 'mid' || role === 'lead') {
            const group = base.note >= TOWER_NOTE ? HOUSE.groups.tower : HOUSE.groups[role];
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
            this.thump = 0;
            this.booUntil = 0;
        }
        for (const h of field.haps) {
            h.flash *= Math.exp(-dt * 4);
            if (!field.crossed(h)) continue;
            h.done = true;
            h.flash = 1;
            h.team.activity = 1;
            switch (h.role) {
                case 'kick': this.doorHold = 0.15; this.doorAmp = 1; this.thump = 1; break;
                case 'tom':
                    if (this.doorHold <= 0) { this.doorHold = 0.15; this.doorAmp = 0.5; }
                    break;
                case 'hat': this.lanterns[h.seed % LANTERNS] = 1; break;
                case 'snare': this.strike(h.seed, 1, 0.25); break;
                case 'crash':
                    this.strike(h.seed, 2, 0.5);
                    this.booUntil = field.cycle + 1;
                    this.booRgb = [h.team.rgb[0], h.team.rgb[1], h.team.rgb[2]];
                    break;
                case 'perc': this.vaneKick = 1; break;
                default: break;
            }
        }
        this.door = follow(this.door, this.doorHold > 0 ? this.doorAmp : 0, dt, 18, 4);
        this.doorHold -= dt;
        const k = Math.exp(-dt * 7);
        for (let i = 0; i < LANTERNS; i++) this.lanterns[i] *= k;
        this.vaneKick *= Math.exp(-dt * 5);
        this.thump *= Math.exp(-dt * 9);
        ageBolts(this.bolts, dt);
    }

    private strike(seed: number, forks: number, life: number): void {
        if (this.bolts.length >= MAX_BOLTS) return;
        const x = 64 + Math.round(rand01(hash32(seed, 9)) * 180);
        this.bolts.push(makeBolt(seed, x, 8, 70, forks, life));
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const p = this.screen.ctx;
        const cycle = this.field.cycle;
        const flash = boltFlash(this.bolts);
        const hop = this.thump > 0.5 ? 1 : 0;
        p.setTransform(1, 0, 0, 1, 0, hop);
        p.imageSmoothingEnabled = false;
        drawNight(p, this.pix, cycle, flash, 22, 16);
        for (const b of this.bolts) drawBolt(p, b, this.pix.ink.moon);
        drawShell(p, this.pix);
        this.gather(cycle);
        this.drawWindows(p, cycle);
        this.drawDoor(p);
        this.drawPumpkins(p, cycle);
        this.drawTufts(p, cycle);
        this.drawChimneyGhosts(p, cycle);
        this.drawVane(p, cycle);
        p.setTransform(1, 0, 0, 1, 0, 0);
        if (hop) {
            p.fillStyle = this.pix.ink.skyDeep;
            p.fillRect(0, 0, PW, 1);
        }
        drawHud(p, this.pix.ink, 'HAUNTED', cycle, hop === 1 || flash > 0.5);
        this.screen.blit(ctx, s.width, s.height, this.pix.ink.bg);
        this.screen.stampHud(ctx, s.width, s.height);
    }

    private gather(cycle: number): void {
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

    private drawWindows(ctx: CanvasRenderingContext2D, cycle: number): void {
        const ink = this.pix.ink;
        const boo = cycle < this.booUntil;
        const booFrame = Math.floor(cycle * 4) % 3;
        const booAccent = this.colorOf(this.booRgb);
        const idle = this.field.locked ? -1 : hash32(Math.floor(cycle * 0.5), 3) % HOUSE.windows.length;
        for (let i = 0; i < HOUSE.windows.length; i++) {
            const w = HOUSE.windows[i];
            const attic = w.y <= 58;
            ctx.fillStyle = ink.line;
            ctx.fillRect(w.x, w.y, w.w, w.h);
            if (boo && attic) {
                drawBigBoo(ctx, w.x + 1, w.y + 1, w.w - 2, w.h - 2, booFrame, booAccent, ink);
            } else {
                let lit = this.lit[i];
                const by = this.litBy[i];
                if (i === idle) lit = Math.max(lit, 0.4);
                if (lit > 0.08) {
                    ctx.fillStyle = lit > 0.5 && by ? this.colorOf(by.team.rgb) : ink.moonDim;
                    ctx.fillRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
                }
                ctx.fillStyle = ink.wallDark;
                ctx.fillRect(w.x + (w.w >> 1), w.y, 1, w.h);
                ctx.fillRect(w.x, w.y + (w.h >> 1), w.w, 1);
                if (by && lit > 0.5 && !by.long) {
                    const frame = (Math.floor(cycle * 4) + (by.seed % 3)) % 3;
                    drawWindowMonster(
                        ctx, windowMonster(by.seed, by.role),
                        w.x + 1, w.y + 1, w.w - 2, w.h - 2,
                        frame, this.colorOf(by.team.rgb), ink,
                    );
                }
            }
            frameRect(ctx, w.x, w.y, w.w, w.h, ink.stone);
        }
    }

    private drawDoor(ctx: CanvasRenderingContext2D): void {
        const {x, y, w, h} = HOUSE.door;
        const ink = this.pix.ink;
        const gap = Math.round(w * this.door);
        ctx.fillStyle = ink.moon;
        ctx.fillRect(x, y, w, h);
        const slab = w - gap;
        if (slab > 0) {
            ctx.fillStyle = ink.roof;
            ctx.fillRect(x, y, slab, h);
            if (slab > 5) {
                ctx.fillStyle = ink.accent;
                ctx.fillRect(x + slab - 4, y + (h >> 1), 2, 2);
            }
        }
        if (this.door < 0.25) {
            ctx.fillStyle = ink.accent;
            ctx.fillRect(x + 5, y + 8, 2, 2);
            ctx.fillRect(x + 12, y + 8, 2, 2);
        }
        frameRect(ctx, x, y, w, h, ink.line);
        if (this.door > 0.2) {
            const spill = 16 + gap * 2;
            ctx.fillStyle = ink.accentDark;
            ctx.fillRect(x + (w >> 1) - (spill >> 1), HOUSE.yard, spill, 5);
        }
    }

    private drawPumpkins(ctx: CanvasRenderingContext2D, cycle: number): void {
        const ink = this.pix.ink;
        const grin = (Math.floor(cycle * 4) & 1) === 1;
        for (let i = 0; i < HOUSE.pumpkins.length; i++) {
            const spot = HOUSE.pumpkins[i];
            const lit = this.lanterns[i] > 0.25;
            drawSprite(ctx, PUMPS[lit && grin ? 1 : 0], spot.x, spot.y, [
                null, lit ? ink.accent : ink.accentDark, ink.stem, lit ? ink.moon : ink.line,
            ], {outline: ink.line});
        }
    }

    private drawTufts(ctx: CanvasRenderingContext2D, cycle: number): void {
        const sway = Math.floor(cycle * 3) & 1;
        ctx.fillStyle = this.pix.ink.green;
        ctx.beginPath();
        for (let i = 0; i < 14; i++) {
            const x = hash32(i, 81) % (PW - 8);
            if (x > 78 && x < 250) continue;
            const y = HOUSE.yard + 2 + (hash32(i, 83) % 8);
            ctx.rect(x, y, 1, 2);
            ctx.rect(x - 1 + sway, y - 2, 1, 2);
        }
        ctx.fill();
    }

    private drawChimneyGhosts(ctx: CanvasRenderingContext2D, cycle: number): void {
        const ink = this.pix.ink;
        const {chimney} = HOUSE;
        let n = 0;
        for (const h of this.field.haps) {
            if (!h.long || h.win < 0 || cycle < h.begin) continue;
            if (n++ >= MAX_GHOSTS) break;
            const t = cycle - h.begin;
            const dur = h.end - h.begin;
            const k = clamp01(t / 0.2) * clamp01(1 - t / (dur + 1)) * h.fade;
            if (k < 0.08) continue;
            const sway = (Math.floor(cycle * 3 + h.seed) & 1) ? 1 : -1;
            const body = k < 0.35 ? ink.purple : this.colorOf(h.team.rgb);
            drawGhostAt(
                ctx, chimney.x - 2 + sway - t * 16, chimney.y - 12 - t * 18,
                Math.floor(cycle * 6 + h.seed), body, ink.line, ink.ghost, ink.line,
            );
        }
    }

    /** Eight headings. A full turn across the first quarter of the bar. */
    private drawVane(ctx: CanvasRenderingContext2D, cycle: number): void {
        const {x, y} = HOUSE.vane;
        const bar = Math.floor(cycle);
        const turn = smoother(Math.min(1, (cycle - bar) / 0.25));
        let d = Math.floor(turn * 8) % 8;
        if (this.vaneKick > 0.45) d = (d + 1) & 7;
        const [dx, dy] = DIRS[d];
        ctx.fillStyle = this.pix.ink.bone;
        ctx.fillRect(x, y, 2, 10);
        const ax = x;
        const ay = y - 6;
        for (let i = 1; i <= 7; i++) ctx.fillRect(ax + dx * i, ay + dy * i, 2, 2);
        ctx.fillRect(ax + dx * 7 - 1, ay + dy * 7 - 1, 3, 3);
    }

    private colorOf(rgb: readonly [number, number, number]): string {
        return nearest(rgb, this.pix.ink.pool, this.colors);
    }
}

function smoother(t: number): number {
    const x = clamp01(t);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

export const hauntedHouseDef: VizModeDef = {
    id: 'haunted-house',
    name: 'HAUNTED HOUSE',
    create: () => new HauntedHouseMode(),
};
