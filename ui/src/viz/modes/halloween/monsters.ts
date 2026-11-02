/**
 * Pixel monsters shared by the band and the house windows.
 * The cast comes from the sound name. Drum voices are the token after the
 * last `_` (so `RolandTR909_sd` is a snare), never `instrumentFamily`'s
 * `perc` bucket — that bucket is every non-drum, including a trumpet.
 */

import {drawSprite, type Ink} from './pixel.js';
import {halloweenRole, type Role} from './roles.js';
import {drawGhostAt} from './sky.js';
import {SKEL_DOWN, SKEL_OUT, SKEL_UP} from './sprites.js';
import {instrumentFamily} from '../../tracks.js';

export type Cast = 'drummer' | 'frank' | 'wolf' | 'mummy' | 'vamp' | 'witch' | 'keytar' | 'ghost';

export type WinKind = 'vamp' | 'witch' | 'frank' | 'mummy' | 'wolf' | 'cat' | 'boo';

export type KitPiece = 'kick' | 'snare' | 'hat' | 'tom' | 'crash';

export interface KitFlash {
    kick: number;
    snare: number;
    hat: number;
    tom: number;
    crash: number;
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

function voiceOf(name: string): string {
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

/**
 * One character for a team. `note` is the lowest note in view, or NaN when
 * the team has not played a pitch yet. Only `sine` consults it: below C3
 * the sine is Frankenstein, at C3 and above it sings with the ghosts.
 */
export function castFor(name: string, note: number): Cast {
    const lower = name.toLowerCase();
    const voice = voiceOf(lower);
    if (/trumpet|sax|horn|brass|trombone|tuba/.test(lower)) return 'mummy';
    if (/epiano|piano|organ|pad|keys|rhodes|clav/.test(lower)) return 'vamp';
    if (/bass|sub/.test(lower) || voice === '808' || lower === '808') return 'frank';
    if (voice === 'sine' || lower === 'sine') return Number.isFinite(note) && note >= C3 ? 'ghost' : 'frank';
    if (/guitar|gtr/.test(lower)) return 'wolf';
    if (/xylo|pluck|marimba|kalimba/.test(lower)) return 'keytar';
    if (/saw|square|lead|theremin/.test(lower)) return 'witch';
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

const FIGURE_H = 34;

/** A band member standing on `foot`. `x` is the centre. High `lift` raises the hands. */
export function drawPerformer(
    ctx: CanvasRenderingContext2D, cast: Cast, x: number, foot: number, frame: number,
    hit: number, lift: number, accent: string, ink: Ink, kit?: KitFlash,
): void {
    if (cast === 'drummer') {
        drawDrummer(ctx, x, foot, frame, hit, accent, ink, kit);
        return;
    }
    if (cast === 'ghost') {
        drawChoir(ctx, x, foot, frame, hit, accent, ink);
        return;
    }
    const r = pen(ctx, x, foot - FIGURE_H);
    const up = Math.round((lift - 0.5) * 4);
    const f = frame % 3;
    switch (cast) {
        case 'frank': drawFrank(r, f, up, hit, accent, ink); break;
        case 'wolf': drawWolf(r, f, up, hit, accent, ink); break;
        case 'mummy': drawMummy(r, f, up, hit, accent, ink); break;
        case 'vamp': drawVamp(r, f, up, hit, accent, ink); break;
        case 'witch': drawWitch(r, f, up, hit, accent, ink); break;
        case 'keytar': drawKeytar(r, f, up, hit, accent, ink); break;
    }
}

function drawChoir(
    ctx: CanvasRenderingContext2D, x: number, foot: number, frame: number, hit: number, accent: string, ink: Ink,
): void {
    const gw = 24;
    const gh = 24;
    const float = Math.round(hit * 6 + (frame % 3 === 2 ? 2 : 0));
    const gx = Math.round(x - gw / 2);
    const gy = Math.round(foot - gh - float);
    drawGhostAt(ctx, gx, gy, frame, ink.ghost, accent, ink.moon, hit > 0.4 ? accent : ink.line, 2);
    ctx.fillStyle = frame % 3 === 0 && hit <= 0.4 ? ink.line : ink.red;
    const mouth = hit > 0.4 ? 2 + (frame % 3) : 1;
    ctx.fillRect(gx + 8, gy + 14, 8, mouth);
}

function drawDrummer(
    ctx: CanvasRenderingContext2D, x: number, foot: number, frame: number, hit: number,
    accent: string, ink: Ink, kit?: KitFlash,
): void {
    const sprite = frame % 3 === 1 ? SKEL_UP : frame % 3 === 2 ? SKEL_OUT : SKEL_DOWN;
    const hop = frame % 3 === 1 ? 2 : 0;
    const eyes = hit > 0.4 ? accent : ink.line;
    drawSprite(
        ctx, sprite,
        Math.round(x - sprite.w * 2 / 2), Math.round(foot - sprite.h * 2 - hop),
        [null, ink.bone, eyes],
        {scale: 2, outline: ink.line},
    );
    if (kit) drawKit(ctx, x, foot, kit, ink);
}

function hot(amount: number, css: string, idle: string): string {
    return amount > 0.35 && css ? css : idle;
}

/** Kit around the drummer. Pieces stay outside the skull and over the shins. */
function drawKit(ctx: CanvasRenderingContext2D, x: number, foot: number, kit: KitFlash, ink: Ink): void {
    const X = Math.round(x);
    const kick = kit.kick > 0.35;
    ctx.fillStyle = ink.line;
    ctx.fillRect(X - 34, foot - 26, 1, 26);
    ctx.fillRect(X + 30, foot - 18, 1, 18);
    ctx.fillRect(X - 24, foot - 16, 1, 16);
    ctx.fillRect(X + 20, foot - 11, 1, 11);
    const swing = kit.crash > 0.35 ? -3 : 0;
    ctx.fillStyle = hot(kit.crash, kit.crashCss, ink.moon);
    ctx.fillRect(X - 44, foot - 26 + swing, 14, 2);
    if (kit.crash > 0.35) ctx.fillRect(X - 40, foot - 28 + swing, 8, 1);
    const gap = kit.hat > 0.35 ? 3 : 1;
    ctx.fillStyle = hot(kit.hat, kit.hatCss, ink.moon);
    ctx.fillRect(X + 24, foot - 20 - gap, 11, 2);
    ctx.fillRect(X + 24, foot - 17, 11, 2);
    ctx.fillStyle = ink.line;
    ctx.fillRect(X - 30, foot - 14, 10, 5);
    ctx.fillRect(X - 28, foot - 20, 8, 4);
    if (kit.tom > 0.35) {
        ctx.fillStyle = hot(kit.tom, kit.tomCss, ink.roof);
        ctx.fillRect(X - 29, foot - 13, 8, 3);
        ctx.fillRect(X - 27, foot - 19, 6, 2);
    }
    const snareY = foot - 15 - (kit.snare > 0.35 ? 1 : 0);
    ctx.fillStyle = hot(kit.snare, kit.snareCss, ink.stone);
    ctx.fillRect(X + 16, snareY, 10, 4);
    ctx.fillStyle = ink.bone;
    ctx.fillRect(X + 18, snareY - (kit.snare > 0.35 ? 2 : 1), kit.snare > 0.35 ? 7 : 5, 1);
    ctx.fillStyle = hot(kit.kick, kit.kickCss, ink.stoneDark);
    ctx.fillRect(X - 8, foot - 12, 16, 10);
    ctx.fillStyle = kick ? ink.moon : ink.line;
    ctx.fillRect(X - 4, foot - 9, 8, 5);
    ctx.fillStyle = ink.bone;
    ctx.fillRect(X + 2, foot - 2, 6, 2);
    ctx.fillRect(X + 4, kick ? foot - 11 : foot - 7, 2, kick ? 4 : 5);
}

function arms(r: Rect, frame: number, up: number, skin: string, y = 15): void {
    const ay = y - up + (frame === 1 ? -3 : frame === 2 ? 3 : 0);
    r(-9, ay, 4, 2, skin);
    r(5, ay, 4, 2, skin);
}

function legs(r: Rect, frame: number, cloth: string): void {
    const step = frame === 2 ? 2 : frame === 1 ? -1 : 0;
    r(-4, 22, 3, 10, cloth);
    r(1 + step, 22, 3, 10, cloth);
    r(-5, 31, 4, 3, inkSafe(cloth));
    r(step, 31, 4, 3, inkSafe(cloth));
}

/** Shoes stay a dark bar; the cloth colour is only used as a fallback marker. */
function inkSafe(cloth: string): string {
    return cloth;
}

function head(r: Rect, up: number, skin: string, eye: string, hair?: string): number {
    const hy = 6 - up;
    if (hair) r(-5, hy - 2, 10, 3, hair);
    r(-4, hy, 8, 6, skin);
    r(-3, hy + 2, 2, 2, eye);
    r(2, hy + 2, 2, 2, eye);
    return hy;
}

function drawFrank(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const spark = hit > 0.4;
    const hy = head(r, up, ink.green, ink.line, ink.line);
    r(-8, hy + 2, 3, 2, spark ? ink.moon : accent);
    r(5, hy + 2, 3, 2, spark ? ink.moon : accent);
    if (spark) {
        r(-9, hy + 1, 1, 1, ink.moon);
        r(8, hy + 1, 1, 1, ink.moon);
    }
    r(-5, 13, 10, 9, ink.purple);
    r(-1, 15, 2, 1, ink.line);
    r(-1, 18, 2, 1, ink.line);
    arms(r, frame, up, ink.green);
    legs(r, frame, ink.line);
    r(7, 4, 2, 16, ink.stone);
    r(6, 2, 4, 2, ink.stoneDark);
    r(5, 16, 8, 10, accent);
    r(7, 18, 4, 2, ink.line);
    r(8, 6, 1, 12, ink.moon);
}

function drawWolf(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const hy = 6 - up;
    r(-7, hy - 3, 3, 4, ink.roof);
    r(4, hy - 3, 3, 4, ink.roof);
    r(-4, hy, 8, 6, ink.roof);
    r(-3, hy + 2, 2, 2, accent);
    r(2, hy + 2, 2, 2, accent);
    r(-1, hy + 4, 5, 3, ink.bone);
    r(1, hy + 5, 2, 1, ink.line);
    if (hit > 0.4) r(2, hy + 6, 2, 1, ink.line);
    r(-5, 13, 10, 9, ink.roofAlt);
    arms(r, frame, up, ink.roof);
    legs(r, frame, ink.line);
    const wag = frame === 2 ? -2 : 0;
    r(-12 + wag, 16, 4, 2, ink.roof);
    r(-14 + wag, 14, 2, 2, ink.roof);
    r(6, 8, 2, 12, ink.line);
    r(5, 16, 8, 8, accent);
    r(7, 18, 3, 2, ink.line);
    r(7, 10, 1, 8, ink.moon);
}

function drawMummy(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const hy = head(r, up, ink.bone, accent);
    r(-4, hy + 1, 8, 1, ink.line);
    r(-4, hy + 4, 8, 1, ink.line);
    r(-5, 13, 10, 9, ink.bone);
    r(-5, 15, 10, 1, ink.line);
    r(-5, 18, 10, 1, ink.line);
    r(-5, 21, 10, 1, ink.line);
    arms(r, frame, up, ink.bone);
    legs(r, frame, ink.bone);
    r(-4, 24, 3, 1, ink.line);
    r(1, 26, 3, 1, ink.line);
    r(6, 10, 2, 8, accent);
    r(4, 8, 6, 3, accent);
    r(8, 12, 1, 4, ink.moon);
    if (hit > 0.4) {
        const flap = frame === 1 ? -2 : frame === 2 ? 2 : 0;
        r(6 + flap, 18, 5, 3, ink.bone);
        r(7 + flap, 19, 3, 1, ink.line);
    }
}

function drawVamp(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const wide = hit > 0.4;
    r(wide ? -11 : -8, 12, wide ? 22 : 16, 18, accent);
    r(-8, 2, 2, 16, ink.stone);
    r(-5, 0, 2, 18, ink.moon);
    r(4, 0, 2, 18, ink.stone);
    r(7, 4, 2, 14, ink.moon);
    const hy = head(r, up, ink.bone, accent, ink.line);
    r(-1, hy + 1, 2, 2, ink.line);
    r(-2, hy + 5, 1, 1, ink.moon);
    r(1, hy + 5, 1, 1, ink.moon);
    r(-4, 13, 8, 8, ink.line);
    arms(r, frame, up, ink.bone, 16);
    r(-7, 20, 14, 3, ink.line);
    r(-6, 21, 2, 1, ink.moon);
    r(-3, 21, 2, 1, ink.moon);
    r(0, 21, 2, 1, ink.moon);
    r(3, 21, 2, 1, ink.moon);
    legs(r, frame, ink.line);
}

function drawWitch(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const hy = head(r, up, ink.green, hit > 0.4 ? ink.moon : accent);
    r(-1, hy - 6, 2, 4, ink.line);
    r(-6, hy - 2, 12, 2, ink.line);
    r(-6, 13, 12, 14, ink.purple);
    r(-2, 16, 4, 2, ink.line);
    const hand = 12 - up + (frame === 1 ? -2 : 0);
    r(-8, 16, 3, 2, ink.green);
    r(4, hand, 4, 2, ink.green);
    r(-3, 30, 3, 4, ink.line);
    r(1, 30, 3, 4, ink.line);
    r(9, 14, 2, 18, ink.line);
    r(9, 6, 2, 8, ink.line);
    r(8, 3, 4, 4, hit > 0.4 ? ink.moon : accent);
}

function drawKeytar(r: Rect, frame: number, up: number, hit: number, accent: string, ink: Ink): void {
    const hy = 5 - up;
    r(-1, hy - 3, 2, 3, ink.stem);
    r(-5, hy, 10, 8, ink.accent);
    r(-3, hy + 2, 2, 2, hit > 0.4 ? accent : ink.line);
    r(2, hy + 2, 2, 2, hit > 0.4 ? accent : ink.line);
    r(-2, hy + 5, 5, 2, ink.line);
    r(0, hy + 5, 1, 1, ink.accent);
    r(-5, 14, 10, 8, ink.purple);
    arms(r, frame, up, ink.bone);
    legs(r, frame, ink.line);
    r(4, 8, 3, 10, ink.line);
    r(2, 14, 12, 7, accent);
    r(4, 16, 2, 2, hit > 0.4 ? ink.moon : ink.bone);
    r(7, 16, 2, 2, ink.bone);
    r(10, 16, 2, 2, hit > 0.4 ? ink.moon : ink.bone);
    r(5, 6, 2, 3, ink.stone);
}
