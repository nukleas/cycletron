/**
 * Pixel monsters shared by the band and the house windows.
 * The cast comes from the sound name. Drum voices are the token after the
 * last `_` (so `RolandTR909_sd` is a snare), never `instrumentFamily`'s
 * `perc` bucket — that bucket is every non-drum, including a trumpet.
 */

import {drawSprite, type Ink, spr, type Sprite} from './pixel.js';
import {halloweenRole, type Role} from './roles.js';
import {drawGhostAt} from './sky.js';
import {instrumentFamily} from '../../../sdk.js';

export type Cast = 'drummer' | 'frank' | 'wolf' | 'mummy' | 'vamp' | 'witch' | 'pumpkin' | 'ghost';

/** What a member wears. Repeat keyboard players come on as the bride, then keytarists. */
export type Costume = Cast | 'bride' | 'keytarist';

export type WinKind = 'vamp' | 'witch' | 'frank' | 'mummy' | 'wolf' | 'cat' | 'boo';

export type KitPiece = 'kick' | 'snare' | 'hat' | 'tom' | 'crash';

export interface KitFlash {
    kick: number;
    snare: number;
    hat: number;
    tom: number;
    crash: number;
    /** Flips on every snare hit, so rolls alternate hands. */
    snareHand: number;
    /** The last tom hit was the floor tom. */
    floorTom: boolean;
    kickCss: string;
    snareCss: string;
    hatCss: string;
    tomCss: string;
    crashCss: string;
}

const DRUM_VOICE = /^(bd|kick|sd|sn|cp|clap|rim|rs|cr|crash|ride|rd|lt|mt|ht|tom|toms|hh|oh|ch|hat|shaker|tb|tamb|cb|cowbell|cow|perc|drum|cy|cymbal)$/;

/** C3, the same cut the bass register uses. */
const C3 = 48;

const WIN_KINDS: readonly WinKind[] = ['vamp', 'witch', 'frank', 'mummy', 'wolf', 'cat', 'boo'];

const ROLE_SHIFT: Record<Role, number> = {
    bass: 2, mid: 0, lead: 1, kick: 4, snare: 3, tom: 5, crash: 6, hat: 5, perc: 4,
};

type Rect = (x: number, y: number, w: number, h: number, color: string) => void;

export function voiceOf(name: string): string {
    const lower = name.toLowerCase();
    const cut = lower.lastIndexOf('_');
    return cut >= 0 ? lower.slice(cut + 1) : lower;
}

function isDrumVoice(name: string): boolean {
    const voice = voiceOf(name);
    if (DRUM_VOICE.test(voice)) return true;
    const family = instrumentFamily(voice);
    return family === 'kick' || family === 'snare' || family === 'hat';
}

/** Bare synth voices. They say nothing about the part, so register and chords pick the cast. */
const OSC = /^(sine|sin|triangle|tri|sawtooth|saw|supersaw|square|sqr|supersquare|pulse|superpwm|superzow|lead|theremin)$/;

/** True when `castFor` needs a pitch before its answer is final. */
export function isOscillator(name: string): boolean {
    return OSC.test(voiceOf(name));
}

/**
 * One character for a team. `note` is the lowest note in view, or NaN when
 * the team has not played a pitch yet; `chord` is true when it has played
 * two notes at once. Named instruments go by family. A bare oscillator is
 * a synth: a single line below C3 is the bass, sines and triangles go to the
 * witch's theremin, and the rest play the vampire's keyboard, where the
 * hands show the notes.
 */
export function castFor(name: string, note: number, chord: boolean): Cast {
    const lower = name.toLowerCase();
    const voice = voiceOf(lower);
    if (/^(white|pink|brown|crackle|noise)$/.test(voice)) return 'drummer';
    if (/choir|aahs|oohs|voice|vox/.test(lower)) return 'ghost';
    if (/trumpet|sax|horn|brass|trombone|tuba|flute|clarinet|oboe|bassoon|ocarina|recorder|piccolo|whistle|harmonica/.test(lower)) {
        return 'mummy';
    }
    if (/xylo|pluck|marimba|kalimba|vibraphone|glock|celesta|bell|music_box|harp|steel_drum|tubular|dulcimer/.test(lower)) {
        return 'pumpkin';
    }
    if (/epiano|piano|steinway|organ|keys|rhodes|clav|harpsichord/.test(lower)) return 'vamp';
    if (/bass|sub/.test(lower) || voice === '808') return 'frank';
    if (/guitar|gtr|banjo|sitar|koto|shamisen/.test(lower)) return 'wolf';
    if (/string|violin|viola|cello|fiddle|pad/.test(lower)) return 'ghost';
    if (OSC.test(voice)) {
        if (!Number.isFinite(note)) return 'vamp';
        if (!chord && note < C3) return 'frank';
        return /^(sine|sin|triangle|tri|theremin)$/.test(voice) ? 'witch' : 'vamp';
    }
    if (isDrumVoice(lower)) return 'drummer';
    if (!Number.isFinite(note)) return 'drummer';
    return 'ghost';
}

/** Which kit piece a drum hap strikes. Ride shares the hat arm; crash swings the cymbal. */
export function kitPiece(name: string, note: number): KitPiece | 'other' {
    const voice = voiceOf(name);
    if (/^(rd|ride)$/.test(voice)) return 'hat';
    const role = halloweenRole(name, note);
    if (role === 'kick' || role === 'snare' || role === 'hat' || role === 'tom' || role === 'crash') return role;
    return 'other';
}

/** Window creature. Seed and role both move the pick, and the same hap stays put. */
export function windowMonster(seed: number, role: Role): WinKind {
    return WIN_KINDS[(seed + ROLE_SHIFT[role]) % WIN_KINDS.length];
}

function pen(ctx: CanvasRenderingContext2D, ox: number, oy: number): Rect {
    const x0 = Math.round(ox);
    const y0 = Math.round(oy);
    return (x, y, w, h, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(x0 + x, y0 + y, w, h);
    };
}

/** A coloured monster in the glass. Three frames, clipped to the pane. */
export function drawWindowMonster(
    ctx: CanvasRenderingContext2D, kind: WinKind, x: number, y: number, w: number, h: number,
    frame: number, accent: string, ink: Ink,
): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const ox = Math.round(x + (w - 10) / 2);
    const oy = Math.round(h >= 12 ? y + h - 12 : y);
    const r = pen(ctx, ox, oy);
    const f = frame % 3;
    switch (kind) {
        case 'vamp': drawMiniVamp(r, f, accent, ink); break;
        case 'witch': drawMiniWitch(r, f, accent, ink); break;
        case 'frank': drawMiniFrank(r, f, accent, ink); break;
        case 'mummy': drawMiniMummy(r, f, accent, ink); break;
        case 'wolf': drawMiniWolf(r, f, accent, ink); break;
        case 'cat': drawMiniCat(r, f, accent, ink); break;
        case 'boo': drawMiniBoo(r, f, accent, ink); break;
    }
    ctx.restore();
}

/**
 * Big Boo face for the bar after a crash. Drawn on a 10-cell grid so a
 * 10px attic pane still reads: dark glass, a white body, team-coloured eyes.
 */
export function drawBigBoo(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    frame: number, accent: string, ink: Ink,
): void {
    const X = Math.round(x);
    const Y = Math.round(y);
    const f = frame % 3;
    ctx.fillStyle = ink.line;
    ctx.fillRect(X, Y, w, h);
    const cell = (gx: number, gy: number, gw: number, gh: number, color: string) => {
        const x1 = X + Math.floor(gx * w / 10);
        const y1 = Y + Math.floor(gy * h / 10);
        const x2 = X + Math.floor((gx + gw) * w / 10);
        const y2 = Y + Math.floor((gy + gh) * h / 10);
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
    };
    cell(1, 0, 8, 1, ink.ghost);
    cell(0, 1, 10, 7, ink.ghost);
    cell(0, 8, 2, 2, ink.ghost);
    cell(4, 8, 2, 2, ink.ghost);
    cell(8, 8, 2, 2, ink.ghost);
    cell(2, 2, 2, 2, accent);
    cell(6, 2, 2, 2, accent);
    const look = f === 1 ? 0 : 1;
    cell(2 + look, 3, 1, 1, ink.line);
    cell(6 + look, 3, 1, 1, ink.line);
    cell(3, 5, 4, 1 + f, f === 0 ? ink.line : ink.red);
}

function drawMiniVamp(r: Rect, frame: number, accent: string, ink: Ink): void {
    const flare = frame === 1 ? 0 : 1;
    r(flare, 4, 10 - flare * 2, 7, accent);
    r(2, 0, 6, 2, ink.line);
    r(3, 2, 4, 3, ink.bone);
    r(3, 3, 1, 1, accent);
    r(6, 3, 1, 1, accent);
    r(4, 4, 1, 1, ink.moon);
    r(3, 5, 4, 4, ink.line);
    r(3, 10, 2, 2, ink.line);
    r(6, 10, 2, 2, ink.line);
    if (frame === 2) r(4, 9, 2, 1, accent);
}

function drawMiniWitch(r: Rect, frame: number, accent: string, ink: Ink): void {
    r(3, 0, 4, 1, ink.line);
    r(1, 1, 8, 2, ink.line);
    r(4, 3, 2, 1, ink.line);
    r(3, 4, 4, 3, ink.green);
    r(3, 5, 1, 1, accent);
    r(6, 5, 1, 1, accent);
    r(2, 7, 6, 3, ink.purple);
    if (frame === 1) {
        r(0, 6, 2, 2, ink.green);
        r(8, 6, 2, 2, ink.green);
    } else if (frame === 2) {
        r(0, 8, 2, 1, ink.green);
        r(8, 8, 2, 1, ink.green);
    } else {
        r(1, 8, 2, 2, ink.green);
        r(7, 8, 2, 2, ink.green);
    }
    r(3, 10, 2, 2, ink.purple);
    r(6, 10, 2, 2, ink.purple);
}

function drawMiniFrank(r: Rect, frame: number, accent: string, ink: Ink): void {
    const spark = frame === 1;
    r(2, 0, 6, 2, ink.line);
    r(2, 2, 6, 4, ink.green);
    r(0, 3, 2, 2, spark ? ink.moon : accent);
    r(8, 3, 2, 2, spark ? ink.moon : accent);
    r(3, 3, 1, 1, ink.line);
    r(6, 3, 1, 1, ink.line);
    r(2, 6, 6, 4, ink.purple);
    if (frame === 1) {
        r(0, 5, 2, 2, ink.green);
        r(8, 5, 2, 2, ink.green);
    } else if (frame === 2) {
        r(0, 8, 2, 2, ink.green);
        r(8, 7, 2, 2, ink.green);
    }
    r(3, 10, 2, 2, ink.line);
    r(6, 10, 2, 2, ink.line);
}

function drawMiniMummy(r: Rect, frame: number, accent: string, ink: Ink): void {
    r(2, 1, 6, 4, ink.bone);
    r(2, 2, 6, 1, ink.line);
    r(2, 4, 6, 1, ink.line);
    r(3, 2, 1, 1, accent);
    r(6, 2, 1, 1, accent);
    r(2, 6, 6, 4, ink.bone);
    r(2, 7, 6, 1, ink.line);
    r(2, 9, 6, 1, ink.line);
    r(3, 10, 2, 2, ink.bone);
    r(6, 10, 2, 2, ink.bone);
    if (frame === 1) r(8, 7, 2, 3, ink.bone);
    else if (frame === 2) r(0, 8, 2, 3, ink.bone);
}

function drawMiniWolf(r: Rect, frame: number, accent: string, ink: Ink): void {
    r(1, 0, 2, 2, ink.roof);
    r(7, 0, 2, 2, ink.roof);
    r(2, 2, 6, 4, ink.roof);
    r(3, 3, 1, 1, accent);
    r(6, 3, 1, 1, accent);
    r(4, 4, 3, 2, ink.bone);
    r(5, 5, 1, 1, ink.line);
    r(1, 6, 8, 4, ink.roofAlt);
    if (frame === 1) {
        r(0, 6, 2, 2, ink.roof);
        r(8, 6, 2, 2, ink.roof);
    } else if (frame === 2) {
        r(0, 8, 2, 2, ink.roof);
        r(8, 8, 2, 2, ink.roof);
    }
    r(3, 10, 2, 2, ink.line);
    r(6, 10, 2, 2, ink.line);
}

function drawMiniCat(r: Rect, frame: number, accent: string, ink: Ink): void {
    r(1, 0, 2, 3, ink.line);
    r(7, 0, 2, 3, ink.line);
    r(2, 1, 1, 1, accent);
    r(7, 1, 1, 1, accent);
    r(2, 3, 6, 4, ink.line);
    r(3, 4, 1, 1, accent);
    r(6, 4, 1, 1, accent);
    r(4, 6, 2, 1, ink.bone);
    r(2, 7, 6, 3, ink.line);
    r(3, 10, 2, 2, ink.line);
    r(6, 10, 2, 2, ink.line);
    if (frame === 1) r(8, 7, 2, 1, ink.line);
    else if (frame === 2) r(0, 8, 3, 1, ink.line);
    else r(8, 9, 2, 2, ink.line);
}

function drawMiniBoo(r: Rect, frame: number, accent: string, ink: Ink): void {
    r(2, 0, 6, 2, ink.ghost);
    r(1, 2, 8, 6, ink.ghost);
    r(2, 3, 2, 2, ink.moon);
    r(6, 3, 2, 2, ink.moon);
    const look = frame === 1 ? 1 : 0;
    r(3 + look, 4, 1, 1, accent);
    r(7 - look, 4, 1, 1, accent);
    r(3, 6, 4, frame === 2 ? 2 : 1, frame === 0 ? ink.line : ink.red);
    r(1, 8, 2, 2, ink.ghost);
    r(4, 9, 2, 2, ink.ghost);
    r(7, 8, 2, 2, ink.ghost);
}

/**
 * A band member standing on `foot`; `x` is the centre. Each onset advances
 * `frame` (strum down, strum up, ...), `hit` is 1 on the onset and decays,
 * `lift` is where the pitch sits in its register, 0..1, and `held` is true
 * while a long note sounds.
 */
export function drawPerformer(
    ctx: CanvasRenderingContext2D, cast: Costume, x: number, foot: number, frame: number,
    hit: number, lift: number, held: boolean, accent: string, ink: Ink, kit?: KitFlash,
): void {
    if (cast === 'drummer') {
        drawDrummer(ctx, x, foot, hit, accent, ink, kit);
        return;
    }
    if (cast === 'ghost') {
        drawChoir(ctx, x, foot, frame, hit, lift, accent, ink);
        return;
    }
    at(x, foot);
    const f = frame % 3;
    switch (cast) {
        case 'frank': drawFrank(ctx, f, hit, lift, accent, ink); break;
        case 'wolf': drawWolf(ctx, f, hit, lift, accent, ink); break;
        case 'mummy': drawMummy(ctx, f, hit, lift, held, accent, ink); break;
        case 'vamp': drawVamp(ctx, f, hit, lift, held, accent, ink); break;
        case 'bride': drawBride(ctx, f, hit, lift, held, accent, ink); break;
        case 'keytarist': drawKeytarist(ctx, f, hit, lift, held, accent, ink); break;
        case 'witch': drawWitch(ctx, f, hit, lift, accent, ink); break;
        case 'pumpkin': drawPumpkin(ctx, f, hit, lift, accent, ink); break;
    }
}

/** Origin for `b` and `ln`, so each figure is drawn around its own feet. */
let ox = 0;
let oy = 0;

function at(x: number, y: number): void {
    ox = Math.round(x);
    oy = Math.round(y);
}

function b(x: number, y: number, w: number, h: number, c: string, edge = true): void {
    put(ox + x, oy + y, w, h, c, edge);
}

function ln(x0: number, y0: number, x1: number, y1: number, size: number, c: string, edge = true): void {
    seg(ox + x0, oy + y0, ox + x1, oy + y1, size, c, edge);
}

/** Shoulder to elbow in the sleeve, elbow to hand in the skin, and a 3px hand. */
function limb(sx: number, sy: number, ex: number, ey: number, hx: number, hy: number, sleeve: string, skin: string): void {
    ln(sx, sy, ex, ey, 2, sleeve);
    ln(ex, ey, hx, hy, 2, skin);
    b(hx - 1, hy - 1, 3, 3, skin);
}

/** Two legs; on a hit one foot stamps, alternating by frame. */
function stance(hit: number, frame: number, leg: string, shoe: string, gap = 1): void {
    const lift = hit > 0.5 ? frame & 1 : -1;
    const l = lift === 0 ? 1 : 0;
    const r = lift === 1 ? 1 : 0;
    b(-4 - gap, -11 - l, 4, 8, leg);
    b(gap, -11 - r, 4, 8, leg);
    b(-6 - gap, -4 - l, 6, 4, shoe);
    b(gap, -4 - r, 6, 4, shoe);
}

/** A point `t` of the way along a neck from (x0, y0) to (x1, y1). */
function along(x0: number, y0: number, x1: number, y1: number, t: number): Pt {
    return [Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t)];
}

/** Frankenstein in a dark jacket, on bass. Low notes reach up the neck; the bolts spark on the hit. */
function drawFrank(ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, accent: string, ink: Ink): void {
    const d = hit > 0.5 ? 1 : 0;
    const spark = hit > 0.5;
    stance(hit, frame, ink.sil, ink.line);
    b(-7, -24 + d, 14, 14, ink.wall);
    b(-2, -24 + d, 4, 5, ink.line, false);
    b(-1, -16 + d, 1, 1, ink.line, false);
    b(-1, -13 + d, 1, 1, ink.line, false);
    b(-2, -26 + d, 4, 2, ink.green);
    b(-6, -26 + d, 3, 2, spark ? ink.moon : ink.stone);
    b(3, -26 + d, 3, 2, spark ? ink.moon : ink.stone);
    b(-5, -36 + d, 10, 10, ink.green);
    b(-6, -39 + d, 12, 4, ink.line);
    b(-5, -35 + d, 2, 1, ink.line, false);
    b(-1, -35 + d, 3, 1, ink.line, false);
    b(3, -35 + d, 2, 1, ink.line, false);
    b(-4, -33 + d, 8, 1, ink.stem, false);
    b(-3, -32 + d, 2, 2, ink.line, false);
    b(1, -32 + d, 2, 2, ink.line, false);
    if (spark) {
        b(-3, -32 + d, 1, 1, accent, false);
        b(1, -32 + d, 1, 1, accent, false);
    }
    b(-4, -29 + d, 8, 1, ink.stem, false);
    b(-3, -30 + d, 1, 1, ink.stem, false);
    b(0, -30 + d, 1, 1, ink.stem, false);
    b(-2, -27 + d, 4, 1, ink.line, false);
    if (spark) {
        b(-8, -28 + d, 1, 1, ink.moon);
        b(7, -28 + d, 1, 1, ink.moon);
        b(-9, -26 + d, 1, 1, ink.moon);
        b(8, -26 + d, 1, 1, ink.moon);
    }
    paint(ctx, ink.line);

    // Bass across the hips, neck up to the left.
    b(-2, -18 + d, 12, 8, accent);
    b(-1, -19 + d, 7, 1, accent);
    b(-1, -10 + d, 9, 1, accent);
    b(7, -21 + d, 3, 3, accent);
    ln(0, -16 + d, -13, -29 + d, 2, ink.stone);
    b(-17, -33 + d, 4, 4, accent);
    b(1, -17 + d, 4, 5, ink.bone, false);
    b(5, -16 + d, 3, 1, ink.line, false);
    b(5, -13 + d, 3, 1, ink.stone, false);
    if (hit > 0.5) ln(1, -15 + d, -12, -28 + d, 1, ink.moon, false);
    paint(ctx, ink.line);

    const [fx, fy] = along(-1, -17, -13, -29, 0.3 + 0.6 * (1 - lift));
    limb(-6, -22 + d, -10, -17 + d, fx, fy + d, ink.wall, ink.green);
    const sy = hit > 0.3 ? (frame & 1 ? -11 : -17) : -14;
    limb(6, -22 + d, 11, -18 + d, 8, sy + d, ink.wall, ink.green);
    paint(ctx, ink.line);
}

/** Werewolf in flannel on a flying-V. He headbangs on the hit and his tail keeps time. */
function drawWolf(ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, accent: string, ink: Ink): void {
    const fur = ink.tomb;
    const dark = ink.tombShade;
    const shirt = ink.roof;
    const d = hit > 0.5 ? 1 : 0;
    const bang = hit > 0.5 ? 2 : 0;
    const wag = frame === 1 ? -2 : frame === 2 ? 1 : 0;
    b(-11, -15 + wag, 5, 2, fur);
    b(-13, -19 + wag, 3, 4, fur);
    b(-5, -11, 4, 8, ink.purple);
    b(1, -11, 4, 8, ink.purple);
    b(-4, -8, 2, 1, ink.bone, false);
    b(-6, -3, 5, 3, fur);
    b(1, -3, 5, 3, fur);
    b(-6, -24 + d, 12, 13, shirt);
    b(-6, -19 + d, 12, 1, ink.roofAlt, false);
    b(-6, -15 + d, 12, 1, ink.roofAlt, false);
    b(-2, -24 + d, 4, 5, fur, false);
    b(-6, -12 + d, 2, 1, shirt);
    b(4, -12 + d, 2, 1, shirt);
    b(-5, -30 + d, 3, 6, dark);
    const hy = -36 + d + bang;
    const hx = bang ? 1 : 0;
    b(-4 + hx, hy - 4, 2, 4, fur);
    b(3 + hx, hy - 4, 2, 4, fur);
    b(-4 + hx, hy - 3, 1, 2, accent, false);
    b(-4 + hx, hy, 9, 8, fur);
    b(4 + hx, hy + 3, 4, 4, fur);
    b(7 + hx, hy + 3, 2, 1, ink.line, false);
    b(-1 + hx, hy + 2, 2, 1, accent, false);
    b(2 + hx, hy + 2, 2, 1, accent, false);
    if (hit > 0.4) {
        b(4 + hx, hy + 7, 5, 2, ink.line);
        b(5 + hx, hy + 7, 1, 1, ink.bone, false);
        b(7 + hx, hy + 7, 1, 1, ink.bone, false);
    } else b(4 + hx, hy + 6, 4, 1, ink.line, false);
    paint(ctx, ink.line);

    // Flying-V: two prongs back to the right, neck steep up the left.
    ln(1, -16 + d, 8, -8 + d, 3, accent);
    ln(1, -16 + d, 10, -14 + d, 3, accent);
    ln(1, -16 + d, -10, -33 + d, 2, ink.stone);
    b(-13, -37 + d, 3, 4, accent);
    if (hit > 0.5) ln(2, -15 + d, -9, -32 + d, 1, ink.moon, false);
    paint(ctx, ink.line);

    const [fx, fy] = along(0, -17, -10, -33, 0.3 + 0.6 * (1 - lift));
    limb(-6, -22 + d, -10, -17 + d, fx, fy + d, shirt, fur);
    const sy = hit > 0.3 ? (frame & 1 ? -11 : -17) : -14;
    limb(6, -22 + d, 9, -15 + d, 4, sy + d, shirt, fur);
    paint(ctx, ink.line);
}

/** Mummy on trumpet. Pitch tilts the bell up; a held note leans back and puffs notes out. */
function drawMummy(
    ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, held: boolean, accent: string, ink: Ink,
): void {
    const wrap = ink.bone;
    const gap = ink.stoneDark;
    const d = hit > 0.5 ? 1 : 0;
    const lean = held ? -1 : 0;
    b(-5, -11, 4, 11, wrap);
    b(1, -11, 4, 11, wrap);
    b(-5, -8, 4, 1, gap, false);
    b(1, -5, 4, 1, gap, false);
    b(-6, -24 + d, 12, 14, wrap);
    for (let y = -22; y < -10; y += 3) b(-6, y + d, 12, 1, gap, false);
    b(-2, -20 + d, 1, 2, wrap, false);
    const flap = frame === 1 ? 1 : frame === 2 ? -1 : 0;
    b(-9, -18 + d + flap, 3, 1, wrap);
    b(-11, -17 + d + flap * 2, 2, 1, wrap);
    const hx = lean;
    b(-5 + hx, -35 + d, 10, 10, wrap);
    b(-5 + hx, -33 + d, 10, 1, gap, false);
    b(-5 + hx, -29 + d, 10, 1, gap, false);
    b(-4 + hx, -32 + d, 8, 2, ink.line, false);
    b(-3 + hx, -32 + d, 2, 1, accent, false);
    b(1 + hx, -32 + d, 2, 1, accent, false);
    b(2 + hx, -28 + d, 3, hit > 0.5 ? 2 : 1, hit > 0.5 ? wrap : gap, false);
    paint(ctx, ink.line);

    // Trumpet from the mouth to the right; the bell rises with pitch.
    const tilt = Math.round((lift - 0.5) * 6) + (held ? 1 : 0);
    const brass = hit > 0.5 ? ink.moon : accent;
    ln(4 + hx, -27 + d, 15, -27 + d - tilt, 2, brass);
    b(14, -30 + d - tilt, 3, 6, brass);
    b(17, -31 + d - tilt, 1, 8, brass);
    const v = frame;
    for (let i = 0; i < 3; i++) b(7 + i * 2, -30 + d + (i === v ? 1 : 0), 1, 2, ink.stone);
    if (hit > 0.15) {
        const rise = Math.round((1 - hit) * 8);
        b(20, -30 + d - tilt - rise, 2, 2, accent);
        b(23, -33 + d - tilt - rise * 2, 2, 2, accent);
    }
    paint(ctx, ink.line);

    limb(-6, -22 + d, -4, -16 + d, 6, -25 + d - Math.round(tilt / 3), wrap, wrap);
    limb(6, -22 + d, 8, -18 + d, 9, -28 + d - Math.round(tilt / 2), wrap, wrap);
    paint(ctx, ink.line);
}

/** Vampire at a church organ. Hands walk the keys with pitch; a held chord spreads the cape. */
function drawVamp(
    ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, held: boolean, accent: string, ink: Ink,
): void {
    const w = held ? 13 : 9;
    b(-w, -26, w * 2, 24, ink.line);
    b(-w + 2, -24, w * 2 - 4, 20, ink.red, false);
    if (held) {
        b(-w - 2, -28, 3, 4, ink.line);
        b(w - 1, -28, 3, 4, ink.line);
    }
    b(-4, -12, 3, 12, ink.line);
    b(1, -12, 3, 12, ink.line);
    b(-5, -24, 10, 12, ink.sil);
    b(-1, -24, 2, 7, ink.bone, false);
    b(-2, -24, 4, 1, accent, false);
    b(-8, -31, 3, 7, ink.line);
    b(5, -31, 3, 7, ink.line);
    const tip = held ? -1 : 0;
    b(-4, -34 + tip, 8, 9, ink.bone);
    b(-5, -36 + tip, 10, 3, ink.line);
    b(-1, -33 + tip, 2, 1, ink.line, false);
    b(-3, -31 + tip, 2, 1, accent, false);
    b(1, -31 + tip, 2, 1, accent, false);
    b(-2, -28 + tip, 4, 1, ink.line, false);
    b(-2, -27 + tip, 1, 1, ink.moon, false);
    b(1, -27 + tip, 1, 1, ink.moon, false);
    paint(ctx, ink.line);

    drawKeys(ctx, frame, hit, lift, held, accent, ink, false, ink.sil, ink.bone);
}

/**
 * Keyboard on an X stand, played by both hands. The hands walk the keys with
 * pitch and the pressed key lights in the team colour. `synth` swaps the
 * organ's case for a purple synth with a row of knobs.
 */
function drawKeys(
    ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, held: boolean, accent: string, ink: Ink,
    synth: boolean, sleeve: string, skin: string,
): void {
    ln(-10, -13, 8, -1, 1, ink.stoneDark);
    ln(8, -13, -10, -1, 1, ink.stoneDark);
    b(-15, synth ? -21 : -19, 30, synth ? 8 : 6, synth ? ink.purple : ink.sil);
    if (synth) {
        for (let k = -12; k < 13; k += 5) b(k, -20, 2, 1, hit > 0.5 && (k + 12) % 10 === 0 ? ink.moon : accent, false);
    }
    b(-14, -18, 28, 4, ink.bone, false);
    for (let k = -13; k < 14; k += 2) b(k, -18, 1, 4, ink.stone, false);
    for (let k = -12; k < 13; k += 4) {
        if (k !== 0) b(k, -18, 2, 2, ink.line, false);
    }
    const lx = -10 + Math.round(lift * 8);
    const press = hit > 0.5 ? frame & 1 : -1;
    if (press >= 0 || held) {
        b(press === 1 ? lx + 8 : lx, -16, 3, 2, accent, false);
        if (held) b(press === 1 ? lx : lx + 8, -16, 3, 2, accent, false);
    }
    paint(ctx, ink.line);

    const ld = press === 0 || held ? 1 : 0;
    const rd = press === 1 || held ? 1 : 0;
    limb(-5, -22, -9, -19, lx + 1, -20 + ld, sleeve, skin);
    limb(5, -22, 9, -19, lx + 9, -20 + rd, sleeve, skin);
    paint(ctx, ink.line);
}

/** The bride at a synth: a tall black beehive with white streaks, a cream gown. A held note makes the streaks crackle. */
function drawBride(
    ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, held: boolean, accent: string, ink: Ink,
): void {
    const gown = ink.stone;
    b(-6, -24, 12, 10, gown);
    b(-8, -14, 16, 13, gown);
    b(-9, -2, 18, 2, gown);
    b(-6, -24, 12, 1, ink.bone, false);
    b(-2, -22, 4, 1, accent, false);
    const tip = held ? -1 : 0;
    b(-2, -26, 4, 2, ink.bone);
    b(-4, -34 + tip, 8, 8, ink.bone);
    b(-2, -50 + tip, 4, 2, ink.line);
    b(-4, -48 + tip, 8, 3, ink.line);
    b(-5, -45 + tip, 10, 4, ink.line);
    b(-6, -41 + tip, 12, 7, ink.line);
    b(-6, -34 + tip, 2, 7, ink.line);
    b(4, -34 + tip, 2, 7, ink.line);
    const streak = held || hit > 0.6 ? ink.moon : ink.bone;
    for (const sx of [-4, 3]) {
        const lean = sx < 0 ? 1 : -1;
        b(sx, -46 + tip, 1, 3, streak, false);
        b(sx + lean, -43 + tip, 1, 3, streak, false);
        b(sx, -40 + tip, 1, 3, streak, false);
        b(sx + lean, -37 + tip, 1, 2, streak, false);
    }
    b(-4, -34 + tip, 8, 1, ink.line, false);
    b(-3, -31 + tip, 2, 1, ink.line, false);
    b(1, -31 + tip, 2, 1, ink.line, false);
    b(-3, -30 + tip, 1, 1, accent, false);
    b(2, -30 + tip, 1, 1, accent, false);
    b(-1, -28 + tip, 2, 1, ink.red, false);
    if (held) {
        b(-7, -47 + tip, 1, 1, ink.moon);
        b(6, -44 + tip, 1, 1, ink.moon);
    }
    paint(ctx, ink.line);

    drawKeys(ctx, frame, hit, lift, held, accent, ink, true, gown, ink.bone);
}

/**
 * Vampire with a keytar and shades, standing. The keys hand walks with pitch,
 * the neck hand works the grip, and a held note tips the neck up.
 */
function drawKeytarist(
    ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, held: boolean, accent: string, ink: Ink,
): void {
    const d = hit > 0.5 ? 1 : 0;
    b(-8, -26 + d, 16, 16, ink.line);
    b(-6, -24 + d, 12, 13, ink.red, false);
    stance(hit, frame, ink.sil, ink.line);
    b(-6, -24 + d, 12, 13, ink.purple);
    b(-2, -24 + d, 4, 6, ink.bone, false);
    b(-1, -24 + d, 2, 5, ink.line, false);
    b(-8, -30 + d, 3, 6, ink.line);
    b(5, -30 + d, 3, 6, ink.line);
    const tip = held ? -1 : 0;
    b(-4, -34 + d + tip, 8, 9, ink.bone);
    b(-5, -36 + d + tip, 10, 3, ink.line);
    b(-1, -33 + d + tip, 2, 1, ink.line, false);
    b(-4, -31 + d + tip, 8, 2, ink.line, false);
    b(-3, -31 + d + tip, 1, 1, ink.moon, false);
    b(-2, -28 + d + tip, 4, 1, ink.line, false);
    b(-2, -27 + d + tip, 1, 1, ink.moon, false);
    b(1, -27 + d + tip, 1, 1, ink.moon, false);
    paint(ctx, ink.line);

    // Keytar across the hips: body on the left, keys in the middle, neck up the right.
    const up = held ? 2 : 0;
    b(-15, -17 + d, 6, 8, accent);
    b(-14, -18 + d, 4, 1, accent);
    b(-9, -16 + d, 17, 5, ink.sil);
    b(-8, -15 + d, 15, 3, ink.bone, false);
    for (let k = -7; k < 7; k += 2) b(k, -15 + d, 1, 3, ink.stone, false);
    for (let k = -6; k < 7; k += 4) b(k, -15 + d, 1, 2, ink.line, false);
    ln(8, -14 + d, 15, -21 + d - up, 2, accent);
    b(14, -24 + d - up, 3, 3, accent);
    const kx = -7 + Math.round(lift * 12);
    if (hit > 0.5 || held) b(kx, -13 + d, 2, 1, accent, false);
    paint(ctx, ink.line);

    const ky = hit > 0.5 ? -15 : -17;
    limb(-6, -22 + d, -11, -18 + d, kx, ky + d, ink.purple, ink.bone);
    const gy = -20 - up + (hit > 0.5 ? frame & 1 : 0);
    limb(6, -22 + d, 10, -18 + d, 12, gy + d, ink.purple, ink.bone);
    paint(ctx, ink.line);
}

/** Witch on a theremin. Her hand nears the antenna as the pitch rises; the hit throws sparks. */
function drawWitch(ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, accent: string, ink: Ink): void {
    const sway = frame === 1 ? -1 : frame === 2 ? 1 : 0;
    b(-6, -24, 12, 8, ink.purple);
    b(-7, -16, 14, 13, ink.purple);
    b(-8, -4, 16, 3, ink.purple);
    b(-8, -2, 2, 1, ink.purple);
    b(-3, -2, 2, 1, ink.purple);
    b(3, -2, 2, 1, ink.purple);
    b(-7, -1, 5, 1, ink.line);
    b(3, -1, 5, 1, ink.line);
    b(-2, -21, 4, 1, accent, false);
    const hx = sway;
    b(-6 + hx, -33, 2, 9, ink.line);
    b(4 + hx, -33, 2, 7, ink.line);
    b(-4 + hx, -33, 8, 8, ink.green);
    b(3 + hx, -30, 3, 2, ink.green);
    b(5 + hx, -31, 1, 1, ink.stem, false);
    b(-3 + hx, -31, 2, 1, hit > 0.4 ? ink.moon : accent, false);
    b(1 + hx, -31, 2, 1, hit > 0.4 ? ink.moon : accent, false);
    b(-2 + hx, -27, 4, 1, ink.line, false);
    b(-9 + hx, -35, 18, 2, ink.line);
    b(-5 + hx, -39, 10, 4, ink.line);
    b(-3 + hx, -43, 6, 4, ink.line);
    b(-1 + hx, -46, 4, 3, ink.line);
    b(1 + hx, -48, 4, 2, ink.line);
    b(-5 + hx, -37, 10, 1, accent, false);
    paint(ctx, ink.line);

    // Theremin: a box on a stand, antenna up the right side.
    b(13, -11, 1, 11, ink.stoneDark);
    b(10, -1, 7, 1, ink.stoneDark);
    b(9, -16, 9, 5, ink.roofAlt);
    b(10, -15, 2, 1, accent, false);
    b(17, -36, 1, 20, ink.stone);
    if (hit > 0.3) {
        const s = frame;
        b(19, -33 + s, 1, 1, ink.moon);
        b(20, -31 - s, 1, 1, ink.moon);
        b(19, -28 + s, 1, 1, accent);
        b(21, -26, 1, 1, accent);
    }
    paint(ctx, ink.line);

    const rx = 15 - Math.round((1 - lift) * 8);
    const ry = -26 + (frame === 1 ? -2 : frame === 2 ? 1 : 0);
    limb(5, -22, 8, -18, rx, ry, ink.purple, ink.green);
    const ly = hit > 0.5 ? -31 : -24;
    limb(-5, -22, -9, -18, -10, ly, ink.purple, ink.green);
    if (hit > 0.5) {
        b(-12, ly - 1, 1, 1, ink.green);
        b(-8, ly - 2, 1, 1, ink.green);
    }
    paint(ctx, ink.line);
}

/** Pumpkin-head on a xylophone of bones. Pitch picks the bar; the mallets take turns. */
function drawPumpkin(ctx: CanvasRenderingContext2D, frame: number, hit: number, lift: number, accent: string, ink: Ink): void {
    const d = hit > 0.5 ? 1 : 0;
    const glow = hit > 0.4 ? ink.moon : ink.line;
    b(-4, -11, 3, 9, ink.stem);
    b(1, -11, 3, 9, ink.stem);
    b(-5, -3, 4, 3, ink.sil);
    b(1, -3, 4, 3, ink.sil);
    b(-6, -24 + d, 12, 13, ink.purple);
    b(-1, -24 + d, 2, 13, ink.green, false);
    b(-7, -35 + d, 14, 10, ink.accent);
    b(-6, -36 + d, 12, 1, ink.accent);
    b(-6, -25 + d, 12, 1, ink.accent);
    b(-1, -35 + d, 1, 10, ink.accentDark, false);
    b(-1, -39 + d, 2, 3, ink.stem);
    b(1, -39 + d, 2, 1, ink.green);
    b(-5, -32 + d, 3, 2, glow, false);
    b(-4, -33 + d, 1, 1, glow, false);
    b(2, -32 + d, 3, 2, glow, false);
    b(3, -33 + d, 1, 1, glow, false);
    b(-4, -28 + d, 8, 1, glow, false);
    b(-3, -27 + d, 6, 1, glow, false);
    b(-2, -28 + d, 1, 1, ink.accent, false);
    b(1, -28 + d, 1, 1, ink.accent, false);
    paint(ctx, ink.line);

    // Six bone bars on a frame, longest on the left.
    ln(-13, -10, -15, 0, 1, ink.roofAlt);
    ln(12, -10, 14, 0, 1, ink.roofAlt);
    b(-14, -11, 28, 1, ink.roofAlt);
    const bar = Math.round(lift * 5);
    const lit = hit > 0.3;
    for (let i = 0; i < 6; i++) {
        const x = -13 + i * 5;
        const len = 7 - i;
        const c = lit && i === bar ? accent : ink.bone;
        b(x, -11 - len, 3, len, c);
        b(x - 1, -12 - len, 2, 2, c, false);
        b(x + 2, -12 - len, 2, 2, c, false);
    }
    paint(ctx, ink.line);

    // The near hand takes its side's bars, the middle two alternate.
    // The striking mallet lands on the bar's top end; the other waits above its side.
    const strikeLeft = bar === 2 || bar === 3 ? (frame & 1) === 0 : bar < 2;
    const bx = -12 + bar * 5;
    const by = -13 - (7 - bar);
    const down = hit > 0.5;
    const lHand: Pt = strikeLeft && down ? [bx - 5, by - 4] : [-9, -19];
    const rHand: Pt = !strikeLeft && down ? [bx + 5, by - 4] : [9, -19];
    const lTip: Pt = strikeLeft && down ? [bx, by] : [-12, -27];
    const rTip: Pt = !strikeLeft && down ? [bx, by] : [12, -27];
    ln(lHand[0], lHand[1] + d, lTip[0], lTip[1] + d, 1, ink.stone);
    ln(rHand[0], rHand[1] + d, rTip[0], rTip[1] + d, 1, ink.stone);
    b(lTip[0] - 1, lTip[1] - 1 + d, 2, 2, accent);
    b(rTip[0], rTip[1] - 1 + d, 2, 2, accent);
    limb(-6, -22 + d, -9, -16 + d, lHand[0], lHand[1] + d, ink.purple, ink.green);
    limb(6, -22 + d, 9, -16 + d, rHand[0], rHand[1] + d, ink.purple, ink.green);
    paint(ctx, ink.line);
}

/** A sung note: head on the bottom left. */
const NOTE: Sprite = spr(`
    ..11
    ..1.
    111.
    11..
`);

/** Ghost singing. It sways with the onsets, floats on the hit, and notes rise from its mouth. */
function drawChoir(
    ctx: CanvasRenderingContext2D, x: number, foot: number, frame: number, hit: number, lift: number,
    accent: string, ink: Ink,
): void {
    const sway = frame % 3 === 1 ? -2 : frame % 3 === 2 ? 2 : 0;
    const float = Math.round(hit * 4 + lift * 4);
    const gx = Math.round(x - 12 + sway);
    const gy = Math.round(foot - 30 - float);
    drawGhostAt(ctx, gx, gy, frame, ink.ghost, accent, ink.moon, ink.line, 2);
    const open = hit > 0.4 ? 3 + (frame % 2) : 1;
    ctx.fillStyle = ink.line;
    ctx.fillRect(gx + 9, gy + 13, 6, open + 1);
    if (hit > 0.4) {
        ctx.fillStyle = ink.red;
        ctx.fillRect(gx + 10, gy + 14, 4, open - 1);
    }
    if (hit > 0.1) {
        const rise = Math.round((1 - hit) * 14);
        const nx = gx + 22 + (frame % 2) * 2;
        drawSprite(ctx, NOTE, nx, gy + 4 - rise, [null, accent], {outline: ink.line});
    }
}

/** Skull, jaw and torso as separate pieces, so the head can nod and the jaw drop. 1 bone, 2 socket, 3 pupil. */
const DRUM_SKULL: Sprite = spr(`
    ...1111111...
    .11111111111.
    1111111111111
    1122211122211
    1123211123211
    1122211122211
    .11111211111.
    ..111222111..
    ...1111111...
    ...1.1.1.1...
`);

const DRUM_JAW: Sprite = spr(`
    ...1111111...
    ....11111....
`);

const DRUM_TORSO: Sprite = spr(`
    ......1......
    ..111111111..
    ......1......
    ..111111111..
    ......1......
    ..111111111..
    ......1......
    ...1111111...
    ......1......
    ....11111....
    ...1111111...
    ...11...11...
`);

/** Pelvis sits this far above the riser, behind the kick. */
const SEAT = 19;

type Pt = readonly [number, number];

/** Elbow, hand and stick tip, relative to the drummer's foot. */
interface Stroke {
    elbow: Pt;
    hand: Pt;
    tip: Pt;
}

/** A target played down (stick on the head) and up (stick cocked over it). */
interface Target {
    down: Stroke;
    up: Stroke;
}

const SHOULDER_L: Pt = [-5, -30];
const SHOULDER_R: Pt = [5, -30];

/**
 * Viewer's left hand: rack tom, floor tom, crash, and every other snare
 * stroke. It rebounds to its own side, clear of the skull.
 */
const LEFT = {
    tom: {
        down: {elbow: [-11, -24], hand: [-10, -31], tip: [-14, -27]},
        up: {elbow: [-11, -25], hand: [-10, -35], tip: [-13, -43]},
    },
    floor: {
        down: {elbow: [-12, -24], hand: [-18, -26], tip: [-26, -19]},
        up: {elbow: [-12, -25], hand: [-17, -30], tip: [-22, -38]},
    },
    crash: {
        down: {elbow: [-11, -33], hand: [-17, -39], tip: [-28, -45]},
        up: {elbow: [-11, -34], hand: [-17, -42], tip: [-24, -50]},
    },
    snare: {
        down: {elbow: [-8, -24], hand: [-1, -27], tip: [8, -24]},
        up: {elbow: [-10, -25], hand: [-8, -31], tip: [-11, -39]},
    },
} as const satisfies Record<string, Target>;

/** Viewer's right hand: hats and snare. */
const RIGHT = {
    snare: {
        down: {elbow: [10, -24], hand: [8, -29], tip: [15, -24]},
        up: {elbow: [10, -25], hand: [9, -33], tip: [13, -41]},
    },
    hat: {
        down: {elbow: [11, -33], hand: [18, -36], tip: [28, -36]},
        up: {elbow: [11, -34], hand: [18, -39], tip: [26, -44]},
    },
} as const satisfies Record<string, Target>;

const REST_L: Stroke = {elbow: [-10, -24], hand: [-10, -30], tip: [-15, -36]};
const REST_R: Stroke = {elbow: [10, -24], hand: [9, -30], tip: [14, -36]};

/** Above this the stick is on the head; above `UP` it is still cocked over it. */
const DOWN = 0.55;
const UP = 0.12;

/** Rects for one outlined layer, kept between frames. Outlines go down first, then the fills. */
const layer: {x: number; y: number; w: number; h: number; c: string; edge: boolean}[] = [];
let layerN = 0;

function put(x: number, y: number, w: number, h: number, c: string, edge = true): void {
    let r = layer[layerN];
    if (!r) {
        r = {x: 0, y: 0, w: 0, h: 0, c: '', edge: true};
        layer[layerN] = r;
    }
    r.x = x;
    r.y = y;
    r.w = w;
    r.h = h;
    r.c = c;
    r.edge = edge;
    layerN++;
}

function paint(ctx: CanvasRenderingContext2D, outline: string): void {
    ctx.fillStyle = outline;
    for (let i = 0; i < layerN; i++) {
        const r = layer[i];
        if (r.edge) ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    }
    for (let i = 0; i < layerN; i++) {
        const r = layer[i];
        ctx.fillStyle = r.c;
        ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    layerN = 0;
}

/** A `size`-pixel brush along a line. */
function seg(x0: number, y0: number, x1: number, y1: number, size: number, c: string, edge = true): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
        put(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), size, size, c, edge);
    }
}

function drawDrummer(
    ctx: CanvasRenderingContext2D, x: number, foot: number, hit: number,
    accent: string, ink: Ink, kit?: KitFlash,
): void {
    const X = Math.round(x);
    const k = kit ?? IDLE_KIT;
    const dip = k.kick > DOWN ? 1 : 0;
    const nod = dip + (k.snare > DOWN || k.crash > DOWN ? 1 : 0);
    const jaw = k.crash > 0.3 || k.snare > 0.7 ? 1 : 0;
    const eye = hit > 0.4 ? accent : ink.line;

    drawCymbals(X, foot, k, ink);
    paint(ctx, ink.line);

    const top = foot - SEAT - DRUM_TORSO.h + dip;
    drawSprite(ctx, DRUM_TORSO, X - 6, top, [null, ink.bone], {outline: ink.line});
    const skull = top - DRUM_SKULL.h - 1 + (nod - dip);
    drawSprite(ctx, DRUM_JAW, X - 6, skull + DRUM_SKULL.h + jaw, [null, ink.bone], {outline: ink.line});
    drawSprite(ctx, DRUM_SKULL, X - 6, skull, [null, ink.bone, ink.line, eye], {outline: ink.line});

    drawDrums(X, foot, k, ink);
    paint(ctx, ink.line);

    const grip = hit > 0.4 ? accent : ink.bone;
    drawArm(X, foot + dip, SHOULDER_L, leftStroke(k), grip, ink);
    drawArm(X, foot + dip, SHOULDER_R, rightStroke(k), grip, ink);
    paint(ctx, ink.line);
}

const IDLE_KIT: KitFlash = {
    kick: 0, snare: 0, hat: 0, tom: 0, crash: 0, snareHand: 0, floorTom: false,
    kickCss: '', snareCss: '', hatCss: '', tomCss: '', crashCss: '',
};

/**
 * Snare strokes alternate hands, unless the other hand is busy: the right
 * hand plays the hats, the left the toms and the crash.
 */
function snareLeft(k: KitFlash): boolean {
    if (k.hat >= k.snare) return true;
    if (Math.max(k.tom, k.crash) >= k.snare) return false;
    return k.snareHand === 1;
}

/** Each hand plays whichever of its pieces was hit last. */
function leftStroke(k: KitFlash): Stroke {
    const snare = snareLeft(k) ? k.snare : 0;
    let v = k.tom;
    let t: Target = k.floorTom ? LEFT.floor : LEFT.tom;
    if (k.crash > v) {
        v = k.crash;
        t = LEFT.crash;
    }
    if (snare > v) {
        v = snare;
        t = LEFT.snare;
    }
    return v > DOWN ? t.down : v > UP ? t.up : REST_L;
}

function rightStroke(k: KitFlash): Stroke {
    const snare = snareLeft(k) ? 0 : k.snare;
    const t = k.hat >= snare ? RIGHT.hat : RIGHT.snare;
    const v = Math.max(k.hat, snare);
    return v > DOWN ? t.down : v > UP ? t.up : REST_R;
}

function drawArm(X: number, foot: number, shoulder: Pt, s: Stroke, grip: string, ink: Ink): void {
    const sx = X + shoulder[0];
    const sy = foot + shoulder[1];
    const ex = X + s.elbow[0];
    const ey = foot + s.elbow[1];
    const hx = X + s.hand[0];
    const hy = foot + s.hand[1];
    seg(hx, hy, X + s.tip[0], foot + s.tip[1], 1, ink.stone);
    seg(sx, sy, ex, ey, 2, ink.bone);
    seg(ex, ey, hx, hy, 2, ink.bone);
    put(hx - 1, hy - 1, 3, 3, grip);
}

function hot(amount: number, css: string, idle: string): string {
    return amount > 0.35 && css ? css : idle;
}

/** Crash on a boom over the floor tom, hats on the right. Both sit behind the drummer. */
function drawCymbals(X: number, foot: number, k: KitFlash, ink: Ink): void {
    const chrome = ink.stoneDark;
    put(X - 38, foot - 44, 1, 44, chrome);
    put(X - 41, foot - 1, 7, 1, chrome);
    const tilt = k.crash > 0.6 ? 2 : k.crash > 0.3 ? 1 : 0;
    const crash = hot(k.crash, k.crashCss, ink.moon);
    put(X - 47, foot - 46 + tilt, 9, 1, crash);
    put(X - 38, foot - 46 - tilt, 10, 1, crash);
    put(X - 40, foot - 47, 4, 1, crash);

    put(X + 30, foot - 34, 1, 34, chrome);
    put(X + 27, foot - 1, 7, 1, chrome);
    const lift = k.hat > 0.35 ? 2 : 0;
    const hat = hot(k.hat, k.hatCss, ink.moon);
    put(X + 23, foot - 35, 15, 1, hat);
    put(X + 23, foot - 37 - lift, 15, 1, hat);
    put(X + 28, foot - 38 - lift, 5, 1, hat);
}

/** Floor tom left, rack tom on the kick, snare right, kick in front with a jack-o'-lantern head. */
function drawDrums(X: number, foot: number, k: KitFlash, ink: Ink): void {
    const chrome = ink.stone;
    const shell = ink.purple;
    const tom = hot(k.tom, k.tomCss, ink.bone);

    // Floor tom.
    put(X - 31, foot - 5, 1, 5, chrome);
    put(X - 21, foot - 5, 1, 5, chrome);
    put(X - 32, foot - 18, 13, 1, k.floorTom ? tom : ink.bone);
    put(X - 32, foot - 17, 13, 1, chrome);
    put(X - 32, foot - 16, 13, 10, shell);
    put(X - 32, foot - 6, 13, 1, chrome);

    // Kick: hoop, head, spurs, face.
    const kick = k.kick > DOWN;
    const bump = kick ? 1 : 0;
    const head = hot(k.kick, k.kickCss, ink.bone);
    put(X - 14, foot - 4, 2, 4, chrome);
    put(X + 13, foot - 4, 2, 4, chrome);
    put(X - 8, foot - 19 - bump, 17, 1, chrome);
    put(X - 10, foot - 18 - bump, 21, 17 + bump, chrome);
    put(X - 8, foot - 1, 17, 1, chrome);
    put(X - 7, foot - 18 - bump, 15, 1, head, false);
    put(X - 9, foot - 17 - bump, 19, 15 + bump, head, false);
    put(X - 7, foot - 2, 15, 1, head, false);
    const face = kick ? ink.moon : ink.accent;
    const fy = foot - bump;
    put(X - 6, fy - 13, 3, 2, face, false);
    put(X - 5, fy - 14, 1, 1, face, false);
    put(X + 4, fy - 13, 3, 2, face, false);
    put(X + 5, fy - 14, 1, 1, face, false);
    put(X - 1, fy - 10, 3, 1, face, false);
    put(X - 6, fy - 8, 13, 2, face, false);
    put(X - 5, fy - 6, 11, 1, face, false);
    put(X - 3, fy - 8, 1, 1, head, false);
    put(X + 3, fy - 8, 1, 1, head, false);

    // Rack tom, mounted on the kick.
    put(X - 9, foot - 20, 2, 2, chrome);
    put(X - 18, foot - 27, 12, 1, k.floorTom ? ink.bone : tom);
    put(X - 18, foot - 26, 12, 1, chrome);
    put(X - 18, foot - 25, 12, 5, shell);
    put(X - 18, foot - 20, 12, 1, chrome);

    // Snare on its stand.
    const sd = k.snare > DOWN ? 1 : 0;
    put(X + 12, foot - 19, 1, 18, chrome);
    put(X + 9, foot - 1, 7, 1, chrome);
    put(X + 7, foot - 24 + sd, 12, 1, hot(k.snare, k.snareCss, ink.bone));
    put(X + 7, foot - 23 + sd, 12, 1, chrome);
    put(X + 7, foot - 22 + sd, 12, 3, shell);
    put(X + 7, foot - 19 + sd, 12, 1, chrome);
}
