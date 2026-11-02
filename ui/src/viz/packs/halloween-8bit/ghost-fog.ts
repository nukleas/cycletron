/**
 * GHOST FOG — a swamp at night. One Pac-Man ghost per note: pitch is height,
 * length is 1× or 2×. Each ghost leaves two dim afterimages of its own path.
 * Hats lift wisps, kicks ripple the water, snares catch the moon.
 *
 * No trail fade. The buffer is redrawn from state every frame.
 */

import type {VizMode, VizModeDef, VizServices} from '../../sdk.js';
import {type FieldHap, type FieldTeam, HapField} from '../../sdk.js';
import {clamp01, hash32, rand01, TAU} from '../../sdk.js';
import {bakePix, drawSprite, nearest, PH, PW, PxScreen, type Pix} from './lib/pixel.js';
import {type Role, halloweenRole} from './lib/roles.js';
import {REED} from './lib/sprites.js';
import {drawGhostAt, drawNight, drawRidge, drawTree} from './lib/sky.js';

const LOOKAHEAD = 1;
const MAX_GHOSTS = 240;
const MAX_PER_TRACK = 32;
const DRUM_CAP = 12;
const IDLE_RATE = 0.2;
const TAIL = 0.75;
const MAX_WISPS = 32;
const WISP_LIFE = 1.6;
const MAX_RIPPLES = 8;
const RIPPLE_LIFE = 0.8;
const WATER_Y = 122;
const MOON_X = 36;
const MOON_Y = 16;

interface Team extends FieldTeam {}

interface Ghost extends FieldHap<Team> {
    role: Role;
    x0: number;
    dir: number;
}

interface Wisp {
    age: number;
    x: number;
    y: number;
    phase: number;
}

interface Ripple {
    age: number;
    x: number;
}

interface Place {
    x: number;
    y: number;
    scale: number;
    dim: boolean;
}

class GhostFogMode implements VizMode {
    private readonly screen = new PxScreen();
    private readonly field = new HapField<Team, Ghost>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_GHOSTS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_RATE,
        team: (base) => base,
        hap: (base) => makeGhost(base),
        cap: (_team, note) => (Number.isFinite(note) ? Infinity : DRUM_CAP),
        keep: (h, cycle) => h.end + TAIL + 0.05 >= cycle,
    });
    private readonly wisps: Wisp[] = [];
    private readonly ripples: Ripple[] = [];
    private readonly order: Ghost[] = [];
    private readonly colors = new Map<number, string>();
    private shine = 0;
    private thump = 0;
    private lastIdleWisp = -1;
    private pix!: Pix;

    layout(s: VizServices): void {
        this.pix = bakePix(s.theme);
        this.colors.clear();
        this.field.invalidate();
    }

    update(dt: number, s: VizServices): void {
        const field = this.field;
        field.update(dt, s);
        if (field.restarted) {
            this.wisps.length = 0;
            this.ripples.length = 0;
            this.shine = 0;
            this.thump = 0;
        }
        let spawned = 0;
        for (const h of field.haps) {
            if (!field.crossed(h)) continue;
            h.done = true;
            h.team.activity = 1;
            switch (h.role) {
                case 'hat':
                    if (spawned < 2) { this.spawnWisp(h.seed); spawned++; }
                    break;
                case 'kick':
                    this.thump = 1;
                    if (this.ripples.length < MAX_RIPPLES) {
                        this.ripples.push({age: 0, x: 16 + rand01(hash32(h.seed, 5)) * (PW - 32)});
                    }
                    break;
                case 'snare':
                case 'crash':
                    this.shine = 1;
                    break;
                default:
                    break;
            }
        }
        if (!field.locked) {
            const tick = Math.floor(field.cycle / 2);
            if (tick !== this.lastIdleWisp) {
                this.lastIdleWisp = tick;
                this.spawnWisp(hash32(tick, 41));
            }
        }
        for (let i = this.wisps.length - 1; i >= 0; i--) {
            this.wisps[i].age += dt;
            if (this.wisps[i].age >= WISP_LIFE) this.wisps.splice(i, 1);
        }
        for (let i = this.ripples.length - 1; i >= 0; i--) {
            this.ripples[i].age += dt;
            if (this.ripples[i].age >= RIPPLE_LIFE) this.ripples.splice(i, 1);
        }
        this.shine *= Math.exp(-dt * 4);
        this.thump *= Math.exp(-dt * 9);
    }

    private spawnWisp(seed: number): void {
        if (this.wisps.length >= MAX_WISPS) return;
        this.wisps.push({
            age: 0,
            x: 12 + rand01(hash32(seed, 1)) * (PW - 24),
            y: WATER_Y - 2,
            phase: rand01(hash32(seed, 3)) * TAU,
        });
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const p = this.screen.ctx;
        const cycle = this.field.cycle;
        const hop = this.thump > 0.5 ? 1 : 0;
        p.setTransform(1, 0, 0, 1, 0, hop);
        p.imageSmoothingEnabled = false;
        drawNight(p, this.pix, cycle, 0, MOON_X, MOON_Y, false);
        this.drawSwamp(p, cycle);
        this.drawGhosts(p, cycle);
        this.drawWisps(p);
        p.setTransform(1, 0, 0, 1, 0, 0);
        if (hop) {
            p.fillStyle = this.pix.ink.skyDeep;
            p.fillRect(0, 0, PW, 1);
        }
        this.screen.blit(ctx, s.width, s.height, this.pix.ink.bg);
    }

    private drawSwamp(ctx: CanvasRenderingContext2D, cycle: number): void {
        const {ink} = this.pix;
        ctx.fillStyle = ink.hillDark;
        ctx.fillRect(0, 100, PW, PH - 100);
        ctx.fillStyle = this.pix.hillDither;
        ctx.fillRect(0, 94, PW, 8);
        drawRidge(ctx, 100, ink.sil);
        drawTree(ctx, 4, WATER_Y, 2, ink.line);
        drawTree(ctx, PW - 30, WATER_Y, 2, ink.line);
        drawTree(ctx, 250, 100, 1, ink.sil);

        ctx.fillStyle = this.pix.waterDither;
        ctx.fillRect(0, WATER_Y, PW, PH - WATER_Y);
        const phase = Math.floor(cycle * 5) % 14;
        ctx.fillStyle = ink.moonDim;
        ctx.beginPath();
        for (let y = WATER_Y + 5; y < PH - 2; y += 6) {
            const shift = (phase + y) % 14;
            for (let x = -14 + shift; x < PW; x += 22) {
                ctx.rect(x, y, 8, 1);
                ctx.rect(x + 2, y + 1, 4, 1);
            }
        }
        ctx.fill();
        ctx.fillStyle = ink.hill;
        ctx.fillRect(0, WATER_Y, PW, 2);
        ctx.fillStyle = ink.moonDim;
        ctx.fillRect(0, WATER_Y, PW, 1);

        ctx.fillStyle = ink.stoneDark;
        ctx.fillRect(8, WATER_Y - 3, 40, 3);
        ctx.fillStyle = ink.stone;
        for (let i = 0; i < 3; i++) ctx.fillRect(14 + i * 12, WATER_Y, 3, 8);

        const sway = Math.floor(cycle * 2) & 1;
        for (let i = 0; i < 8; i++) {
            const x = 6 + (hash32(i, 23) % (PW - 14));
            const y = (i % 3 === 0 ? 100 : WATER_Y + 3) - REED.h;
            drawSprite(ctx, REED, x, y, [null, ink.stem, ink.line], {flip: ((sway + i) & 1) === 1});
        }

        for (const r of this.ripples) drawRipple(ctx, r.x, WATER_Y + 3, r.age / RIPPLE_LIFE, ink.moon);
        this.drawReflection(ctx, cycle, this.shine > 0.12 ? ink.moon : ink.moonDim);
    }

    private drawReflection(ctx: CanvasRenderingContext2D, cycle: number, color: string): void {
        const mx = MOON_X + 8;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const y = WATER_Y + 6 + i * 5;
            if (y >= PH) break;
            const wob = ((Math.floor(cycle * 6) + i) & 1) ? 1 : -1;
            const half = 7 - i;
            ctx.rect(mx - half + wob, y, half * 2, 1);
        }
        ctx.fill();
    }

    private drawGhosts(ctx: CanvasRenderingContext2D, cycle: number): void {
        const list = this.order;
        list.length = 0;
        for (const h of this.field.haps) {
            if (h.role === 'bass' || h.role === 'mid' || h.role === 'lead') list.push(h);
        }
        list.sort((a, b) => b.note - a.note);
        for (const h of list) {
            for (const lag of [0.32, 0.16]) this.drawOne(ctx, h, cycle - lag, true);
            this.drawOne(ctx, h, cycle, false);
        }
        if (!this.field.locked) this.drawIdle(ctx, cycle);
    }

    private drawOne(ctx: CanvasRenderingContext2D, h: Ghost, time: number, trail: boolean): void {
        const at = placeGhost(h, time);
        if (!at) return;
        const ink = this.pix.ink;
        const body = trail || at.dim ? ink.purple : this.colorOf(h.team.rgb);
        const bob = (Math.floor(time * 4 + h.seed) & 1) ? -1 : 0;
        drawGhostAt(ctx, at.x, at.y + bob, Math.floor(time * 6 + h.seed), body, ink.line, ink.ghost, trail ? undefined : ink.line, at.scale);
    }

    private drawIdle(ctx: CanvasRenderingContext2D, cycle: number): void {
        const ink = this.pix.ink;
        const k = Math.floor(cycle / 3);
        const t = cycle - k * 3;
        if (t < 0.25 || t > 2.75) return;
        for (let n = 0; n < 2; n++) {
            const seed = hash32(k, n + 1);
            const dir = (seed & 1) === 0 ? 1 : -1;
            const x = (0.15 + 0.7 * rand01(hash32(seed, 1))) * PW + dir * 8 * t;
            const y = 28 + rand01(hash32(seed, 2)) * 48 - t * 3;
            drawGhostAt(ctx, x, y, Math.floor(cycle * 5 + seed), ink.ghost, ink.line, ink.moon);
        }
    }

    private drawWisps(ctx: CanvasRenderingContext2D): void {
        const {ink} = this.pix;
        for (const w of this.wisps) {
            const t = w.age / WISP_LIFE;
            const x = Math.round(w.x + Math.sin(w.age * 3 + w.phase) * 3);
            const y = Math.round(w.y - t * 34);
            const flick = (Math.floor(w.age * 10) & 1) === 0;
            ctx.fillStyle = ink.accent;
            ctx.fillRect(x - 1, y - 1, 3, 3);
            ctx.fillStyle = flick ? ink.moon : ink.stem;
            ctx.fillRect(x, y, 1, 1);
        }
    }

    private colorOf(rgb: readonly [number, number, number]): string {
        return nearest(rgb, this.pix.ink.pool, this.colors);
    }
}

function placeGhost(h: Ghost, time: number): Place | null {
    const t = time - h.begin;
    const dur = h.end - h.begin;
    const life = dur + TAIL;
    if (!(t >= 0 && t <= life)) return null;
    return {
        x: h.x0 * (PW - 16) + h.dir * 24 * t,
        y: 108 - clamp01((h.note - 36) / 60) * 86 - t * 8,
        scale: dur >= 1 ? 2 : 1,
        dim: t < 0.1 || t > life - 0.28,
    };
}

function makeGhost(base: FieldHap<Team>): Ghost {
    const r = (n: number) => rand01(hash32(base.seed, n));
    return {
        ...base,
        role: halloweenRole(base.team.name, base.note),
        x0: 0.08 + 0.84 * r(1),
        dir: (base.seed & 1) === 0 ? 1 : -1,
    };
}

function drawRipple(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, color: string): void {
    const r = 2 + Math.floor(t * 16);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let a = 0; a < 10; a++) {
        const px = x + Math.round(Math.cos((a / 10) * TAU) * r);
        const py = y + Math.round(Math.sin((a / 10) * TAU) * r * 0.35);
        ctx.rect(px, py, 2, 1);
    }
    ctx.fill();
}

export const ghostFogDef: VizModeDef = {
    id: 'ghost-fog',
    name: 'GHOST FOG',
    create: () => new GhostFogMode(),
};
