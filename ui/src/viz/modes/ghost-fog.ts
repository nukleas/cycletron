/**
 * GHOST FOG — ghosts drifting through fog over a swamp, one per note. A calm
 * trail mode: the host fades the background instead of clearing it, so each
 * ghost smears into fog behind it. Pitch is height, length is size, and the
 * hats send will-o'-wisps up from the water; kicks ripple it, snares catch
 * the moon's reflection.
 *
 * Nothing here paints the whole frame, or the trails would vanish. Spawns
 * happen in update(); render() is a pure function of the field and the pools.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {type FieldHap, type FieldTeam, HapField, type Rgb} from '../hap-field.js';
import {TAU, alphaRamp, clamp01, hash32, lerpRgb, mixRgb, rampAt, rand01, rgbOf} from '../util.js';
import {type Role, halloweenRole} from './halloween/roles.js';
import {drawGhost} from './halloween/sky.js';

const REFERENCE_HEIGHT = 1080;
const LOOKAHEAD = 1;
const MAX_GHOSTS = 240;
const MAX_PER_TRACK = 32;
const DRUM_CAP = 12;
const IDLE_RATE = 0.2;
/** Cycles a ghost lingers after its note ends. */
const TAIL = 0.75;
const MAX_WISPS = 32;
const WISP_LIFE = 1.6;
const MAX_RIPPLES = 8;
const RIPPLE_LIFE = 0.8;
const WATER_Y = 0.72;
const REEDS = 8;

interface Team extends FieldTeam {}

interface Ghost extends FieldHap<Team> {
    role: Role;
    /** Start x as a fraction of the frame width. */
    x0: number;
    dir: number;
    /** Size as a fraction of the frame height. */
    size: number;
}

interface Wisp {
    age: number;
    x0: number;
    y0: number;
    phase: number;
}

interface Ripple {
    age: number;
    x: number;
}

class GhostFogMode implements VizMode {
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
    private shine = 0;
    private lastIdleWisp = -1;

    private vw = 0;
    private vh = 0;
    private renderScale = 1;
    private ghostFill = '#ffffff';
    private ghostEye = '#000000';
    private wispRamp: string[] = [];
    private rippleRamp: string[] = [];
    private moonCss = '';
    private moonFill = '';
    private waterCss = '';
    private reedCss = '';
    private shineRamp: string[] = [];
    private white: Rgb = [255, 255, 255];

    layout(s: VizServices): void {
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        const t = s.theme;
        const ghost = mixRgb(t.textRgb, this.white, 0.5);
        this.ghostFill = `rgb(${ghost[0]}, ${ghost[1]}, ${ghost[2]})`;
        this.ghostEye = t.bg;
        this.wispRamp = alphaRamp(rgbOf(t.neon, [255, 122, 26]));
        this.rippleRamp = alphaRamp(rgbOf(t.neonSecondary, [138, 60, 255]));
        const moon = alphaRamp(rgbOf(t.active, [255, 243, 176]));
        this.moonCss = rampAt(moon, 0.35);
        this.moonFill = rampAt(moon, 0.08);
        this.shineRamp = moon;
        const border = alphaRamp(t.borderRgb);
        this.waterCss = rampAt(border, 0.3);
        this.reedCss = rampAt(border, 0.45);
        this.field.invalidate();
    }

    update(dt: number, s: VizServices): void {
        const field = this.field;
        field.update(dt, s);
        if (field.restarted) {
            this.wisps.length = 0;
            this.ripples.length = 0;
            this.shine = 0;
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
                    if (this.ripples.length < MAX_RIPPLES) this.ripples.push({age: 0, x: 0.15 + 0.7 * rand01(hash32(h.seed, 5))});
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
            // Idle: a wisp every other cycle keeps the swamp alive.
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
    }

    private spawnWisp(seed: number): void {
        if (this.wisps.length >= MAX_WISPS) return;
        this.wisps.push({age: 0, x0: 0.08 + 0.84 * rand01(hash32(seed, 1)), y0: WATER_Y - 0.02 * rand01(hash32(seed, 2)), phase: rand01(hash32(seed, 3)) * TAU});
    }

    render(ctx: CanvasRenderingContext2D): void {
        const {vw, vh, field} = this;
        const cycle = field.cycle;
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);
        ctx.lineCap = 'round';

        // Moon, thin, so the trails show through it.
        const mx = vw * 0.18;
        const my = vh * 0.2;
        const mr = vh * 0.06;
        ctx.fillStyle = this.moonFill;
        ctx.beginPath();
        ctx.arc(mx, my, mr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = this.moonCss;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Water line and its reflection of the moon.
        const wy = vh * WATER_Y;
        ctx.strokeStyle = this.waterCss;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, wy);
        ctx.lineTo(vw, wy);
        ctx.stroke();
        if (this.shine > 0.02) {
            ctx.strokeStyle = rampAt(this.shineRamp, this.shine * 0.6);
            ctx.lineWidth = 2;
            for (let i = 0; i < 4; i++) {
                const y = wy + 6 + i * 9;
                const half = mr * (1.1 - i * 0.2) * (0.8 + 0.2 * Math.sin(cycle * 7 + i));
                ctx.beginPath();
                ctx.moveTo(mx - half, y);
                ctx.lineTo(mx + half, y);
                ctx.stroke();
            }
        }

        // Reeds.
        ctx.strokeStyle = this.reedCss;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < REEDS; i++) {
            const x = (0.04 + 0.92 * rand01(hash32(i, 23))) * vw;
            const h = (0.06 + 0.07 * rand01(hash32(i, 29))) * vh;
            const sway = Math.sin(cycle * TAU * 0.25 + i) * 4;
            ctx.beginPath();
            ctx.moveTo(x, wy + 2);
            ctx.quadraticCurveTo(x + sway * 0.5, wy - h * 0.5, x + sway, wy - h);
            ctx.stroke();
        }

        // Ripples.
        for (const r of this.ripples) {
            const t = r.age / RIPPLE_LIFE;
            ctx.strokeStyle = rampAt(this.rippleRamp, (1 - t) * 0.3);
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.ellipse(r.x * vw, wy, vh * 0.1 * t + 2, vh * 0.018 * t + 1, 0, 0, TAU);
            ctx.stroke();
        }

        // Ghosts.
        for (const h of field.haps) {
            if (h.role !== 'bass' && h.role !== 'mid' && h.role !== 'lead') continue;
            const t = cycle - h.begin;
            if (t < 0) continue;
            const dur = h.end - h.begin;
            const life = dur + TAIL;
            const fadeIn = clamp01(t / 0.1);
            const fadeOut = clamp01((life - t) / TAIL);
            const alpha = (0.55 / (1 + dur)) * fadeIn * fadeOut * h.fade;
            const x = (h.x0 + h.dir * 0.06 * t) * vw;
            const y = (0.68 - 0.56 * clamp01((h.note - 36) / 60)) * vh - t * 0.02 * vh;
            const size = h.size * vh;
            const fill = lerpRgb(h.team.rgb, this.white, 0.5);
            drawGhost(ctx, x, y, size, size * 1.5, alpha, fill, this.ghostEye, cycle * TAU * 0.5 + h.seed);
        }
        if (!field.locked) this.drawIdleGhosts(ctx, cycle);

        // Wisps.
        for (const w of this.wisps) {
            const t = w.age / WISP_LIFE;
            const x = (w.x0 + 0.04 * Math.sin(TAU * (w.age * 0.7 + w.phase))) * vw;
            const y = (w.y0 - 0.08 * t) * vh;
            const a = Math.sin(t * Math.PI);
            ctx.fillStyle = rampAt(this.wispRamp, a * 0.3);
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, TAU);
            ctx.fill();
            ctx.fillStyle = rampAt(this.wispRamp, a);
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, TAU);
            ctx.fill();
        }
        ctx.restore();
    }

    /** Two seeded ghosts per 3-cycle window while nothing plays. */
    private drawIdleGhosts(ctx: CanvasRenderingContext2D, cycle: number): void {
        const k = Math.floor(cycle / 3);
        const t = cycle - k * 3;
        for (let n = 0; n < 2; n++) {
            const seed = hash32(k, n + 1);
            const dir = (seed & 1) === 0 ? 1 : -1;
            const x = (0.15 + 0.7 * rand01(hash32(seed, 1)) + dir * 0.05 * t) * this.vw;
            const y = (0.25 + 0.35 * rand01(hash32(seed, 2)) - 0.02 * t) * this.vh;
            const alpha = 0.22 * Math.sin((t / 3) * Math.PI);
            drawGhost(ctx, x, y, 0.06 * this.vh, 0.09 * this.vh, alpha, this.ghostFill, this.ghostEye, cycle * TAU * 0.5 + seed);
        }
    }
}

function makeGhost(base: FieldHap<Team>): Ghost {
    const dur = base.end - base.begin;
    const r = (n: number) => rand01(hash32(base.seed, n));
    return {
        ...base,
        role: halloweenRole(base.team.name, base.note),
        x0: 0.1 + 0.8 * r(1),
        dir: (base.seed & 1) === 0 ? 1 : -1,
        size: 0.05 * (1 + Math.min(2, dur) * 0.6),
    };
}

export const ghostFogDef: VizModeDef = {
    id: 'ghost-fog',
    name: 'GHOST FOG',
    // Slower fades (0.12) left residue older than the 3 s preroll, failing the render seam test.
    trailFade: 0.16,
    create: () => new GhostFogMode(),
};
