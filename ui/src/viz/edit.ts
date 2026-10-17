/**
 * Music-video edit: a camera over the mode and section title cards, both pure
 * functions of song time and the song's structure (its sections and kick
 * onsets), so any frame renders the same in any order. Offline renders take
 * the structure from a performance export, a live show from the song's form.
 */

import type {VizLayer, VizServices} from './types.js';
import {MONO_FONT, clamp01, hash32, rand01} from './util.js';

export interface Section {
    label: string;
    /** Song seconds. */
    at: number;
    end: number;
    /** The title card's text; `// LABEL` when absent. */
    title?: string;
}

/** How the camera moves across a section. */
export const CAMERA_MOVES = ['drift', 'push', 'pull', 'orbit', 'still', 'shake'] as const;
export type CameraMove = typeof CAMERA_MOVES[number];

export interface CameraStyle {
    move: CameraMove;
    /** Strength of the slam on each section's downbeat; 1 is the default, 0 none. */
    punch: number;
    /** Strength of the bump on each kick; 1 is the default, 0 none. */
    kick: number;
}

export const DEFAULT_CAMERA: CameraStyle = {move: 'drift', punch: 1, kick: 1};

/** How the mode is framed: zoom and turn about the frame center, then pan by a fraction of the frame width. */
export interface View {
    scale: number;
    rotate: number;
    x: number;
    y: number;
}

/** Zoom across a section, from its downbeat to its end. Rotation and pan need the headroom. */
const DRIFT_FROM = 1.12;
const DRIFT_TO = 1.22;
/** Fraction of the frame width a section pans across. */
const DRIFT_PAN = 0.03;
const DRIFT_TURN = 0.02;
/** `push` zooms in across a section, `pull` out. */
const PUSH_FROM = 1.04;
const PUSH_TO = 1.4;
/** `orbit` turns this far either side of level; the zoom keeps a 16:9 frame covered. */
const ORBIT_TURN = 0.15;
const ORBIT_SCALE = 1.3;
/** `shake`: a handheld wobble, in frame widths and radians. */
const SHAKE_SCALE = 1.12;
const SHAKE_PAN = 0.008;
const SHAKE_TURN = 0.012;
/** On a downbeat the frame starts this much tighter and slams out. */
const PUNCH = 0.4;
const PUNCH_DECAY = 0.16;
const KICK = 0.035;
const KICK_DECAY = 0.08;
/** Pan directions, one per section in turn. */
const HEADINGS: readonly [number, number][] = [[1, 0], [-0.7, 0.7], [0, -1], [0.7, 0.7], [-1, 0], [0.7, -0.7]];

export class MusicCamera {
    /** `kicks` are song seconds. */
    constructor(private readonly sections: readonly Section[], private readonly kicks: readonly number[]) {}

    at(t: number, style: CameraStyle = DEFAULT_CAMERA): View {
        const index = sectionIndex(this.sections, t);
        const section = this.sections[index];
        const p = smoothstep(clamp01((t - section.at) / (section.end - section.at)));
        // Alternate sections lean the other way.
        const side = index % 2 === 0 ? 1 : -1;
        const since = t - section.at;
        const punch = index === 0 ? 0 : style.punch * PUNCH * Math.exp(-since / PUNCH_DECAY);
        const view = move(style.move, index, side, p, t);
        view.scale += punch + style.kick * this.kick(t);
        view.rotate -= side * DRIFT_TURN * punch;
        return view;
    }

    /** The bump from the latest kick at or before `t`. */
    private kick(t: number): number {
        let lo = 0;
        let hi = this.kicks.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.kicks[mid] <= t) lo = mid + 1;
            else hi = mid;
        }
        return lo === 0 ? 0 : KICK * Math.exp(-(t - this.kicks[lo - 1]) / KICK_DECAY);
    }
}

/** The framing a move gives `p` (0..1, eased) of the way through section `index`, before punch and kicks. */
function move(kind: CameraMove, index: number, side: number, p: number, t: number): View {
    switch (kind) {
        case 'drift': {
            const [hx, hy] = HEADINGS[index % HEADINGS.length];
            const pan = (p - 0.5) * DRIFT_PAN;
            return {scale: DRIFT_FROM + (DRIFT_TO - DRIFT_FROM) * p, rotate: side * DRIFT_TURN * (p - 0.5), x: hx * pan, y: hy * pan};
        }
        case 'push':
            return {scale: PUSH_FROM + (PUSH_TO - PUSH_FROM) * p, rotate: 0, x: 0, y: 0};
        case 'pull':
            return {scale: PUSH_TO - (PUSH_TO - PUSH_FROM) * p, rotate: 0, x: 0, y: 0};
        case 'orbit':
            return {scale: ORBIT_SCALE, rotate: side * ORBIT_TURN * (2 * p - 1), x: 0, y: 0};
        case 'still':
            return {scale: 1, rotate: 0, x: 0, y: 0};
        case 'shake':
            // Incommensurate sines: smooth, never repeating, and a pure function of t.
            return {
                scale: SHAKE_SCALE,
                rotate: SHAKE_TURN * wobble(t, 0.9, 2.3),
                x: SHAKE_PAN * wobble(t, 1.3, 3.1),
                y: SHAKE_PAN * wobble(t, 1.1, 2.7),
            };
    }
}

/** Smooth noise in about -1..1 from two sines at `a` and `b` Hz. */
function wobble(t: number, a: number, b: number): number {
    return 0.65 * Math.sin(2 * Math.PI * a * t) + 0.35 * Math.sin(2 * Math.PI * b * t + 1.7);
}

const FLASH = 0.14;
const TYPE = 0.3;
const GLITCH = 0.4;
const HOLD = 1.3;
const FADE = 0.35;

/** On each section's downbeat: a flash, then `// LABEL` glitches and types in, holds, and fades. */
export class TitleCards implements VizLayer {
    /** `now` is the song time being drawn, in seconds — the same clock as the cuts and camera. */
    constructor(private readonly sections: readonly Section[], private readonly now: () => number) {}

    layout(): void {}

    update(): void {}

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const t = this.now();
        const index = sectionIndex(this.sections, t);
        const section = this.sections[index];
        const since = t - section.at;
        if (since > HOLD + FADE) return;
        const [nr, ng, nb] = s.theme.accentPool[0];

        if (since < FLASH) {
            ctx.fillStyle = `rgba(${nr}, ${ng}, ${nb}, ${0.45 * (1 - since / FLASH)})`;
            ctx.fillRect(0, 0, s.width, s.height);
        }

        const alpha = since < HOLD ? 1 : 1 - (since - HOLD) / FADE;
        const n = String(this.sections.length).padStart(2, '0');
        drawCard(ctx, s, {
            text: section.title ?? `// ${section.label.toUpperCase()}`, since, t, alpha, y: 0.5,
            kicker: `${String(index + 1).padStart(2, '0')} / ${n}`,
        });
    }
}

/** A card being drawn: its text `since` seconds after it began, at song time `t`. */
export interface Card {
    text: string;
    since: number;
    t: number;
    alpha: number;
    /** Its center, as a fraction of the frame height. */
    y: number;
    /** A small line above it (the title cards' `03 / 07`), or null. */
    kicker: string | null;
}

/**
 * Big glitching text straight on the visuals: an RGB split and torn slices as
 * it types in, then settled and glowing. A thin dark outline keeps it legible
 * over anything, with no band behind it.
 */
export function drawCard(ctx: CanvasRenderingContext2D, s: VizServices, {text, since, t, alpha, y, kicker}: Card): void {
    const {width: w, height: h} = s;
    const shown = text.slice(0, Math.ceil(text.length * clamp01(since / TYPE)));
    const settle = 1 + 0.25 * Math.exp(-since / 0.08);
    const cy = h * y;

    ctx.save();
    // A long card shrinks to fit the frame.
    ctx.font = `700 ${Math.round(h * 0.13)}px ${MONO_FONT}`;
    const size = Math.round(h * 0.13 * Math.min(1, (w * 0.88) / ctx.measureText(text).width));
    ctx.globalAlpha = alpha;

    ctx.translate(w / 2, cy);
    ctx.scale(settle, settle);
    ctx.font = `700 ${size}px ${MONO_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const left = -ctx.measureText(text).width / 2;
    ctx.textAlign = 'left';

    if (since < GLITCH) {
        // RGB split that closes as the glitch settles, jittering on a fixed per-frame hash.
        const spread = size * 0.12 * (1 - since / GLITCH);
        const jitter = (hash(Math.floor(t * 60)) - 0.5) * spread;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = s.theme.neonSecondary;
        ctx.fillText(shown, left - spread + jitter, 0);
        ctx.fillStyle = s.theme.neon;
        ctx.fillText(shown, left + spread - jitter, 0);
        ctx.globalCompositeOperation = 'source-over';
        // Slices torn sideways.
        for (let i = 0; i < 4; i++) {
            const band = hash(i * 7 + Math.floor(t * 30));
            const sliceY = (band - 0.5) * size;
            ctx.save();
            ctx.beginPath();
            ctx.rect(left - size, sliceY, w, size * 0.12);
            ctx.clip();
            ctx.fillStyle = s.theme.active;
            ctx.fillText(shown, left + (hash(i + band) - 0.5) * spread * 4, 0);
            ctx.restore();
        }
    }
    outline(ctx, s, shown, left, 0, size * 0.07);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = s.theme.neon;
    ctx.shadowBlur = size * 0.25;
    ctx.fillText(shown, left, 0);

    if (kicker) {
        ctx.shadowBlur = 0;
        const kickerSize = Math.round(size * 0.22);
        ctx.font = `500 ${kickerSize}px ${MONO_FONT}`;
        outline(ctx, s, kicker, left, -size * 0.72, kickerSize * 0.2);
        ctx.fillStyle = s.theme.neon;
        ctx.fillText(kicker, left, -size * 0.72);
    }
    ctx.restore();
}

/** A dark stroke under text about to be filled, in the theme's background. */
export function outline(ctx: CanvasRenderingContext2D, s: VizServices, text: string, x: number, y: number, width: number): void {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${s.theme.bgRgb.join(', ')}, 0.85)`;
    ctx.strokeText(text, x, y);
    ctx.restore();
}

function sectionIndex(sections: readonly Section[], t: number): number {
    let index = 0;
    for (let i = 0; i < sections.length; i++) if (sections[i].at <= t) index = i;
    return index;
}

function smoothstep(x: number): number {
    return x * x * (3 - 2 * x);
}

/** A stable value in [0, 1) for integer `n`. */
function hash(n: number): number {
    return rand01(hash32(0x7171e, n));
}
