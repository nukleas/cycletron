/**
 * GRAVEYARD — an 8-bit yard. Bass stands in front, leads in back, and pitch
 * picks the column. The skeleton climbs out, cycles a dance on the beat, and
 * sinks. Held notes are ghosts. Kicks hop the ground, snares throw bolts,
 * hats send bats.
 *
 * Painted into a 320×180 buffer. Spawns run in update().
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {type FieldHap, type FieldTeam, HapField} from '../hap-field.js';
import {clamp01, hash32, rand01} from '../util.js';
import {COLS, graveFor} from './halloween/graves.js';
import {bakePix, drawHud, drawSprite, HUD_Y, nearest, PW, PxScreen, type Pix} from './halloween/pixel.js';
import {type Role, halloweenRole, isLong, registerPos} from './halloween/roles.js';
import {danceFrame, drawDancer} from './halloween/skeleton.js';
import {TOMBS} from './halloween/sprites.js';
import {type Bat, type Bolt, ageBats, ageBolts, boltFlash, drawBats, drawBolt, drawGhostAt, drawNight, drawTree, makeBat, makeBolt} from './halloween/sky.js';

const LOOKAHEAD = 2;
const MAX_HAPS = 400;
const MAX_PER_TRACK = 64;
const DRUM_CAP = 16;
const IDLE_RATE = 0.25;
const RISE = 0.12;
const SINK = 0.3;
const MAX_BOLTS = 4;
const MAX_BATS = 24;
const ROW_Y = [96, 126, 156];

interface Team extends FieldTeam {}

interface Dancer extends FieldHap<Team> {
    role: Role;
    long: boolean;
    style: number;
    row: number;
    col: number;
    xOff: number;
    reach: number;
    phaseOff: number;
    flash: number;
}

const taken = new Uint8Array(COLS);

class GraveyardMode implements VizMode {
    private readonly screen = new PxScreen();
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
    private readonly bolts: Bolt[] = [];
    private readonly bats: Bat[] = [];
    private readonly drawList: Dancer[] = [];
    private readonly colors = new Map<number, string>();
    private thump = 0;
    private lastIdleBat = -1;
    private pix!: Pix;

    layout(s: VizServices): void {
        this.pix = bakePix(s.theme);
        this.colors.clear();
        this.field.invalidate();
    }

    private makeDancer(base: FieldHap<Team>): Dancer {
        const role = halloweenRole(base.team.name, base.note);
        const long = isLong(base.begin, base.end);
        const r = (n: number) => rand01(hash32(base.seed, n));
        let row = 1;
        let col = Math.floor(r(2) * COLS);
        let xOff = 0;
        if (role === 'bass' || role === 'mid' || role === 'lead') {
            row = role === 'lead' ? 0 : role === 'mid' ? 1 : 2;
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
                    if (bats < 2 && this.bats.length < MAX_BATS) {
                        this.bats.push(makeBat(h.seed));
                        bats++;
                    }
                    break;
                default: break;
            }
        }
        if (!field.locked) {
            const tick = Math.floor(field.cycle / 4);
            if (tick !== this.lastIdleBat) {
                this.lastIdleBat = tick;
                if (this.bats.length < MAX_BATS) this.bats.push(makeBat(hash32(tick, 1)));
            }
        }
        ageBolts(this.bolts, dt);
        ageBats(this.bats, dt);
        this.thump *= Math.exp(-dt * 9);
    }

    private strike(seed: number, forks: number, life: number): void {
        if (this.bolts.length >= MAX_BOLTS) return;
        const x = Math.round(16 + rand01(hash32(seed, 9)) * (PW - 32));
        this.bolts.push(makeBolt(seed, x, 8, ROW_Y[0] - 4, forks, life));
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const p = this.screen.ctx;
        const hop = this.thump > 0.5 ? 1 : 0;
        const flash = boltFlash(this.bolts);
        p.setTransform(1, 0, 0, 1, 0, hop);
        p.imageSmoothingEnabled = false;
        drawNight(p, this.pix, this.field.cycle, flash, 248, 16);
        this.drawYard(p);
        p.setTransform(1, 0, 0, 1, 0, 0);
        if (hop) {
            p.fillStyle = this.pix.ink.skyDeep;
            p.fillRect(0, 0, PW, 1);
        }
        drawHud(p, this.pix.ink, 'GRAVEYARD', this.field.cycle, hop === 1 || flash > 0.5);
        this.screen.blit(ctx, s.width, s.height, this.pix.ink.bg);
        this.screen.stampHud(ctx, s.width, s.height);
    }

    private drawYard(ctx: CanvasRenderingContext2D): void {
        const {ink} = this.pix;
        const cycle = this.field.cycle;
        ctx.fillStyle = ink.hillDark;
        ctx.fillRect(0, 68, PW, HUD_Y - 68);
        ctx.fillStyle = this.pix.hillDither;
        ctx.fillRect(0, 62, PW, 8);
        ctx.fillStyle = ink.dirt;
        ctx.fillRect(0, 108, PW, HUD_Y - 108);
        ctx.fillStyle = ink.hill;
        ctx.fillRect(0, 140, PW, HUD_Y - 140);
        ctx.fillStyle = ink.dirt;
        ctx.fillRect(152, 68, 16, HUD_Y - 68);
        for (const x of [24, 70, 230, 276]) drawTree(ctx, x, 68, 1, ink.sil);
        drawFence(ctx, 60, ink.line);
        drawTree(ctx, 2, ROW_Y[0], 2, ink.line);
        drawTree(ctx, PW - 28, ROW_Y[0], 2, ink.line);
        for (const b of this.bolts) drawBolt(ctx, b, ink.moon);
        for (let row = 0; row < ROW_Y.length; row++) {
            this.drawTombs(ctx, row);
            this.drawDancers(ctx, row, cycle);
        }
        drawBats(ctx, this.bats, ink.line);
        this.drawGrass(ctx, cycle);
    }

    private drawTombs(ctx: CanvasRenderingContext2D, row: number): void {
        const {ink} = this.pix;
        const gy = ROW_Y[row];
        for (let col = 0; col < COLS; col++) {
            const shape = TOMBS[hash32(row * 17 + col, 3) % TOMBS.length];
            const x = colX(row, col, 0);
            drawSprite(ctx, shape, x - (shape.w >> 1), gy - shape.h - 2, [null, ink.stone, ink.stoneDark], {outline: ink.line});
        }
    }

    private drawDancers(ctx: CanvasRenderingContext2D, row: number, cycle: number): void {
        const {ink} = this.pix;
        const list = this.drawList;
        list.length = 0;
        for (const h of this.field.haps) {
            if (h.row !== row || (h.role !== 'bass' && h.role !== 'mid' && h.role !== 'lead')) continue;
            list.push(h);
        }
        list.sort((a, b) => (a.col + a.xOff) - (b.col + b.xOff) || a.begin - b.begin);
        const gy = ROW_Y[row];
        for (const h of list) {
            const x = colX(row, h.col, h.xOff);
            if (h.long) {
                this.drawRisingGhost(ctx, h, x, gy, cycle);
                continue;
            }
            let up: number;
            if (cycle < h.begin) up = smooth((cycle - (h.begin - RISE)) / RISE);
            else if (cycle < h.end) up = 1;
            else up = 1 - smooth((cycle - h.end) / SINK);
            up *= h.fade;
            if (up <= 0) continue;
            ctx.fillStyle = ink.line;
            ctx.fillRect(x - 6, gy - 2, 12, 3);
            const dancing = cycle >= h.begin && cycle < h.end;
            const frame = dancing ? danceFrame(cycle * 4 + h.phaseOff, h.reach > 0.72 ? 0 : h.style) : 0;
            const bone = h.flash > 0.4 ? ink.moon : ink.bone;
            const eye = dancing ? this.colorOf(h.team.rgb) : ink.line;
            drawDancer(ctx, x, gy, frame, up, bone, eye, ink.line);
        }
    }

    private drawRisingGhost(ctx: CanvasRenderingContext2D, h: Dancer, x: number, gy: number, cycle: number): void {
        const t = cycle - h.begin;
        if (t < 0) return;
        const {ink} = this.pix;
        const dur = h.end - h.begin;
        const k = clamp01(t / 0.15) * clamp01(1 - t / (dur + 1)) * h.fade;
        if (k < 0.08) return;
        ctx.fillStyle = ink.line;
        ctx.fillRect(x - 6, gy - 2, 12, 3);
        const sway = (Math.floor(cycle * 3 + h.seed) & 1) ? 1 : -1;
        const body = k < 0.35 ? ink.purple : this.colorOf(h.team.rgb);
        drawGhostAt(ctx, x - 6 + sway, gy - 16 - t * 20, Math.floor(cycle * 6 + h.seed), body, ink.line, ink.ghost, ink.line);
    }

    private drawGrass(ctx: CanvasRenderingContext2D, cycle: number): void {
        const sway = Math.floor(cycle * 3) & 1;
        ctx.fillStyle = this.pix.ink.green;
        ctx.beginPath();
        for (let i = 0; i < 26; i++) {
            const x = 4 + (hash32(i, 51) % (PW - 10));
            const y = 152 + (hash32(i, 53) % 12);
            if (y >= HUD_Y - 2) continue;
            ctx.rect(x, y, 1, 2);
            ctx.rect(x - 1 + sway, y - 2, 1, 2);
            ctx.rect(x + 1 + sway, y - 1, 1, 2);
        }
        ctx.fill();
    }

    private colorOf(rgb: readonly [number, number, number]): string {
        return nearest(rgb, this.pix.ink.pool, this.colors);
    }
}

function colX(row: number, col: number, xOff: number): number {
    const span = PW - 36;
    const w = span / COLS;
    const stagger = row === 0 ? w * 0.45 : 0;
    return Math.round(18 + stagger + w * (col + 0.5 + xOff));
}

function drawFence(ctx: CanvasRenderingContext2D, y: number, color: string): void {
    const gate0 = 148;
    const gate1 = 174;
    ctx.fillStyle = color;
    ctx.fillRect(0, y, gate0, 2);
    ctx.fillRect(gate1, y, PW - gate1, 2);
    ctx.fillRect(0, y + 5, gate0, 1);
    ctx.fillRect(gate1, y + 5, PW - gate1, 1);
    for (let x = 2; x < PW; x += 12) {
        if (x > gate0 - 4 && x < gate1) continue;
        ctx.fillRect(x, y - 3, 2, 11);
    }
    ctx.fillRect(gate0 - 3, y - 8, 3, 18);
    ctx.fillRect(gate1, y - 8, 3, 18);
    ctx.fillRect(gate0 - 2, y - 11, 1, 3);
    ctx.fillRect(gate1 + 1, y - 11, 1, 3);
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
