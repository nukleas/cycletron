/**
 * MONSTER BAND — one pixel monster per sound, moving on that sound's onsets.
 * Drums share a skeleton at the back of the stage. Pitch lifts the hands,
 * a long note holds the pose, and a kick thumps the stage.
 */

import type {VizMode, VizModeDef, VizServices} from '../../sdk.js';
import {type FieldHap, type FieldTeam, HapField, type Rgb} from '../../sdk.js';
import {bakePix, drawSprite, frameRect, nearest, PH, PW, PxScreen, type Pix} from './lib/pixel.js';
import {isLong, registerPos} from './lib/roles.js';
import {MOON} from './lib/sprites.js';
import {
    type Cast, type Costume, type KitFlash, type KitPiece, castFor, drawPerformer, isOscillator, kitPiece, voiceOf,
} from './lib/monsters.js';

const LOOKAHEAD = 1;
const MAX_HAPS = 480;
const MAX_PER_TRACK = 48;
const DRUM_CAP = 32;
const IDLE_RATE = 0.25;
const CAP = 8;
const FRONT_FOOT = 154;
const BACK_FOOT = 102;
const LIGHT_Y = 164;
/** The front row centres on the stage and spreads out as it grows, up to this gap and the stage's edges. */
const MAX_GAP = 72;
const STAGE_W = 240;
/** How fast a player walks to a new spot, per second. */
const WALK = 6;

const RANK: Record<Cast, number> = {
    drummer: 0, frank: 1, wolf: 2, mummy: 3, vamp: 4, witch: 5, pumpkin: 6, ghost: 7,
};

/** Duplicates past the first of each kind. A second mummy is kept before a second frank. */
const EXTRA: Record<Cast, number> = {
    mummy: 0, frank: 1, vamp: 2, wolf: 3, witch: 4, pumpkin: 5, ghost: 6, drummer: 7,
};

interface Team extends FieldTeam {}

interface Note extends FieldHap<Team> {}

interface Pose {
    frame: number;
    hit: number;
    lift: number;
    hold: number;
}

interface Member {
    costume: Costume;
    x: number;
    foot: number;
    accent: string;
    activity: number;
    frame: number;
    hit: number;
    lift: number;
    held: boolean;
}

interface Cand {
    name: string;
    cast: Cast;
    team: Team | null;
}

interface Burst {
    long: boolean;
    end: number;
    lift: number;
    pitched: boolean;
}

const PIECES: readonly KitPiece[] = ['kick', 'snare', 'hat', 'tom', 'crash'];

/** Keyboard players in the order they take the stage; past the bride, everyone gets a keytar. */
const KEYS: readonly Costume[] = ['vamp', 'bride', 'keytarist'];

class MonsterBandMode implements VizMode {
    private readonly screen = new PxScreen();
    private readonly field = new HapField<Team, Note>({
        lookahead: LOOKAHEAD,
        maxHaps: MAX_HAPS,
        maxPerTrack: MAX_PER_TRACK,
        idleRate: IDLE_RATE,
        team: (base) => base,
        hap: (base) => base,
        cap: (_team, note) => (Number.isFinite(note) ? Infinity : DRUM_CAP),
        keep: (h, cycle) => h.end + 0.15 >= cycle,
    });
    private readonly colors = new Map<number, string>();
    private readonly poses = new Map<string, Pose>();
    private readonly locked = new Map<string, Cast>();
    /** A keyboard player's costume, kept while it stays on stage. */
    private readonly costumes = new Map<string, Costume>();
    private readonly members: Member[] = [];
    /** Where each front-row player stands now; it eases to the slot. */
    private readonly spots = new Map<string, number>();
    private readonly kit: KitFlash = {
        kick: 0, snare: 0, hat: 0, tom: 0, crash: 0, snareHand: 0, floorTom: false,
        kickCss: '', snareCss: '', hatCss: '', tomCss: '', crashCss: '',
    };
    private readonly kitTeam: Record<KitPiece, string> = {kick: '', snare: '', hat: '', tom: '', crash: ''};
    private thump = 0;
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
            this.poses.clear();
            this.locked.clear();
            this.costumes.clear();
            this.spots.clear();
            this.thump = 0;
            this.zeroKit();
        }
        const decay = Math.exp(-dt * 8);
        this.thump *= Math.exp(-dt * 9);
        for (const piece of PIECES) this.kit[piece] *= decay;
        for (const pose of this.poses.values()) {
            if (field.cycle < pose.hold) pose.hit = 1;
            else pose.hit *= decay;
        }

        const bursts = new Map<string, Burst>();
        for (const h of field.haps) {
            if (!field.crossed(h)) continue;
            h.done = true;
            h.team.activity = 1;
            if (this.castOf(h.team) === 'drummer') {
                this.hitDrum(h);
                continue;
            }
            let burst = bursts.get(h.team.name);
            if (!burst) {
                burst = {long: true, end: h.end, lift: 0.5, pitched: false};
                bursts.set(h.team.name, burst);
            }
            if (!isLong(h.begin, h.end)) burst.long = false;
            if (h.end > burst.end) burst.end = h.end;
            if (Number.isFinite(h.note)) {
                const lift = registerPos(h.note);
                burst.lift = burst.pitched ? Math.max(burst.lift, lift) : lift;
                burst.pitched = true;
            }
        }
        for (const [name, burst] of bursts) {
            const pose = this.poseFor(name);
            pose.hit = 1;
            if (burst.pitched) pose.lift = burst.lift;
            if (burst.long) pose.hold = burst.end;
            else {
                pose.hold = 0;
                pose.frame = (pose.frame + 1) % 3;
            }
        }
        this.assemble(dt);
    }

    private hitDrum(h: Note): void {
        const piece = kitPiece(h.team.name, h.note);
        const pose = this.poseFor('*kit');
        pose.hit = 1;
        // A rest or an unnamed hit still flashes the hands. It does not pick a pose.
        if (piece === 'other') return;
        this.kit[piece] = 1;
        this.kitTeam[piece] = h.team.name;
        if (piece === 'kick') this.thump = 1;
        else if (piece === 'tom') this.kit.floorTom = /^lt/.test(voiceOf(h.team.name));
        else if (piece === 'snare') this.kit.snareHand = 1 - this.kit.snareHand;
    }

    /** Lock the costume once a bare oscillator has played a pitch; named sounds lock at once. */
    private castOf(team: Team): Cast {
        const known = this.locked.get(team.name);
        if (known) return known;
        let note = NaN;
        let chord = false;
        for (const h of this.field.haps) {
            if (h.team !== team || !Number.isFinite(h.note)) continue;
            if (!Number.isFinite(note) || h.note < note) note = h.note;
            if (!chord) {
                for (const o of this.field.haps) {
                    if (o !== h && o.team === team && o.begin === h.begin && o.note !== h.note && Number.isFinite(o.note)) {
                        chord = true;
                        break;
                    }
                }
            }
        }
        const cast = castFor(team.name, note, chord);
        if (!isOscillator(team.name) || Number.isFinite(note)) this.locked.set(team.name, cast);
        return cast;
    }

    /**
     * Keyboard players on stage keep their costume; a newcomer takes the first
     * free one. Leaving the stage gives the costume back.
     */
    private dress(picked: readonly Cand[]): void {
        const staged = new Set<string>();
        for (const cand of picked) if (cand.cast === 'vamp') staged.add(cand.name);
        for (const name of [...this.costumes.keys()]) {
            if (!staged.has(name)) this.costumes.delete(name);
        }
        const worn = new Set(this.costumes.values());
        for (const cand of picked) {
            if (cand.cast !== 'vamp' || this.costumes.has(cand.name)) continue;
            const costume = KEYS.find((k) => !worn.has(k)) ?? 'keytarist';
            this.costumes.set(cand.name, costume);
            worn.add(costume);
        }
    }

    /** Slot `index` of `n`, centred. A newcomer starts on its slot; everyone else walks over. */
    private walk(name: string, index: number, n: number, dt: number): number {
        const gap = n > 1 ? Math.min(MAX_GAP, STAGE_W / (n - 1)) : 0;
        const slot = 160 + (index - (n - 1) / 2) * gap;
        const now = this.spots.get(name);
        const x = now === undefined ? slot : slot + (now - slot) * Math.exp(-dt * WALK);
        this.spots.set(name, x);
        return Math.round(x);
    }

    private poseFor(key: string): Pose {
        let pose = this.poses.get(key);
        if (!pose) {
            pose = {frame: 0, hit: 0, lift: 0.5, hold: 0};
            this.poses.set(key, pose);
        }
        return pose;
    }

    private zeroKit(): void {
        for (const piece of PIECES) {
            this.kit[piece] = 0;
            this.kitTeam[piece] = '';
        }
        this.kit.snareHand = 0;
        this.kit.floorTom = false;
    }

    private colorOf(rgb: Rgb): string {
        return nearest(rgb, this.pix.ink.pool, this.colors);
    }

    private assemble(dt: number): void {
        const cands: Cand[] = [];
        let drum: Cand | null = null;
        let drumActivity = -1;
        let drumTeam: Team | null = null;
        for (const team of this.field.teams) {
            if (!team.present && team.fade <= 0) continue;
            const cast = this.castOf(team);
            if (cast === 'drummer') {
                if (!drum) drum = {name: '*kit', cast, team};
                if (
                    team.activity > drumActivity
                    || (team.activity === drumActivity && drumTeam !== null && team.name < drumTeam.name)
                ) {
                    drumActivity = team.activity;
                    drumTeam = team;
                }
                continue;
            }
            cands.push({name: team.name, cast, team});
        }
        cands.sort((a, b) => RANK[a.cast] - RANK[b.cast] || a.name.localeCompare(b.name));
        const first: Cand[] = [];
        const extra: Cand[] = [];
        const seen = new Set<Cast>();
        for (const cand of cands) {
            if (seen.has(cand.cast)) extra.push(cand);
            else {
                seen.add(cand.cast);
                first.push(cand);
            }
        }
        extra.sort((a, b) => EXTRA[a.cast] - EXTRA[b.cast] || a.name.localeCompare(b.name));
        const staged = drum ? [drum, ...first, ...extra] : [...first, ...extra];
        const picked = staged.slice(0, CAP);
        const front = picked.filter((c) => c.cast !== 'drummer');
        this.dress(picked);
        const ink = this.pix.ink;
        this.members.length = 0;
        for (const cand of picked) {
            const pose = this.poseFor(cand.name);
            const x = cand.cast === 'drummer' ? 160 : this.walk(cand.name, front.indexOf(cand), front.length, dt);
            const accentTeam = cand.cast === 'drummer' ? drumTeam : cand.team;
            this.members.push({
                costume: this.costumes.get(cand.name) ?? cand.cast,
                x,
                foot: cand.cast === 'drummer' ? BACK_FOOT : FRONT_FOOT,
                accent: accentTeam ? this.colorOf(accentTeam.rgb) : ink.moon,
                activity: cand.cast === 'drummer' ? Math.max(0, drumActivity) : (cand.team?.activity ?? 0),
                frame: pose.frame,
                hit: pose.hit,
                lift: pose.lift,
                held: this.field.cycle < pose.hold,
            });
        }
        this.paintKitColors(ink.moon);
        const live = new Set(this.field.teams.map((t) => t.name));
        if (drum) live.add('*kit');
        for (const key of [...this.spots.keys()]) {
            if (!front.some((c) => c.name === key)) this.spots.delete(key);
        }
        for (const key of [...this.poses.keys()]) {
            if (!live.has(key)) this.poses.delete(key);
        }
    }

    private paintKitColors(fallback: string): void {
        for (const piece of PIECES) {
            const team = this.field.teams.find((t) => t.name === this.kitTeam[piece]);
            const css = team ? this.colorOf(team.rgb) : fallback;
            if (piece === 'kick') this.kit.kickCss = css;
            else if (piece === 'snare') this.kit.snareCss = css;
            else if (piece === 'hat') this.kit.hatCss = css;
            else if (piece === 'tom') this.kit.tomCss = css;
            else this.kit.crashCss = css;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const p = this.screen.ctx;
        const hop = this.thump > 0.5 ? 1 : 0;
        p.setTransform(1, 0, 0, 1, 0, hop);
        p.imageSmoothingEnabled = false;
        drawBackdrop(p, this.pix);
        drawFloor(p, this.pix);
        const ink = this.pix.ink;
        for (const m of this.members) {
            if (m.costume !== 'drummer') continue;
            drawPerformer(p, m.costume, m.x, m.foot, m.frame, m.hit, m.lift, m.held, m.accent, ink, this.kit);
        }
        for (const m of this.members) {
            if (m.costume === 'drummer') continue;
            drawPerformer(p, m.costume, m.x, m.foot, m.frame, m.hit, m.lift, m.held, m.accent, ink);
        }
        drawFootlights(p, this.members, this.pix);
        p.setTransform(1, 0, 0, 1, 0, 0);
        if (hop) {
            p.fillStyle = ink.skyDeep;
            p.fillRect(0, 0, PW, 1);
        }
        this.screen.blit(ctx, s.width, s.height, ink.bg);
    }
}

function drawBackdrop(ctx: CanvasRenderingContext2D, pix: Pix): void {
    const ink = pix.ink;
    ctx.fillStyle = ink.skyDeep;
    ctx.fillRect(0, 0, PW, BACK_FOOT);
    ctx.fillStyle = ink.roof;
    ctx.fillRect(0, 6, PW, BACK_FOOT - 6);
    ctx.fillStyle = ink.roofAlt;
    for (let x = 0; x < PW; x += 12) ctx.fillRect(x, 6, 4, BACK_FOOT - 6);
    ctx.fillStyle = ink.red;
    ctx.fillRect(0, 0, PW, 8);
    ctx.fillStyle = ink.moon;
    for (let x = 6; x < PW; x += 14) ctx.fillRect(x, 6, 2, 2);
    const wx = 18;
    const wy = 16;
    ctx.fillStyle = ink.skyDeep;
    ctx.fillRect(wx, wy, 28, 26);
    drawSprite(ctx, MOON, wx + 6, wy + 4, [null, ink.moon, ink.moonDim]);
    ctx.fillStyle = ink.stoneDark;
    ctx.fillRect(wx + 14, wy, 1, 26);
    ctx.fillRect(wx, wy + 13, 28, 1);
    frameRect(ctx, wx, wy, 28, 26, ink.stone);
}

function drawFloor(ctx: CanvasRenderingContext2D, pix: Pix): void {
    const ink = pix.ink;
    ctx.fillStyle = ink.dirt;
    ctx.fillRect(0, BACK_FOOT, PW, PH - BACK_FOOT);
    ctx.fillStyle = ink.line;
    for (let y = BACK_FOOT + 8; y < LIGHT_Y; y += 8) ctx.fillRect(8, y, PW - 16, 1);
}

function drawFootlights(ctx: CanvasRenderingContext2D, members: readonly Member[], pix: Pix): void {
    for (const m of members) {
        const on = m.activity > 0.18;
        const w = on ? 14 : 8;
        ctx.fillStyle = on ? m.accent : pix.ink.line;
        ctx.fillRect(m.x - (w >> 1), LIGHT_Y, w, on ? 4 : 2);
        if (on) {
            ctx.fillStyle = pix.ink.moon;
            ctx.fillRect(m.x - 2, LIGHT_Y, 4, 2);
        }
    }
}

export const monsterBandDef: VizModeDef = {
    id: 'monster-band',
    name: 'MONSTER BAND',
    create: () => new MonsterBandMode(),
};
