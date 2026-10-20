/**
 * TANK FIELD — a BZFlag field, seen from a chase camera behind your tank.
 * Distance is musical time: each hap sits at onset × Z_PER_CYCLE and the
 * camera advances at cycle × Z_PER_CYCLE, so everything reaches the firing
 * line, FIRE_D ahead, exactly on its onset. The scheduler already applies BPM.
 *
 * Kicks are enemy tanks in their track's team color; your turret swings onto
 * each and the bolt lands as it sounds. Snares are superflags you grab, other
 * percussion is teleporter gates you pass, and hats spark on the field.
 * Pitched notes are the map: short notes are slate pyramids and sustains are
 * architectural boxes as long as the note, both flashing as you reach them.
 *
 * Dark architectural solids sit against a theme-tinted night horizon. Fine
 * grid lines and accent lighting connect the field to Cycletron's instrument
 * style; compact HUD plates leave the chase view clear.
 *
 * The schedule comes from a two-bar `HapField`, keyed by absolute onset, so
 * held notes keep their identity across bar lines.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import type {InstrumentFamily} from '../tracks.js';
import {HapField, type FieldHap, type FieldTeam, type Rgb} from '../hap-field.js';
import {TAU, clamp01, follow, hash32, lerpRgb, rand01, rgbOf} from '../util.js';
import {Camera, NEAR, TANK_PARTS, TANK_PART_TONE, boxSolid, drawPyramid, drawSolid, placeTank} from './tank-field/scene.js';
import {
    RADAR_BUILDING, drawConsole, drawRadar, drawReticle, drawScoreboard, drawStatusLine,
    type ConsoleLine, type HudLayout, type RadarItem, type ScoreRow,
} from './tank-field/hud.js';

/** World units per cycle: BZFlag's 25 wu/s tank speed at 120 BPM. */
const Z_PER_CYCLE = 50;
const LOOKAHEAD = 2;
/** Targets are hit this far ahead of the eye: 22 wu ahead of your tank. */
const FIRE_D = 34;
/** Chase camera: your tank sits this far ahead of the eye, seen from above. */
const TANK_AHEAD = 12;
const CHASE_EYE = 4.6;
const MUZZLE = 4.94;
/** Muzzle to firing line, which sets the shot's lead time. */
const SHOT_DIST = FIRE_D - TANK_AHEAD - MUZZLE;
const FAR = 150;
const IDLE_DRIFT = 12;
const FOV_Y = (60 * Math.PI) / 180;
/** Gentle heading sway over 8 bars, so the tape scrolls and the radar turns. */
const SWAY = (6 * Math.PI) / 180;
const SHOT_SPEED = 100;
const BOLT_LEN = 5;

const MAX_THINGS = 420;
const MAX_PER_TRACK = 64;
/** Enemy tanks in the two-bar lookahead, per track, so dense kicks don't swarm. */
const MAX_TANKS_PER_TRACK = 8;
const LONG_DUR = 0.35;
const MAX_BURSTS = 40;
const MAX_BOLTS = 16;
const FIRE_LIFE = 0.8;
const FLASH_LIFE = 0.35;
/** World units per second a burst closes on the eye. */
const BURST_CLOSE = 6;
const CONSOLE_LINES = 8;
const FLAG_SCALE = 1.8;
const REFERENCE_HEIGHT = 1080;
const CALLSIGN = 'cycletron';

/** Neutral architectural materials; only musical activity saturates the field. */
const PLAYER_HULL: Rgb = [132, 155, 170];
const GATE_FRAME: Rgb = [115, 178, 185];
const BOX_SIDE: Rgb = [29, 44, 58];
const BOX_ALT: Rgb = [22, 34, 46];
const BOX_LITE: Rgb = [43, 64, 78];
const BOX_TOP: Rgb = [59, 81, 94];
const PYR_SIDE: Rgb = [37, 49, 71];
const PYR_DARK: Rgb = [23, 32, 49];
const PYR_LITE: Rgb = [65, 80, 106];
const FLAG_NAMES = [
    'High Speed', 'Quick Turn', 'Oscillation Overthruster', 'Rapid Fire', 'Machine Gun', 'Guided Missile',
    'Laser', 'Ricochet', 'Super Bullet', 'Invisible Bullet', 'Stealth', 'Tiny', 'Narrow', 'Shield',
    'Steamroller', 'Shock Wave', 'Phantom Zone', 'Genocide', 'Jumping', 'Identify', 'Cloaking', 'Masquerade',
    'Seer', 'Thief', 'Burrow', 'Wings', 'Agility', 'Useless',
] as const;
/** Kick lanes near the nose, by track slot. */
const KICK_LANES = [-3, 3, -5.5, 5.5, 0] as const;

type Kind = 'tank' | 'flag' | 'gate' | 'spark' | 'pyramid' | 'box';
type Role = InstrumentFamily | 'pitched';

/** A track: a player on the scoreboard, a team color on the field. */
interface Team extends FieldTeam {
    kills: number;
    /** Last beat (tanks) or bar (flags) a console line was written for. */
    lastLog: number;
}

interface Thing extends FieldHap<Team> {
    kind: Kind;
    role: Role;
    /** Absolute onset, world z. The firing line adds FIRE_D. */
    z: number;
    x: number;
    /** Tank yaw; π faces the player. */
    heading: number;
    /** Building or gate half-width and height. */
    hw: number;
    height: number;
    flash: number;
    /** Scratch: camera depth for this frame's painter sort. */
    depth: number;
}

interface Burst {
    kind: 'fire' | 'flash';
    x: number;
    y: number;
    /** Distance ahead of the eye when hit; it then rides along with the camera. */
    ahead: number;
    seed: number;
    rgb: Rgb;
    css: string;
    power: number;
    age: number;
    depth: number;
}

function kindFor(role: Role, dur: number): Kind {
    switch (role) {
        case 'pitched': return dur >= LONG_DUR ? 'box' : 'pyramid';
        case 'kick': return 'tank';
        case 'snare': return 'flag';
        case 'hat': return 'spark';
        case 'perc': return 'gate';
    }
}

/** Ridge elevation of the mountain ring at world bearing `b`, degrees. */
function ridge(b: number, layer: number): number {
    let e = layer === 0 ? 2.6 : 0.9;
    const amp = layer === 0 ? 1.6 : 0.8;
    for (const k of [3, 7, 13, 23, 41, 67]) {
        const phase = rand01(hash32(k, 31 + layer)) * TAU;
        e += amp * Math.sin(k * b + phase) * (5 / (k + 2));
    }
    return Math.max(0.25, e);
}

class TankFieldMode implements VizMode {
    private readonly cam = new Camera();
    private readonly field = new HapField<Team, Thing>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_THINGS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_DRIFT / Z_PER_CYCLE,
        team: (base) => ({...base, kills: 0, lastLog: -1}),
        hap: (base) => this.makeThing(base),
        cap: (team, note) => (team.family === 'kick' && !Number.isFinite(note) ? MAX_TANKS_PER_TRACK : Infinity),
        keep: (h, cycle) => (h.kind === 'box' ? h.end * Z_PER_CYCLE : h.z) + FIRE_D + h.hw * 2 + 6 >= cycle * Z_PER_CYCLE - 4,
    });
    private time = 0;
    private themeKey = '';
    private skyTop = '#050910';
    private skyHorizon = '#193844';
    private groundFar = '#11232d';
    private groundNear = '#080e17';
    private grid = '#264d5a';
    private playerCss = 'rgb(71, 246, 255)';

    private readonly bursts: Burst[] = [];
    private readonly drawList: Thing[] = [];
    private readonly radarItems: RadarItem[] = [];
    private readonly lines: ConsoleLine[] = [];
    private readonly meters = new Float32Array([1, 1, 1]);
    private readonly verts = new Float32Array(24);
    private readonly shades = new Map<string, string>();
    private kills = 0;
    private flagName = '';
    private flagAge = 99;
    /** World heading of your turret; it swings onto the next target. */
    private aim = 0;

    private vw = 0;
    private vh = 0;
    private renderScale = 1;
    private sc = 1;
    private focal = 800;
    private horizon = 0;

    layout(s: VizServices): void {
        // Viewport only: the field itself survives a resize untouched.
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.sc = Math.max(0.6, this.vh / REFERENCE_HEIGHT);
        this.focal = this.vh / 2 / Math.tan(FOV_Y / 2);
        // Principal point raised a little: the chase view shows more field.
        this.horizon = this.vh * 0.42;
        this.field.invalidate();
    }

    private get camZ(): number {
        return this.field.cycle * Z_PER_CYCLE;
    }

    private get camLocked(): boolean {
        return this.field.locked;
    }

    update(dt: number, s: VizServices): void {
        this.time += dt;
        this.ensurePalette(s.theme);
        this.field.update(dt, s);
        if (this.field.restarted) {
            this.bursts.length = 0;
            this.aim = this.yaw;
        }
        for (const h of this.field.haps) {
            if (this.field.crossed(h)) this.hit(h, s.cycle);
            h.flash *= Math.exp(-dt * 5);
        }
        this.aim = follow(this.aim, this.aimTarget(), dt, 14, 14);

        for (let i = this.bursts.length - 1; i >= 0; i--) {
            const b = this.bursts[i];
            b.age += dt;
            if (b.age >= (b.kind === 'fire' ? FIRE_LIFE : FLASH_LIFE)) this.bursts.splice(i, 1);
        }
        const reload = dt * Math.max(30, s.bpm) / 60;
        for (let i = 0; i < this.meters.length; i++) this.meters[i] = Math.min(1, this.meters[i] + reload);
        this.flagAge += dt;
    }

    /** HUD and shot color follow the theme. */
    private ensurePalette(t: Theme): void {
        const key = t.bg + t.neon + t.neonSecondary;
        if (key === this.themeKey) return;
        this.themeKey = key;
        const rgb = rgbOf(t.neon, [71, 246, 255]);
        this.skyTop = lerpRgb(t.bgRgb, rgb, 0.025);
        this.skyHorizon = lerpRgb(t.bgRgb, rgb, 0.16);
        this.groundFar = lerpRgb(t.bgRgb, rgb, 0.075);
        this.groundNear = lerpRgb(t.bgRgb, rgb, 0.018);
        this.grid = lerpRgb(t.bgRgb, rgb, 0.25);
        this.playerCss = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }

    // ---------------------------------------------------------------------
    // Schedule
    // ---------------------------------------------------------------------

    /** Lane from the track, details from the hash: stable across rebuilds. */
    private makeThing(base: FieldHap<Team>): Thing {
        const {team, note, seed} = base;
        const role: Role = Number.isFinite(note) ? 'pitched' : team.family;
        const kind = kindFor(role, base.end - base.begin);
        const r = (n: number) => rand01(hash32(seed, n));
        const side = (seed & 1) === 0 ? -1 : 1;
        let x = 0;
        let heading = Math.PI;
        let hw = 0;
        let height = 0;
        if (kind === 'tank') {
            x = KICK_LANES[team.slot % KICK_LANES.length] + (r(3) - 0.5) * 2;
            heading += (r(5) - 0.5) * 0.5;
        } else if (kind === 'flag') {
            x = side * (8 + r(3) * 6);
        } else if (kind === 'gate') {
            x = side * (11 + r(3) * 4);
            hw = 2;
            height = 5.5;
        } else if (kind === 'spark') {
            x = side * (3.5 + r(3) * 8);
        } else {
            const n = Math.min(96, Math.max(24, note));
            height = 3 + ((n - 24) / 72) * 11;
            const lane = ((team.slot + (seed >>> 4)) & 1) === 0 ? -1 : 1;
            hw = kind === 'pyramid' ? 2.5 + r(7) * 2 : 3 + r(7) * 3;
            x = lane * (15 + hw + r(3) * 12);
        }
        return {...base, kind, role, z: base.begin * Z_PER_CYCLE, x, heading, hw, height, flash: 0, depth: 0};
    }

    // ---------------------------------------------------------------------
    // Onsets
    // ---------------------------------------------------------------------

    private hit(h: Thing, cycle: number): void {
        h.flash = 1;
        h.team.activity = Math.min(1, h.team.activity + 0.55);
        if (h.kind === 'pyramid' || h.kind === 'box' || h.kind === 'gate') return;
        h.done = true;
        if (h.kind === 'spark') {
            this.pushBurst({kind: 'flash', x: h.x, y: 0.2, ahead: FIRE_D, seed: h.seed, rgb: [255, 255, 255],
                css: '#ffffff', power: 0.35, age: 0, depth: 0});
            return;
        }
        h.team.kills++;
        this.kills++;
        if (h.kind === 'tank') {
            this.pushBurst({kind: 'fire', x: h.x, y: 1.2, ahead: FIRE_D, seed: h.seed, rgb: h.team.rgb, css: h.team.css,
                power: 1.2, age: 0, depth: 0});
            this.drainMeter();
            const beat = Math.floor(cycle * 4);
            if (beat !== h.team.lastLog) {
                h.team.lastLog = beat;
                this.log([[h.team.name, h.team.css], [': destroyed by ', '#ffffff'], [CALLSIGN, this.playerCss]]);
            }
        } else {
            this.pushBurst({kind: 'flash', x: h.x, y: 1.2 * FLAG_SCALE, ahead: FIRE_D, seed: h.seed, rgb: [255, 255, 255],
                css: '#ffffff', power: 1, age: 0, depth: 0});
            this.flagName = FLAG_NAMES[h.seed % FLAG_NAMES.length];
            this.flagAge = 0;
            const bar = Math.floor(cycle);
            if (bar !== h.team.lastLog) {
                h.team.lastLog = bar;
                this.log([[CALLSIGN, this.playerCss], [`: grabbed ${this.flagName} flag`, '#ffffff']]);
            }
        }
    }

    private pushBurst(b: Burst): void {
        this.bursts.push(b);
        if (this.bursts.length > MAX_BURSTS) this.bursts.shift();
    }

    private drainMeter(): void {
        let best = 0;
        for (let i = 1; i < this.meters.length; i++) if (this.meters[i] > this.meters[best]) best = i;
        this.meters[best] = 0;
    }

    private log(line: ConsoleLine): void {
        this.lines.push(line);
        if (this.lines.length > CONSOLE_LINES) this.lines.shift();
    }

    // ---------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------

    private get yaw(): number {
        return SWAY * Math.sin(TAU * (this.camZ / Z_PER_CYCLE) / 8);
    }

    /** Your tank rides the camera's axis, TANK_AHEAD in front of the eye. */
    private playerAt(): [number, number] {
        const yaw = this.yaw;
        return [Math.sin(yaw) * TANK_AHEAD, this.camZ + Math.cos(yaw) * TANK_AHEAD];
    }

    private muzzleAt(): [number, number, number] {
        const [px, pz] = this.playerAt();
        return [px + Math.sin(this.aim) * MUZZLE, 1.53, pz + Math.cos(this.aim) * MUZZLE];
    }

    /** Heading onto the next enemy tank within a bar, else straight ahead. */
    private aimTarget(): number {
        let next: Thing | null = null;
        for (const h of this.field.haps) {
            if (h.kind !== 'tank' || h.done || !h.seen || h.z < this.camZ) continue;
            if (h.z - this.camZ > Z_PER_CYCLE) continue;
            if (!next || h.z < next.z) next = h;
        }
        if (!next) return this.yaw;
        const [px, pz] = this.playerAt();
        return Math.atan2(next.x - px, next.z + FIRE_D - pz);
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const yaw = this.yaw;
        this.cam.y = CHASE_EYE;
        this.cam.set(this.camZ, yaw, this.focal, this.vw / 2, this.horizon);
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);
        ctx.lineJoin = 'miter';
        this.drawSky(ctx, yaw);
        this.drawGround(ctx);
        this.drawWorld(ctx);
        this.drawBolts(ctx, s.bpm);
        this.drawHud(ctx, s, yaw);
        ctx.restore();
    }

    private drawSky(ctx: CanvasRenderingContext2D, yaw: number): void {
        const {vw, horizon, focal} = this;
        const g = ctx.createLinearGradient(0, 0, 0, horizon);
        g.addColorStop(0, this.skyTop);
        g.addColorStop(1, this.skyHorizon);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, vw, horizon + 1);

        // A broad horizon bloom gives the silhouettes depth without a cloud texture.
        const cx = vw / 2;
        const glow = ctx.createRadialGradient(cx, horizon, 0, cx, horizon, vw * 0.55);
        glow.addColorStop(0, 'rgba(128, 217, 223, 0.065)');
        glow.addColorStop(1, 'rgba(128, 217, 223, 0)');
        ctx.fillStyle = glow; ctx.fillRect(0, 0, vw, horizon);

        // Mountain ring: two ridgelines, far and hazy, near and dark. It sits
        // far beyond the field, so only the heading moves it.
        for (let layer = 0; layer < 2; layer++) {
            ctx.fillStyle = layer === 0 ? '#182d3a' : '#0d1b27';
            ctx.beginPath();
            ctx.moveTo(-2, horizon + 1);
            for (let x = -2; x <= vw + 8; x += 8) {
                const b = yaw + Math.atan((x - cx) / focal);
                ctx.lineTo(x, horizon - Math.tan(ridge(b, layer) * Math.PI / 180) * focal);
            }
            ctx.lineTo(vw + 8, horizon + 1);
            ctx.closePath();
            ctx.fill();
        }
    }

    private drawGround(ctx: CanvasRenderingContext2D): void {
        const {vw, vh, horizon, cam} = this;
        const g = ctx.createLinearGradient(0, horizon, 0, vh);
        g.addColorStop(0, this.groundFar);
        g.addColorStop(1, this.groundNear);
        ctx.fillStyle = g;
        ctx.fillRect(0, horizon, vw, vh - horizon);

        // Fine ground grid: lines along travel and across it, every
        // 10 wu, fixed to the world so they stream past at the musical speed.
        const step = 10;
        const z0 = this.camZ + NEAR;
        const z1 = this.camZ + FAR;
        ctx.lineWidth = 1;
        ctx.strokeStyle = this.grid;
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        for (let k = -15; k <= 15; k++) cam.segment(ctx, k * step, 0, z0, k * step, 0, z1);
        ctx.stroke();
        ctx.strokeStyle = this.grid;
        for (let band = 0; band < 3; band++) {
            ctx.globalAlpha = 0.38 - band * 0.12;
            ctx.beginPath();
            const from = z0 + (z1 - z0) * band / 3;
            const to = z0 + (z1 - z0) * (band + 1) / 3;
            for (let z = Math.ceil(from / step) * step; z < to; z += step) cam.segment(ctx, -150, 0, z, 150, 0, z);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    /** Things and bursts, far to near. */
    private drawWorld(ctx: CanvasRenderingContext2D): void {
        const {cam} = this;
        const list = this.drawList;
        list.length = 0;
        for (const h of this.field.haps) {
            if (h.kind === 'spark' || ((h.kind === 'tank' || h.kind === 'flag') && h.done)) continue;
            const zFront = h.z + FIRE_D;
            const zBack = h.kind === 'box' ? this.boxBack(h) : zFront + h.hw * 2;
            if (zBack < this.camZ + NEAR || zFront > this.camZ + FAR) continue;
            cam.toCamera(h.x, 0, (Math.max(zFront, this.camZ) + zBack) / 2);
            h.depth = cam.rz;
            list.push(h);
        }
        list.sort((a, b) => b.depth - a.depth);
        for (const b of this.bursts) {
            cam.toCamera(b.x, b.y, this.burstZ(b));
            b.depth = cam.rz;
        }
        const bursts = this.bursts.slice().sort((a, b) => b.depth - a.depth);

        let j = 0;
        let player = false;
        for (const h of list) {
            if (!player && h.depth < TANK_AHEAD) {
                while (j < bursts.length && bursts[j].depth > TANK_AHEAD) this.drawBurst(ctx, bursts[j++]);
                ctx.globalAlpha = 1;
                this.drawPlayer(ctx);
                player = true;
            }
            while (j < bursts.length && bursts[j].depth > h.depth) this.drawBurst(ctx, bursts[j++]);
            const far = 1 - clamp01((h.depth - FAR * 0.7) / (FAR * 0.3));
            ctx.globalAlpha = h.fade * far;
            switch (h.kind) {
                case 'tank': this.drawTank(ctx, h); break;
                case 'flag': this.drawFlag(ctx, h); break;
                case 'gate': this.drawGate(ctx, h); break;
                case 'pyramid': this.drawPyramidThing(ctx, h); break;
                case 'box': this.drawBox(ctx, h); break;
            }
        }
        ctx.globalAlpha = 1;
        if (!player) {
            while (j < bursts.length && bursts[j].depth > TANK_AHEAD) this.drawBurst(ctx, bursts[j++]);
            this.drawPlayer(ctx);
        }
        while (j < bursts.length) this.drawBurst(ctx, bursts[j++]);
    }

    /** Your tank: hull on the travel heading, turret and barrel on the aim. */
    private drawPlayer(ctx: CanvasRenderingContext2D): void {
        const {cam} = this;
        const [px, pz] = this.playerAt();
        const yaw = this.yaw;
        const s = Math.sin(yaw), c = Math.cos(yaw);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.beginPath();
        let ok = true;
        for (const [lx, ly] of [[3.1, 1.6], [-3.1, 1.6], [-3.1, -1.6], [3.1, -1.6]]) {
            if (!cam.project(px + lx * s - ly * c, 0.02, pz + lx * c + ly * s)) { ok = false; break; }
            ctx.lineTo(cam.sx, cam.sy);
        }
        if (ok) ctx.fill();
        for (let p = 0; p < TANK_PARTS.length; p++) {
            placeTank(TANK_PARTS[p], px, pz, p >= 3 ? this.aim : yaw, 1, this.verts);
            const tone = TANK_PART_TONE[p];
            drawSolid(ctx, cam, this.verts, (light) => this.shade(PLAYER_HULL, tone, light));
        }
        ctx.strokeStyle = this.playerCss;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        cam.segment(ctx, px - c * 0.65, 1.56, pz + s * 0.65, px + c * 0.65, 1.56, pz - s * 0.65);
        ctx.stroke();
    }

    /** BZFlag teleporter: a yellow frame around a dark field that flashes. */
    private drawGate(ctx: CanvasRenderingContext2D, h: Thing): void {
        const {cam} = this;
        const z = h.z + FIRE_D;
        const t = 0.35;
        const corners: Array<[number, number]> = [[h.x - h.hw, 0], [h.x - h.hw, h.height], [h.x + h.hw, h.height], [h.x + h.hw, 0]];
        ctx.beginPath();
        for (const [x, y] of corners) {
            if (!cam.project(x, y, z)) return;
            ctx.lineTo(cam.sx, cam.sy);
        }
        ctx.closePath();
        const a = ctx.globalAlpha;
        ctx.fillStyle = h.flash > 0.02 ? lerpRgb([0, 0, 0], h.team.rgb, h.flash) : '#000000';
        ctx.globalAlpha = a * (0.5 + 0.4 * h.flash);
        ctx.fill();
        ctx.globalAlpha = a;
        const frame = (light: number) => this.shade(GATE_FRAME, 1, light);
        for (const [x0, x1, y0, y1] of [
            [h.x - h.hw - t, h.x - h.hw, 0, h.height],
            [h.x + h.hw, h.x + h.hw + t, 0, h.height],
            [h.x - h.hw - t, h.x + h.hw + t, h.height, h.height + t],
        ]) {
            boxSolid(x0, x1, y0, y1, z - t / 2, z + t / 2, this.verts);
            drawSolid(ctx, cam, this.verts, frame);
        }
    }

    /** A box is as long as its note, up to one bar. */
    private boxBack(h: Thing): number {
        return h.z + FIRE_D + Math.max(h.hw * 1.6, Math.min(h.end * Z_PER_CYCLE - h.z, Z_PER_CYCLE));
    }

    /** Lit team color, quantized so the fill strings can be cached. */
    private shade(rgb: Rgb, tone: number, light: number): string {
        const level = Math.round((0.4 + 0.6 * light) * tone * 16);
        const key = `${rgb[0]},${rgb[1]},${rgb[2]}|${level}`;
        let css = this.shades.get(key);
        if (!css) {
            const k = level / 16;
            css = `rgb(${Math.min(255, Math.round(rgb[0] * k))}, ${Math.min(255, Math.round(rgb[1] * k))}, ${Math.min(255, Math.round(rgb[2] * k))})`;
            this.shades.set(key, css);
        }
        return css;
    }

    private drawTank(ctx: CanvasRenderingContext2D, h: Thing): void {
        const rgb = h.team.rgb;
        for (let p = 0; p < TANK_PARTS.length; p++) {
            placeTank(TANK_PARTS[p], h.x, h.z + FIRE_D, h.heading, 1, this.verts);
            const tone = TANK_PART_TONE[p];
            drawSolid(ctx, this.cam, this.verts, (light) => this.shade(rgb, tone, light));
        }
    }

    private drawFlag(ctx: CanvasRenderingContext2D, h: Thing): void {
        const {cam} = this;
        const z = h.z + FIRE_D;
        const top = 1.6 * FLAG_SCALE;
        const bottom = 0.8 * FLAG_SCALE;
        const width = 1.2 * FLAG_SCALE;
        const dir = h.x < 0 ? 1 : -1;
        ctx.strokeStyle = '#6c929f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        cam.segment(ctx, h.x, 0, z, h.x, top, z);
        ctx.stroke();

        // Eight segments, two ripples (BZFlag's 2.4π and 1.724π rad/s).
        const t = this.time + (h.seed % 100) * 0.01;
        const xs: number[] = [];
        const ys: number[] = [];
        for (let row = 0; row < 2; row++) {
            const y0 = row === 0 ? top : bottom;
            for (let i = 0; i <= 8; i++) {
                const u = row === 0 ? i / 8 : (8 - i) / 8;
                const wave = 0.1 * FLAG_SCALE * u * (Math.sin(2.4 * Math.PI * t - u * 5) + Math.sin(1.724 * Math.PI * t - u * 7));
                if (!cam.project(h.x + dir * u * width, y0 + wave, z + wave * 2)) return;
                xs.push(cam.sx);
                ys.push(cam.sy);
            }
        }
        ctx.beginPath();
        ctx.moveTo(xs[0], ys[0]);
        for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
        ctx.closePath();
        ctx.fillStyle = '#f2f2f2';
        ctx.fill();
        ctx.strokeStyle = '#a8a8a8';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    private drawPyramidThing(ctx: CanvasRenderingContext2D, h: Thing): void {
        const accent = h.team.rgb;
        const f = h.flash;
        const css = (rgb: Rgb) => (f > 0.02 ? lerpRgb(rgb, accent, f * 0.85) : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
        drawPyramid(ctx, this.cam, h.x, h.z + FIRE_D + h.hw, h.hw, h.height,
            (side) => css(side === 1 ? PYR_DARK : side === 3 ? PYR_LITE : PYR_SIDE), null);
    }

    private drawBox(ctx: CanvasRenderingContext2D, h: Thing): void {
        // Clip the near end short of the eye; yaw brings far-off flanks closer.
        const z0 = Math.max(h.z + FIRE_D, this.camZ + NEAR + 1 + Math.abs(h.x) * 0.12);
        const z1 = this.boxBack(h);
        if (z1 <= z0) return;
        boxSolid(h.x - h.hw, h.x + h.hw, 0, h.height, z0, z1, this.verts);
        const accent = h.team.rgb;
        const f = h.flash;
        const mix = (rgb: Rgb) => (f > 0.02 ? lerpRgb(rgb, accent, f * 0.8) : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
        drawSolid(ctx, this.cam, this.verts, (light, _nx, ny, nz) => {
            if (ny > 0.5) return mix(BOX_TOP);
            if (ny < -0.5) return null;
            if (Math.abs(nz) > 0.5) return mix(BOX_SIDE);
            return mix(light > 0.3 ? BOX_LITE : BOX_ALT);
        });
    }

    /**
     * Bursts ride along with the tank, closing slowly, so driving at musical
     * speed never carries the eye into an explosion.
     */
    private burstZ(b: Burst): number {
        return this.camZ + b.ahead - b.age * BURST_CLOSE;
    }

    private drawBurst(ctx: CanvasRenderingContext2D, b: Burst): void {
        const {cam} = this;
        const bz = this.burstZ(b);
        if (!cam.project(b.x, b.y, bz)) return;
        const x = cam.sx, y = cam.sy;
        const k = cam.f / cam.rz;
        if (b.kind === 'flash') {
            const t = b.age / FLASH_LIFE;
            ctx.globalAlpha = (1 - t) * 0.9;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2 * this.sc;
            ctx.beginPath();
            // Ground sparks lie flat; flag grabs ring upright.
            const r = (0.3 + 1.2 * t) * b.power * k;
            ctx.ellipse(x, y, r, b.y < 0.5 ? r * 0.3 : r, 0, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = 1;
            return;
        }
        const t = b.age / FIRE_LIFE;
        // Tumbling hull fragments, thrown up and falling back.
        ctx.fillStyle = `rgb(${Math.round(b.rgb[0] * 0.3)}, ${Math.round(b.rgb[1] * 0.3)}, ${Math.round(b.rgb[2] * 0.3)})`;
        ctx.globalAlpha = 1 - t * t;
        for (let i = 0; i < 6; i++) {
            const h = hash32(b.seed, 90 + i);
            const vx = (rand01(h) - 0.5) * 12 * b.power;
            const vy = (5 + rand01(hash32(h, 1)) * 7) * b.power;
            const vz = (rand01(hash32(h, 2)) - 0.5) * 12 * b.power;
            const py = Math.max(0, b.y + vy * b.age - 4.9 * b.age * b.age);
            if (!cam.project(b.x + vx * b.age, py, bz + vz * b.age) || cam.rz < 6) continue;
            const r = Math.min(14 * this.sc, 0.45 * cam.f / cam.rz);
            const spin = b.age * (4 + rand01(hash32(h, 3)) * 8);
            ctx.save();
            ctx.translate(cam.sx, cam.sy);
            ctx.rotate(spin);
            ctx.fillRect(-r, -r * 0.6, r * 2, r * 1.2);
            ctx.restore();
        }
        // Fireball: white core through orange, BZFlag 2.0's explosion.
        const fr = (1.4 + 2.6 * Math.sqrt(t)) * b.power * k;
        if (fr > 0.5) {
            const g = ctx.createRadialGradient(x, y, 0, x, y, fr);
            g.addColorStop(0, 'rgba(255, 255, 235, 1)');
            g.addColorStop(0.35, 'rgba(255, 200, 80, 0.9)');
            g.addColorStop(0.7, 'rgba(255, 100, 10, 0.55)');
            g.addColorStop(1, 'rgba(255, 60, 0, 0)');
            ctx.globalAlpha = Math.pow(1 - t, 1.5);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, fr, 0, TAU);
            ctx.fill();
        }
        // Team-colored death ring, BZFlag 2.4's deathEffect.
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = b.css;
        ctx.lineWidth = 2 * this.sc;
        ctx.beginPath();
        const rr = (1 + 3 * t) * b.power * k;
        ctx.ellipse(x, y + 0.8 * k, rr, rr * 0.3, 0, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    /** Shot progress 0..1, from cycle position so tempo changes never miss. */
    private shotProgress(h: Thing, bpm: number): number {
        if (!this.camLocked || !h.seen || h.done || h.kind !== 'tank') return -1;
        const remaining = (h.z - this.camZ) / Z_PER_CYCLE;
        const lead = (SHOT_DIST / SHOT_SPEED) * Math.max(30, bpm) / 240;
        return remaining >= 0 && remaining <= lead ? 1 - remaining / lead : -1;
    }

    private drawBolts(ctx: CanvasRenderingContext2D, bpm: number): void {
        const {cam} = this;
        const [mx, my, mz] = this.muzzleAt();
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        let count = 0;
        // drawList is far to near; walk it backwards so the nearest shots win the cap.
        for (let i = this.drawList.length - 1; i >= 0 && count < MAX_BOLTS; i--) {
            const h = this.drawList[i];
            const p = this.shotProgress(h, bpm);
            if (p < 0) continue;
            count++;
            const tz = h.z + FIRE_D;
            const dist = Math.hypot(h.x - mx, 1.4 - my, tz - mz);
            const tail = Math.max(0, p - BOLT_LEN / dist);
            const at = (u: number): [number, number, number] => [mx + (h.x - mx) * u, my + (1.4 - my) * u, mz + (tz - mz) * u];
            const [hx, hy, hz] = at(p);
            const [tx, ty, tz2] = at(tail);
            ctx.strokeStyle = this.playerCss;
            ctx.globalAlpha = 0.8;
            ctx.lineWidth = 5 * this.sc;
            ctx.beginPath();
            cam.segment(ctx, tx, ty, tz2, hx, hy, hz);
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5 * this.sc;
            ctx.stroke();
            if (cam.project(hx, hy, hz)) {
                ctx.fillStyle = this.playerCss;
                ctx.beginPath();
                ctx.arc(cam.sx, cam.sy, Math.min(5 * this.sc, Math.max(2, 0.3 * cam.f / cam.rz)), 0, TAU);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    private drawHud(ctx: CanvasRenderingContext2D, s: VizServices, yaw: number): void {
        const L: HudLayout = {vw: this.vw, vh: this.vh, sc: this.sc, theme: s.theme};
        const heading = 90 + yaw * 180 / Math.PI;

        if (this.vh >= 420) {
            // The next target's bearing marks the heading tape.
            let marker: {deg: number; css: string} | null = null;
            for (let i = this.drawList.length - 1; i >= 0; i--) {
                const h = this.drawList[i];
                if (h.kind !== 'tank' || h.done || h.z < this.camZ) continue;
                this.cam.toCamera(h.x, 0, h.z + FIRE_D);
                marker = {deg: Math.atan2(this.cam.rx, this.cam.rz) * 180 / Math.PI, css: h.team.css};
                break;
            }
            drawReticle(ctx, L, this.vw / 2, this.horizon, heading, marker, this.meters, this.playerCss);
        }

        const bar = Math.floor(s.cycle);
        const beat = Math.floor((s.cycle - bar) * 4) + 1;
        drawStatusLine(ctx, L, {
            callsign: CALLSIGN,
            kills: this.kills,
            playerCss: this.playerCss,
            ready: this.camLocked,
            clock: this.camLocked ? `${String(bar).padStart(3, '0')}.${beat}` : '---.-',
            flag: this.flagName,
            flagAlpha: clamp01(1 - (this.flagAge - 1.5) / 0.5),
        });

        if (this.vw >= 860 && this.vh >= 420) {
            const rows: ScoreRow[] = this.field.teams.slice()
                .sort((a, b) => b.activity - a.activity).slice(0, 8)
                .sort((a, b) => a.slot - b.slot)
                .map((t) => ({name: t.name, css: t.css, kills: t.kills, fade: t.fade}));
            if (rows.length) drawScoreboard(ctx, L, rows, 98);
        }

        const narrow = this.vw < 580;
        const side = Math.round(narrow ? Math.min(this.vh * 0.24, this.vw * 0.35) : Math.min(this.vh * 0.23, this.vw * 0.2));
        if (side < 60) return;
        const margin = Math.max(16, 28 * this.sc);
        const ry = this.vh - side - margin;
        const halfFov = Math.atan(Math.tan(FOV_Y / 2) * this.vw / this.vh);
        drawRadar(ctx, margin, ry, side, this.cam, this.collectRadar(s.bpm), 130, halfFov, heading, this.playerCss);
        if (!narrow) {
            const w = Math.min(360, this.vw * 0.3);
            const h = Math.min(side, 130);
            drawConsole(ctx, L, this.vw - margin - w, this.vh - margin - h, w, h, this.lines, this.playerCss);
        }
    }

    private collectRadar(bpm: number): RadarItem[] {
        const items = this.radarItems;
        items.length = 0;
        const [mx, , mz] = this.muzzleAt();
        for (const h of this.field.haps) {
            const z = h.z + FIRE_D;
            if (h.kind === 'spark') continue;
            if (h.kind === 'tank' || h.kind === 'flag') {
                if (h.done) continue;
                items.push({kind: h.kind, x: h.x, z, hw: 0, len: 0, css: h.kind === 'tank' ? h.team.css : '#ffffff', alpha: h.fade});
                const p = this.shotProgress(h, bpm);
                if (p >= 0) items.push({kind: 'shot', x: mx + (h.x - mx) * p, z: mz + (z - mz) * p,
                    hw: 0, len: 0, css: this.playerCss, alpha: 1});
            } else {
                const len = h.kind === 'box' ? this.boxBack(h) - z : h.kind === 'gate' ? 0.4 : h.hw * 2;
                items.push({kind: h.kind === 'gate' ? 'box' : h.kind, x: h.x, z, hw: h.hw, len, css: RADAR_BUILDING, alpha: h.fade * (0.65 + 0.35 * h.flash)});
            }
        }
        return items;
    }
}

export const tankFieldDef: VizModeDef = {
    id: 'tank-field',
    name: 'TANK FIELD',
    create: () => new TankFieldMode(),
};
