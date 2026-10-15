/**
 * Music-video edit for offline renders: a camera over the mode and section
 * title cards, both pure functions of song time and the song's structure
 * (sections and kick onsets from a performance export), so any frame renders
 * the same in any order.
 */

import type {VizLayer, VizServices} from './types.js';
import {MONO_FONT, clamp01, hash32, rand01} from './util.js';

export interface Section {
    label: string;
    /** Song seconds. */
    at: number;
    end: number;
}

/** How the mode is framed: zoom and turn about the frame center, then pan in px. */
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
/** On a downbeat the frame starts this much tighter and slams out. */
const PUNCH = 0.4;
const PUNCH_DECAY = 0.16;
const KICK = 0.035;
const KICK_DECAY = 0.08;
/** Pan directions, one per section in turn. */
const HEADINGS: readonly [number, number][] = [[1, 0], [-0.7, 0.7], [0, -1], [0.7, 0.7], [-1, 0], [0.7, -0.7]];

export class MusicCamera {
    /** `kicks` are song seconds. */
    constructor(private readonly sections: readonly Section[], private readonly kicks: readonly number[], private readonly width: number) {}

    at(t: number): View {
        const index = sectionIndex(this.sections, t);
        const section = this.sections[index];
        const p = smoothstep(clamp01((t - section.at) / (section.end - section.at)));
        const [hx, hy] = HEADINGS[index % HEADINGS.length];
        const turn = index % 2 === 0 ? DRIFT_TURN : -DRIFT_TURN;
        const since = t - section.at;
        const punch = index === 0 ? 0 : PUNCH * Math.exp(-since / PUNCH_DECAY);
        const pan = (p - 0.5) * DRIFT_PAN * this.width;
        return {
            scale: DRIFT_FROM + (DRIFT_TO - DRIFT_FROM) * p + punch + this.kick(t),
            rotate: turn * (p - 0.5) - turn * punch,
            x: hx * pan,
            y: hy * pan,
        };
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
        const since = t - this.sections[index].at;
        if (since > HOLD + FADE) return;
        const {width: w, height: h} = s;
        const [nr, ng, nb] = s.theme.accentPool[0];

        if (since < FLASH) {
            ctx.fillStyle = `rgba(${nr}, ${ng}, ${nb}, ${0.45 * (1 - since / FLASH)})`;
            ctx.fillRect(0, 0, w, h);
        }

        const alpha = since < HOLD ? 1 : 1 - (since - HOLD) / FADE;
        const text = `// ${this.sections[index].label.toUpperCase()}`;
        const shown = text.slice(0, Math.ceil(text.length * clamp01(since / TYPE)));
        const size = Math.round(h * 0.13);
        const settle = 1 + 0.25 * Math.exp(-since / 0.08);
        const cy = h * 0.5;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgba(${s.theme.bgRgb.join(', ')}, 0.6)`;
        ctx.fillRect(0, cy - size * 0.95, w, size * 1.9);

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
                const y = (band - 0.5) * size;
                ctx.save();
                ctx.beginPath();
                ctx.rect(left - size, y, w, size * 0.12);
                ctx.clip();
                ctx.fillStyle = s.theme.active;
                ctx.fillText(shown, left + (hash(i + band) - 0.5) * spread * 4, 0);
                ctx.restore();
            }
        }
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = s.theme.neon;
        ctx.shadowBlur = size * 0.25;
        ctx.fillText(shown, left, 0);

        ctx.shadowBlur = 0;
        ctx.font = `500 ${Math.round(size * 0.22)}px ${MONO_FONT}`;
        ctx.fillStyle = s.theme.neon;
        const n = String(this.sections.length).padStart(2, '0');
        ctx.fillText(`${String(index + 1).padStart(2, '0')} / ${n}`, left, -size * 0.72);
        ctx.restore();
    }
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
