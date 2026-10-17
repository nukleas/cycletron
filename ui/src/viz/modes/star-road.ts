/**
 * STAR ROAD — a kart race along a rainbow ribbon in deep space, in the N64
 * spirit: a smoked-glass spectral road, luminous edge rails, neon signs in
 * the void. Distance is musical time: each hap sits at onset × Z_PER_CYCLE
 * and the camera advances at cycle × Z_PER_CYCLE, so your kart reaches every
 * object exactly on its onset. The scheduler already applies BPM.
 *
 * Kicks are dash panels (boost), snares are item boxes you smash, hats are
 * coins, other percussion is a rainbow ring you drive through. Pitched notes
 * light tiles across the road by pitch; a held note is a drift, its sparks
 * climbing blue, orange, purple, and releasing it fires a mini-turbo. Each
 * unpitched drum track is a rival kart that surges when its track plays.
 *
 * Your kart takes a smooth line through the panels and boxes ahead; coins lie
 * on that line. The chase camera rides the road and lags behind the kart.
 * Everything is a function of the schedule, the cycle and accumulated time,
 * so offline renders replay exactly.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {HapField, type FieldHap, type FieldTeam, type Rgb} from '../hap-field.js';
import {MONO_FONT, TAU, clamp01, follow, hash32, rand01, rgbOf} from '../util.js';
import {
    BAND_RGB, HALF_WIDTH, RoadCamera, drawRails, drawRoad, drawSigns, drawSpace,
    roadCurve, roadHeading, roadX, roadY, starPath,
} from './star-road/road.js';
import {SPARK_TIERS, drawFlame, drawKart, drawSparks, type KartLook} from './star-road/kart.js';
import {
    drawBanner, drawCoins, drawItemSlot, drawLapAndTime, drawMinimap, drawPlace, drawRacerStack,
    type HudLayout, type Racer,
} from './star-road/hud.js';

/** Meters per cycle: 28 m/s cruise at 120 BPM. */
const Z_PER_CYCLE = 56;
const LOOKAHEAD = 2;
/** Your kart rides this far ahead of the camera; objects meet it there. */
const KART_AHEAD = 4.4;
const CAM_HEIGHT = 1.6;
const LOOK = KART_AHEAD + 8;
const LOOK_HEIGHT = 0.65;
const FAR = 230;
const IDLE_SPEED = 14;
const FOV_Y = (50 * Math.PI) / 180;
const REFERENCE_HEIGHT = 1080;

const MAX_HAPS = 420;
const MAX_PER_TRACK = 64;
/** Held notes at least this long are drifts. */
const DRIFT_MIN = 0.5;
/** Seconds of drift for each spark tier. */
const TIER_AT = [0.45, 1.05, 1.65] as const;
/** Boost seconds from a dash panel, then per released tier. */
const PANEL_BOOST = 0.55;
const TIER_BOOST = [0.55, 0.85, 1.15] as const;
const MAX_RIVALS = 7;
const LAPS = 3;
const BARS_PER_LAP = 8;
/** One steering slot. Consecutive panels step by at most this, inside LANE_MAX. */
const LANE_STEP = 1.4;
const LANE_MAX = 2.8;
/**
 * Targets less than this far apart share a gate. A quarter note is 14 m, so
 * beats stay separate, and each gate is approached over at least this many
 * meters: a chord on one onset cannot step the line.
 */
const GATE = 12;
/** Panels stay this far behind the camera so a blend still has its start gate. */
const STEER_BEHIND = 90;
/** Chase camera: fraction of the kart's lane it eases toward. It used to sit at 0.7, same frame. */
const CAM_GAIN = 0.3;
const CAM_RATE = 2;
/** Rival surge follower. An onset bumps the target by 8 m; this covers it, it does not teleport. */
const RIVAL_RATE = 4.2;
const RIVAL_LANES = [-3.2, 3.2, -1.2, 1.2, -4.6, 4.6, 0] as const;

const PANEL_EDGE = '#14202b';
const PANEL_FIELD = '#713c28';
const PANEL_HOT = '#c78c52';
const COIN = '#efbd73';
const COIN_EDGE = '#866444';
const PLAYER_BODY = '#91a9bc';

type Kind = 'panel' | 'box' | 'coin' | 'ring' | 'note';

interface Team extends FieldTeam {
    trim: string;
}

interface Thing extends FieldHap<Team> {
    kind: Kind;
    /** Road distance where the kart meets it. */
    s: number;
    /** Offset across the road from the centerline. */
    lane: number;
    /** Panel or box lane has been chosen from the previous gate. */
    steered: boolean;
    flash: number;
    depth: number;
}

interface Burst {
    kind: 'shards' | 'sparkle';
    lane: number;
    height: number;
    seed: number;
    age: number;
}

interface Rival {
    team: Team;
    ds: number;
    lane: number;
}

function kindFor(team: Team, note: number): Kind {
    if (Number.isFinite(note)) return 'note';
    switch (team.family) {
        case 'kick': return 'panel';
        case 'snare': return 'box';
        case 'hat': return 'coin';
        default: return 'ring';
    }
}

function shadeRgb(rgb: Rgb, k: number): string {
    return `rgb(${Math.round(rgb[0] * k)}, ${Math.round(rgb[1] * k)}, ${Math.round(rgb[2] * k)})`;
}

/** Quintic smootherstep, clamped. Zero velocity and acceleration at both ends. */
function smoother(t: number): number {
    const x = t < 0 ? 0 : t > 1 ? 1 : t;
    return x * x * x * (x * (x * 6 - 15) + 10);
}

class StarRoadMode implements VizMode {
    private readonly cam = new RoadCamera();
    private readonly field = new HapField<Team, Thing>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_HAPS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_SPEED / Z_PER_CYCLE,
        team: (base) => ({...base, trim: base.css}),
        hap: (base) => this.makeThing(base),
        keep: (h, cycle) => {
            const cam = cycle * Z_PER_CYCLE;
            if (h.kind === 'note') return h.end * Z_PER_CYCLE + KART_AHEAD >= cam - 2;
            // Steering gates outlive the draw so the line can finish its blend.
            if (h.kind === 'panel' || h.kind === 'box') return h.s >= cam - STEER_BEHIND;
            return h.s >= cam - 2;
        },
    });
    private time = 0;
    private themeKey = '';
    private playerTrim = 'rgb(71, 246, 255)';

    // Kart state, all driven by onsets and the clock.
    private lane = 0;
    private prevLane = 0;
    /** Lane held when the next gate is still out of reach, so a dropped gate doesn't snap the line. */
    private heldLane = 0;
    /** Camera's lateral offset, lagged behind the kart. */
    private camLane = 0;
    private bob = 0;
    private lean = 0;
    private boost = 0;
    private boostTier = 0;
    private fov = 0;
    private pulse = 0;
    private signFlash = 0;
    private drifting = false;
    private driftTier = -1;
    private driftCharge = 0;
    private coins = 0;
    private item = -1;
    private itemSpin = 0;
    private itemHold = 0;
    private readonly bursts: Burst[] = [];
    private readonly rivals: Rival[] = [];
    /** Smoothed along-track offset per rival team. The target still jumps with activity. */
    private readonly rivalDs = new Map<Team, number>();
    private readonly steerS: number[] = [];
    private readonly steerLane: number[] = [];
    private readonly drawList: Thing[] = [];

    private vw = 0;
    private vh = 0;
    private renderScale = 1;
    private sc = 1;
    private focal = 800;

    layout(s: VizServices): void {
        this.renderScale = Math.max(1, s.height / REFERENCE_HEIGHT);
        this.vw = s.width / this.renderScale;
        this.vh = s.height / this.renderScale;
        this.sc = Math.max(0.55, this.vh / REFERENCE_HEIGHT);
        this.focal = this.vh / 2 / Math.tan(FOV_Y / 2);
        this.field.invalidate();
    }

    private get camS(): number {
        return this.field.cycle * Z_PER_CYCLE;
    }

    private makeThing(base: FieldHap<Team>): Thing {
        const kind = kindFor(base.team, base.note);
        let lane = 0;
        if (kind === 'note') {
            // Pitch runs across the road, low on the left.
            const n = Math.min(96, Math.max(36, base.note));
            lane = -HALF_WIDTH + 1 + ((n - 36) / 60) * (HALF_WIDTH * 2 - 2);
        }
        // Panel and box lanes are chosen in time order by placeLanes, once.
        return {...base, kind, s: base.begin * Z_PER_CYCLE + KART_AHEAD, lane, steered: false, flash: 0, depth: 0};
    }

    // ---------------------------------------------------------------------
    // Update
    // ---------------------------------------------------------------------

    update(dt: number, s: VizServices): void {
        this.time += dt;
        this.ensurePalette(s.theme);
        this.field.update(dt, s);
        const bpm = Math.max(30, s.bpm);
        if (this.field.restarted) {
            this.bursts.length = 0;
            this.boost = 0;
            this.drifting = false;
            this.driftTier = -1;
            this.heldLane = 0;
            this.rivalDs.clear();
        }

        // Lanes before hits, so a box shattered on its first frame bursts where it sits.
        this.placeLanes();
        for (const h of this.field.haps) {
            if (this.field.crossed(h)) this.hit(h);
            h.flash *= Math.exp(-dt * 5);
        }

        this.buildSteer();
        const kartS = this.camS + KART_AHEAD;
        const line = this.lineAt(kartS);
        // Commit the hold only once a gate is reached, so the ramp into the
        // next one keeps a fixed start.
        if (this.steerS.length > 0 && kartS >= this.steerS[0]) this.heldLane = line;
        this.updateDrift(bpm);
        if (this.field.restarted) {
            this.lane = this.prevLane = line;
            this.camLane = line * CAM_GAIN;
            this.lean = 0;
        } else {
            const vLat = dt > 1e-4 ? (line - this.prevLane) / dt : 0;
            this.prevLane = this.lane = line;
            this.camLane = follow(this.camLane, line * CAM_GAIN, dt, CAM_RATE, CAM_RATE);
            const dir = Math.sign(roadCurve(kartS)) || 1;
            // Lean follows lateral speed, not the raw error, and a drift adds a small held tilt.
            const steerLean = Math.max(-0.18, Math.min(0.18, vLat * 0.04));
            const driftLean = this.drifting ? dir * 0.28 : 0;
            const leanTarget = Math.max(-0.36, Math.min(0.36, steerLean + driftLean));
            this.lean = follow(this.lean, leanTarget, dt, 4, 3);
        }

        const idleBob = 0.01 * (0.5 - 0.5 * Math.cos(this.time * 5));
        this.bob = follow(this.bob, idleBob + this.pulse * 0.015, dt, 6, 3);
        this.boost = Math.max(0, this.boost - dt);
        // A kick widens the field over ~0.3 s. The old attack (rate ~17) popped it in one frame.
        this.fov = follow(this.fov, this.boost > 0 ? 1 : 0, dt, 4.5, 2.6);
        this.pulse *= Math.exp(-dt * 6);
        this.signFlash *= Math.exp(-dt * 5);
        this.itemSpin = Math.max(0, this.itemSpin - dt);
        if (this.itemSpin <= 0) {
            this.itemHold = Math.max(0, this.itemHold - dt);
            if (this.itemHold <= 0) this.item = -1;
        }
        for (let i = this.bursts.length - 1; i >= 0; i--) {
            this.bursts[i].age += dt;
            if (this.bursts[i].age > 0.5) this.bursts.splice(i, 1);
        }
        this.updateRivals(dt);
    }

    private ensurePalette(t: Theme): void {
        const key = t.bg + t.neon;
        if (key === this.themeKey) return;
        this.themeKey = key;
        const rgb = rgbOf(t.neon, [71, 246, 255]);
        this.playerTrim = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }

    private hit(h: Thing): void {
        h.flash = 1;
        h.team.activity = Math.min(1, h.team.activity + 0.5);
        h.team.trim = shadeRgb(h.team.rgb, 0.55);
        switch (h.kind) {
            case 'panel':
                h.done = true;
                this.startBoost(PANEL_BOOST, 1);
                this.pulse = 1;
                break;
            case 'box':
                h.done = true;
                this.burst('shards', h.lane, 1.1, h.seed);
                this.item = h.seed % 4;
                this.itemSpin = 1;
                this.itemHold = 2;
                this.signFlash = 1;
                break;
            case 'coin':
                h.done = true;
                this.coins = Math.min(99, this.coins + 1);
                this.burst('sparkle', this.lane + (h.seed & 1 ? 0.9 : -0.9), 1.1, h.seed);
                break;
            case 'ring':
            case 'note':
                break;
        }
    }

    private startBoost(seconds: number, tier: number): void {
        this.boost = Math.max(this.boost, seconds);
        this.boostTier = tier;
    }

    private burst(kind: Burst['kind'], lane: number, height: number, seed: number): void {
        this.bursts.push({kind, lane, height, seed, age: 0});
        if (this.bursts.length > 40) this.bursts.shift();
    }

    /**
     * Give each new panel and box a lane one slot from the previous gate.
     * Doing it here, not at creation, walks the schedule in onset order
     * rather than track order. A lane sticks: dropping an old gate must not
     * reshuffle the ones still ahead. Targets inside one gate sit at most
     * one slot off that gate, so the next gate steps from the gate, not
     * from a pile-up.
     */
    private placeLanes(): void {
        const all = this.field.haps.filter((h) => h.kind === 'panel' || h.kind === 'box');
        all.sort((a, b) => a.s - b.s || a.seed - b.seed);
        let anchor = 0;
        let anchorS = -Infinity;
        for (const h of all) {
            const sameGate = h.s - anchorS < GATE;
            if (!h.steered) {
                const dir = ((h.seed >>> 3) % 3) - 1;
                let lane = anchor + dir * LANE_STEP;
                if (lane > LANE_MAX) lane = anchor - LANE_STEP;
                else if (lane < -LANE_MAX) lane = anchor + LANE_STEP;
                h.lane = Math.max(-LANE_MAX, Math.min(LANE_MAX, lane));
                h.steered = true;
            }
            if (!sameGate) {
                anchor = h.lane;
                anchorS = h.s;
            }
        }
    }

    /** One gate per GATE meters: the first target's lane is the line there. */
    private buildSteer(): void {
        const raw = this.field.haps.filter((h) => h.kind === 'panel' || h.kind === 'box');
        raw.sort((a, b) => a.s - b.s || a.seed - b.seed);
        const ss = this.steerS, ll = this.steerLane;
        ss.length = 0;
        ll.length = 0;
        for (const h of raw) {
            if (ss.length > 0 && h.s - ss[ss.length - 1] < GATE) continue;
            ss.push(h.s);
            ll.push(h.lane);
        }
    }

    /**
     * Racing line at road distance `s`. Quintic so velocity and acceleration
     * are zero at each gate: the kart arrives, it doesn't kink. Before the
     * first gate in view, hold `heldLane` and ease in over GATE meters.
     */
    private lineAt(s: number): number {
        const ss = this.steerS, ll = this.steerLane;
        const n = ss.length;
        if (n === 0) return this.heldLane;
        if (s <= ss[0]) {
            const dist = ss[0] - s;
            if (dist >= GATE) return this.heldLane;
            return this.heldLane + (ll[0] - this.heldLane) * smoother(1 - dist / GATE);
        }
        let i = 1;
        while (i < n && ss[i] <= s) i++;
        if (i >= n) return ll[n - 1];
        const span = Math.max(ss[i] - ss[i - 1], GATE);
        return ll[i - 1] + (ll[i] - ll[i - 1]) * smoother((s - (ss[i] - span)) / span);
    }

    /**
     * A held note under the kart is a drift. Its tier climbs with time held;
     * when the note ends, the tier it reached fires a mini-turbo.
     */
    private updateDrift(bpm: number): void {
        const c = this.field.cycle;
        let held: Thing | null = null;
        for (const h of this.field.haps) {
            if (h.kind !== 'note' || !h.seen || h.end - h.begin < DRIFT_MIN) continue;
            if (h.begin <= c && c < h.end && (!held || h.begin < held.begin)) held = h;
        }
        if (held && this.field.locked) {
            const seconds = (c - held.begin) * 240 / bpm;
            this.drifting = true;
            this.driftTier = seconds >= TIER_AT[2] ? 2 : seconds >= TIER_AT[1] ? 1 : seconds >= TIER_AT[0] ? 0 : -1;
            this.driftCharge = clamp01(seconds / TIER_AT[2]);
            return;
        }
        if (this.drifting && this.driftTier >= 0) this.startBoost(TIER_BOOST[this.driftTier], this.driftTier === 2 ? 2 : 0);
        this.drifting = false;
        this.driftTier = -1;
        this.driftCharge = 0;
    }

    /** One rival per unpitched drum track, surging when its track plays. */
    private updateRivals(dt: number): void {
        this.rivals.length = 0;
        const live = new Set<Team>();
        for (const t of this.field.teams) {
            if (t.pitched || this.rivals.length >= MAX_RIVALS) continue;
            live.add(t);
            // Slot, not roster index: a rival leaving must not slide the others sideways.
            const lane = RIVAL_LANES[t.slot % RIVAL_LANES.length] + 0.6 * Math.sin(this.time * 0.5 + t.slot);
            const dsTarget = 9 * Math.sin(this.time * 0.17 + t.slot * 1.9) + 16 * (t.activity - 0.3);
            let ds = this.rivalDs.get(t);
            ds = ds === undefined ? dsTarget : follow(ds, dsTarget, dt, RIVAL_RATE, RIVAL_RATE);
            this.rivalDs.set(t, ds);
            this.rivals.push({team: t, ds, lane});
        }
        for (const t of this.rivalDs.keys()) if (!live.has(t)) this.rivalDs.delete(t);
    }

    // ---------------------------------------------------------------------
    // Render
    // ---------------------------------------------------------------------

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {vw, vh} = this;
        const camS = this.camS;
        const kartS = camS + KART_AHEAD;
        const f = this.focal / (1 + 0.17 * this.fov);
        this.cam.set(camS, this.camLane, CAM_HEIGHT, LOOK, LOOK_HEIGHT, f, vw / 2, vh / 2);
        const heading = roadHeading(camS);
        const roll = Math.max(-0.2, Math.min(0.2, roadCurve(kartS) * 16));

        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);
        drawSpace(ctx, vw, vh, heading, this.time, s.theme);

        ctx.save();
        // Bank into the bends; oversize the clear so corners never show.
        ctx.translate(vw / 2, vh / 2);
        ctx.rotate(roll);
        ctx.translate(-vw / 2, -vh / 2);
        drawSigns(ctx, this.cam, FAR, this.time, this.signFlash);
        drawRoad(ctx, this.cam, FAR, this.pulse, s.theme);
        this.drawDecals(ctx);
        drawRails(ctx, this.cam, FAR, this.pulse, s.theme);
        this.drawUprights(ctx, kartS);
        this.drawBursts(ctx, kartS);
        ctx.restore();

        this.drawSpeedLines(ctx);
        this.drawHud(ctx, s);
        ctx.restore();
    }

    private visible(h: Thing): boolean {
        if (h.done && h.kind !== 'note' && h.kind !== 'ring') return false;
        const d = h.s - this.cam.s;
        return h.fade > 0.01 && d < FAR && (h.kind === 'note' ? h.end * Z_PER_CYCLE + KART_AHEAD - this.cam.s > 0.6 : d > 0.6);
    }

    /** Flat things on the road: note tiles and dash panels. */
    private drawDecals(ctx: CanvasRenderingContext2D): void {
        const list = this.field.haps.filter((h) => (h.kind === 'note' || h.kind === 'panel') && this.visible(h))
            .sort((a, b) => b.s - a.s);
        for (const h of list) {
            ctx.globalAlpha = h.fade;
            if (h.kind === 'note') this.drawNoteTile(ctx, h);
            else this.drawPanel(ctx, h);
        }
        ctx.globalAlpha = 1;
    }

    /** A road-hugging quad from s0 to s1 across [x0, x1], split to follow bends. */
    private roadQuad(ctx: CanvasRenderingContext2D, s0: number, s1: number, x0: number, x1: number, lift = 0.02): boolean {
        const {cam} = this;
        s0 = Math.max(s0, cam.s + 0.7);
        if (s1 <= s0) return false;
        const steps = Math.max(1, Math.ceil((s1 - s0) / 4));
        const left: number[] = [];
        const right: number[] = [];
        for (let i = 0; i <= steps; i++) {
            const s = s0 + (s1 - s0) * (i / steps);
            const cx = roadX(s), y = roadY(s) + lift;
            if (!cam.project(cx + x0, y, s)) return false;
            left.push(cam.sx, cam.sy);
            cam.project(cx + x1, y, s);
            right.push(cam.sx, cam.sy);
        }
        ctx.beginPath();
        ctx.moveTo(left[0], left[1]);
        for (let i = 2; i < left.length; i += 2) ctx.lineTo(left[i], left[i + 1]);
        for (let i = right.length - 2; i >= 0; i -= 2) ctx.lineTo(right[i], right[i + 1]);
        ctx.closePath();
        return true;
    }

    private drawNoteTile(ctx: CanvasRenderingContext2D, h: Thing): void {
        const len = Math.max(1.6, Math.min(h.end - h.begin, 1) * Z_PER_CYCLE);
        if (!this.roadQuad(ctx, h.s, h.s + len, h.lane - 0.55, h.lane + 0.55)) return;
        const a = ctx.globalAlpha;
        ctx.fillStyle = h.team.css;
        ctx.globalAlpha = a * (0.22 + 0.6 * h.flash);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1 + 2 * h.flash;
        ctx.globalAlpha = a * (0.35 + 0.55 * h.flash);
        ctx.stroke();
        ctx.globalAlpha = a;
    }

    /** Dash panel: a dark frame, an orange field and white chevrons sliding forward. */
    private drawPanel(ctx: CanvasRenderingContext2D, h: Thing): void {
        const {cam} = this;
        const half = 0.9, len = 1.6;
        if (!this.roadQuad(ctx, h.s - len - 0.12, h.s + len + 0.12, h.lane - half - 0.14, h.lane + half + 0.14)) return;
        ctx.fillStyle = PANEL_EDGE;
        ctx.fill();
        if (!this.roadQuad(ctx, h.s - len, h.s + len, h.lane - half, h.lane + half, 0.03)) return;
        ctx.fillStyle = PANEL_FIELD;
        ctx.fill();
        if (this.roadQuad(ctx, h.s - len, h.s + len, h.lane - half * 0.45, h.lane + half * 0.45, 0.035)) {
            ctx.fillStyle = PANEL_HOT;
            ctx.fill();
        }
        // Chevrons are shapes on the surface, so they foreshorten with it.
        ctx.fillStyle = '#ffffff';
        const pt = (s: number, x: number): boolean => {
            if (!cam.project(roadX(s) + h.lane + x, roadY(s) + 0.05, s)) return false;
            return true;
        };
        const scroll = (this.time * 6) % 1.05;
        for (let i = 0; i < 3; i++) {
            const tip = h.s - len + 0.75 + i * 1.05 + scroll;
            if (tip > h.s + len - 0.05) continue;
            const back = tip - 0.6, w = half * 0.8, t = 0.32;
            const ring: Array<[number, number]> = [[back, -w], [tip, 0], [back, w], [back + t, w], [tip + t, 0], [back + t, -w]];
            ctx.beginPath();
            let ok = true;
            for (const [ps, px] of ring) {
                if (!pt(ps, px)) { ok = false; break; }
                ctx.lineTo(cam.sx, cam.sy);
            }
            if (!ok) continue;
            ctx.closePath();
            ctx.fill();
        }
    }

    /** Coins, item boxes, rings, rivals and you, far to near. */
    private drawUprights(ctx: CanvasRenderingContext2D, kartS: number): void {
        const list = this.drawList;
        list.length = 0;
        for (const h of this.field.haps) {
            if ((h.kind === 'coin' || h.kind === 'box' || h.kind === 'ring') && this.visible(h)) list.push(h);
        }
        list.sort((a, b) => b.s - a.s);
        const rivals = this.rivals.slice().sort((a, b) => b.ds - a.ds);
        let r = 0;
        let player = false;
        const drawRivalsAbove = (s: number) => {
            while (r < rivals.length && kartS + rivals[r].ds > s) this.drawRival(ctx, rivals[r++], kartS);
        };
        for (const h of list) {
            drawRivalsAbove(h.s);
            if (!player && h.s < kartS) {
                this.drawPlayer(ctx, kartS);
                player = true;
            }
            ctx.globalAlpha = h.fade;
            if (h.kind === 'coin') this.drawCoin(ctx, h);
            else if (h.kind === 'box') this.drawBox(ctx, h);
            else this.drawRing(ctx, h);
            ctx.globalAlpha = 1;
        }
        drawRivalsAbove(kartS);
        if (!player) this.drawPlayer(ctx, kartS);
        drawRivalsAbove(-Infinity);
    }

    private drawRival(ctx: CanvasRenderingContext2D, v: Rival, kartS: number): void {
        const s = kartS + v.ds;
        if (!this.cam.project(roadX(s) + v.lane, roadY(s), s)) return;
        const k = this.cam.f / this.cam.d;
        const look: KartLook = {body: v.team.css, trim: v.team.trim};
        ctx.globalAlpha = v.team.fade;
        drawKart(ctx, this.cam.sx, this.cam.sy, k, look, Math.sin(this.time * 1.3 + v.team.slot) * 0.15);
        ctx.globalAlpha = 1;
    }

    private drawPlayer(ctx: CanvasRenderingContext2D, kartS: number): void {
        if (!this.cam.project(roadX(kartS) + this.lane, roadY(kartS), kartS)) return;
        const {sx, sy} = this.cam;
        const k = this.cam.f / this.cam.d;
        const bob = this.bob;
        drawSparks(ctx, sx, sy, k, this.drifting ? this.driftTier : -1, this.time, this.lean);
        drawKart(ctx, sx, sy, k, {body: PLAYER_BODY, trim: this.playerTrim}, this.lean, bob);
        const idle = this.field.locked ? 0.12 : 0;
        drawFlame(ctx, sx, sy - bob * k, k, Math.max(idle, Math.min(1, this.boost / 0.55)), this.time, this.boostTier, this.lean);
    }

    private drawCoin(ctx: CanvasRenderingContext2D, h: Thing): void {
        const lane = this.lineAt(h.s);
        if (!this.cam.project(roadX(h.s) + lane, roadY(h.s) + 0.65, h.s)) return;
        const k = this.cam.f / this.cam.d;
        const r = 0.36 * k;
        if (r < 0.8) return;
        const w = Math.max(0.12, Math.abs(Math.cos(this.time * 5 + (h.seed % 13))));
        const metal = ctx.createLinearGradient(this.cam.sx - r, this.cam.sy - r, this.cam.sx + r, this.cam.sy + r);
        metal.addColorStop(0, '#ffdf9b'); metal.addColorStop(0.4, COIN); metal.addColorStop(1, '#8a6540');
        ctx.fillStyle = metal;
        ctx.strokeStyle = COIN_EDGE;
        ctx.lineWidth = Math.max(1, r * 0.18);
        ctx.beginPath();
        ctx.ellipse(this.cam.sx, this.cam.sy, r * w, r, 0, 0, TAU);
        ctx.fill();
        ctx.stroke();
        if (w > 0.5) {
            ctx.fillStyle = '#fff6c0';
            ctx.fillRect(this.cam.sx - r * w * 0.12, this.cam.sy - r * 0.5, r * w * 0.24, r);
        }
    }

    /** Item box: a spinning rainbow glass cube with a "?" on the face you see. */
    private drawBox(ctx: CanvasRenderingContext2D, h: Thing): void {
        const {cam} = this;
        const size = 0.52;
        const bob = Math.sin(this.time * 2.2 + h.seed) * 0.18;
        const yaw = this.time * 0.8 + (h.seed % 100) * 0.07;
        const cx = roadX(h.s) + h.lane, cy = roadY(h.s) + 1.15 + bob, cz = h.s;
        const px: number[] = [], py: number[] = [];
        for (let i = 0; i < 8; i++) {
            const ux = (i & 1 ? 1 : -1) * size, uy = (i & 2 ? 1 : -1) * size, uz = (i & 4 ? 1 : -1) * size;
            const x = ux * Math.cos(yaw) - uz * Math.sin(yaw);
            const z = ux * Math.sin(yaw) + uz * Math.cos(yaw);
            if (!cam.project(cx + x, cy + uy, cz + z)) return;
            px.push(cam.sx);
            py.push(cam.sy);
        }
        const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6]];
        const a = ctx.globalAlpha;
        faces.forEach((f, i) => {
            const area = (px[f[1]] - px[f[0]]) * (py[f[2]] - py[f[0]]) - (py[f[1]] - py[f[0]]) * (px[f[2]] - px[f[0]]);
            if (area >= 0) return;
            const [r, g, b] = BAND_RGB[(i + (h.seed % 7)) % BAND_RGB.length];
            ctx.fillStyle = `rgb(${Math.round(r * 0.17)}, ${Math.round(g * 0.17)}, ${Math.round(b * 0.17)})`;
            ctx.globalAlpha = a * 0.88;
            ctx.beginPath();
            ctx.moveTo(px[f[0]], py[f[0]]);
            for (let k = 1; k < 4; k++) ctx.lineTo(px[f[k]], py[f[k]]);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = a;
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
        });
        // The mark floats in the middle of the glass, so it reads at any yaw.
        if (!cam.project(cx, cy, cz)) return;
        const k = cam.f / cam.d;
        ctx.font = `400 ${Math.round(0.62 * k)}px ${MONO_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#d7e9ed';
        ctx.fillText('?', cam.sx, cam.sy);
    }

    /** Rainbow ring standing over the road; it flashes as you pass through. */
    private drawRing(ctx: CanvasRenderingContext2D, h: Thing): void {
        if (!this.cam.project(roadX(h.s), roadY(h.s) + 4.6, h.s)) return;
        const k = this.cam.f / this.cam.d;
        const a = ctx.globalAlpha;
        ctx.lineWidth = Math.max(1, 0.12 * k);
        BAND_RGB.forEach(([r, g, b], i) => {
            ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.globalAlpha = a * (0.85 + 0.15 * h.flash);
            ctx.beginPath();
            ctx.arc(this.cam.sx, this.cam.sy, (4.1 + i * 0.12) * k, 0, TAU);
            ctx.stroke();
        });
        ctx.globalAlpha = a;
    }

    /** Bursts ride with the kart, at the point it hit them. */
    private drawBursts(ctx: CanvasRenderingContext2D, kartS: number): void {
        const {cam} = this;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const b of this.bursts) {
            const s = kartS + 1.5 + b.age * 4;
            if (!cam.project(roadX(s) + b.lane, roadY(s) + b.height, s)) continue;
            const k = cam.f / cam.d;
            const t = b.age / 0.5;
            const x = cam.sx, y = cam.sy;
            if (b.kind === 'shards') {
                for (let i = 0; i < 12; i++) {
                    const h = hash32(b.seed, i);
                    const ang = rand01(h) * TAU;
                    const dist = (4 + rand01(hash32(h, 1)) * 3) * b.age * k;
                    const [r, g, bb] = BAND_RGB[i % BAND_RGB.length];
                    ctx.fillStyle = `rgba(${r}, ${g}, ${bb}, ${1 - t})`;
                    const sx = x + Math.cos(ang) * dist, sy = y + Math.sin(ang) * dist + 6 * b.age * b.age * k;
                    const sz = 0.22 * k * (1 - t * 0.5);
                    ctx.beginPath();
                    ctx.moveTo(sx, sy - sz);
                    ctx.lineTo(sx + sz * Math.cos(ang + 2), sy + sz);
                    ctx.lineTo(sx - sz, sy + sz * 0.4);
                    ctx.closePath();
                    ctx.fill();
                }
            } else {
                ctx.fillStyle = `rgba(255, 246, 192, ${1 - t})`;
                ctx.beginPath();
                starPath(ctx, x, y - t * 0.6 * k, (0.1 + 0.12 * t) * k, t * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    /** Boost streaks in the outer frame, never over the kart. */
    private drawSpeedLines(ctx: CanvasRenderingContext2D): void {
        if (this.boost <= 0 && this.fov < 0.3) return;
        const {vw, vh} = this;
        const cx = vw / 2, cy = vh * 0.45;
        const R = Math.hypot(vw, vh) / 2;
        ctx.save();
        ctx.lineWidth = 2 * this.sc;
        ctx.lineCap = 'round';
        for (let i = 0; i < 18; i++) {
            const h = hash32(i, 313);
            // Fade in and out. The old envelope popped each streak to full alpha when it wrapped.
            const life = (this.time * 4 + rand01(h)) % 1;
            const ang = rand01(hash32(h, Math.floor(this.time * 4 + rand01(h)))) * TAU;
            const r0 = R * (0.62 + life * 0.45);
            const len = (50 + rand01(hash32(h, 2)) * 90) * this.sc;
            ctx.strokeStyle = i % 3 === 0 ? 'rgba(255, 142, 200, 0.7)' : 'rgba(214, 246, 255, 0.7)';
            ctx.globalAlpha = Math.sin(life * Math.PI) * this.fov;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
            ctx.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len));
            ctx.stroke();
        }
        ctx.restore();
    }

    private drawHud(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const L: HudLayout = {vw: this.vw, vh: this.vh, sc: this.sc, theme: s.theme};
        const bpm = Math.max(30, s.bpm);
        const cycle = this.field.locked ? s.cycle : 0;
        const bar = Math.floor(cycle);
        const lap = Math.floor(bar / BARS_PER_LAP) % LAPS + 1;

        const field: Array<{ds: number; racer: Racer}> = this.rivals.map((v) => ({
            ds: v.ds,
            racer: {label: v.team.name.slice(0, 3).toUpperCase(), css: v.team.css, player: false},
        }));
        field.push({ds: 0, racer: {label: 'YOU', css: this.playerTrim, player: true}});
        field.sort((a, b) => b.ds - a.ds);
        const place = field.findIndex((r) => r.racer.player) + 1;

        if (this.vw >= 580 && this.vh >= 420) drawRacerStack(ctx, L, field.map((r) => r.racer));
        drawLapAndTime(ctx, L, lap, LAPS, cycle * 240 / bpm, this.field.locked);
        drawItemSlot(ctx, L, this.item, this.itemSpin, this.time);
        const charge = this.drifting ? this.driftCharge : clamp01(this.boost / TIER_BOOST[2]);
        const chargeCss = this.drifting && this.driftTier >= 0 ? SPARK_TIERS[this.driftTier][0] : '#ffb020';
        drawPlace(ctx, L, place);
        drawCoins(ctx, L, this.coins, charge, chargeCss);
        if (this.vw >= 480) {
            drawMinimap(ctx, L, this.camS + KART_AHEAD, 40, FAR * 0.6,
                this.rivals.map((v) => ({ds: v.ds, lane: v.lane, css: v.team.css})), this.lane);
        }
        // FINAL LAP banner for the first 1.5 s of the last lap, then a fade.
        if (lap === LAPS && this.field.locked) {
            const start = bar - (bar % BARS_PER_LAP);
            const t = (cycle - start) * 240 / bpm;
            drawBanner(ctx, L, 'FINAL LAP', t < 1.5 ? 1 : clamp01(1 - (t - 1.5) / 0.5));
        }
    }
}

export const starRoadDef: VizModeDef = {
    id: 'star-road',
    name: 'STAR ROAD',
    create: () => new StarRoadMode(),
};
