/**
 * Transitions into a shot, painted over the visuals (under the code and title
 * cards) from the transition's progress alone, so a live show and an offline
 * render cut the same way. A `fade` dissolves from the outgoing shot's last
 * frame, which {@link Transitions} keeps while a show uses fades.
 */

import type {VizServices} from './types.js';
import {hash32, rand01} from './util.js';

export const TRANSITION_KINDS = ['cut', 'flash', 'fade', 'black', 'glitch'] as const;
export type TransitionKind = typeof TRANSITION_KINDS[number];

/** How a shot is entered, over how many bars. */
export interface Transition {
    kind: TransitionKind;
    bars: number;
}

/** Bars each kind takes when the show doesn't say. */
export const TRANSITION_BARS: Record<TransitionKind, number> = {cut: 0, flash: 0.25, fade: 1, black: 0.5, glitch: 0.25};

/** A transition under way: `p` runs 0 → 1 across it. */
export interface Entering {
    kind: Exclude<TransitionKind, 'cut'>;
    p: number;
    /** Seconds since the shot began. */
    since: number;
}

const GLITCH_BANDS = 9;

export class Transitions {
    /** The visuals of the last frame painted outside a fade: what the next fade dissolves from. */
    private kept: HTMLCanvasElement | null = null;

    /**
     * Paint `entering` over the visuals just drawn. With `keep`, the frame is
     * kept to fade from (only while no fade is under way, so a fade's source
     * stays the outgoing shot).
     */
    apply(ctx: CanvasRenderingContext2D, s: VizServices, entering: Entering | null, keep: boolean): void {
        const {width: w, height: h} = ctx.canvas;
        if (entering?.kind === 'fade' && this.kept) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1 - smooth(entering.p);
            ctx.drawImage(this.kept, 0, 0, w, h);
            ctx.restore();
        } else if (keep) {
            this.keep(ctx.canvas);
        }
        if (!entering) return;
        const p = entering.p;
        switch (entering.kind) {
            case 'flash': {
                ctx.save();
                ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * (1 - p) ** 2})`;
                ctx.fillRect(0, 0, s.width, s.height);
                ctx.restore();
                break;
            }
            case 'black': {
                ctx.save();
                ctx.fillStyle = `rgba(${s.theme.bgRgb.join(', ')}, ${1 - smooth(p)})`;
                ctx.fillRect(0, 0, s.width, s.height);
                ctx.restore();
                break;
            }
            case 'glitch':
                glitch(ctx, entering, w, h);
                break;
            case 'fade':
                // A fade with nothing kept yet (the first frame of a show) is a plain cut.
                break;
        }
    }

    private keep(source: HTMLCanvasElement): void {
        let kept = this.kept;
        if (!kept) {
            kept = document.createElement('canvas');
            this.kept = kept;
        }
        if (kept.width !== source.width || kept.height !== source.height) {
            kept.width = source.width;
            kept.height = source.height;
        }
        const k = kept.getContext('2d', {willReadFrequently: true})!;
        k.drawImage(source, 0, 0);
    }
}

/** Bands of the frame torn sideways, tinted, settling as `p` runs out; jitter steps at 30 Hz. */
function glitch(ctx: CanvasRenderingContext2D, {p, since}: Entering, w: number, h: number): void {
    const strength = 1 - p;
    const step = Math.floor(since * 30);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < GLITCH_BANDS; i++) {
        const y = Math.floor(rand(step, i, 0) * h);
        const bh = Math.max(2, Math.floor(rand(step, i, 1) * h * 0.08));
        const dx = Math.round((rand(step, i, 2) - 0.5) * w * 0.15 * strength);
        ctx.drawImage(ctx.canvas, 0, y, w, bh, dx, y, w, bh);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255, 0, 80, ${0.12 * strength})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

function rand(step: number, band: number, salt: number): number {
    return rand01(hash32(0x6c17c4, step * 97 + band * 7 + salt));
}

function smooth(x: number): number {
    return x * x * (3 - 2 * x);
}
