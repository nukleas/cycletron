/**
 * Words on screen at set song times: each line types in, holds, and fades, at
 * the bottom (a lower third), the center, or the top — as a caption, or as a
 * big glitching card like a section's title. The next line of the same style
 * in the same place cuts the one before it, so a quick run of cards reads one
 * word at a time. A pure function of song time, like the title cards.
 */

import {drawCard, outline} from './edit.js';
import type {VizLayer, VizServices} from './types.js';
import {MONO_FONT, clamp01} from './util.js';

export interface CaptionLine {
    say: string;
    /** Song seconds it appears, and starts to fade. */
    at: number;
    until: number;
    place: 'bottom' | 'center' | 'top';
    style: 'line' | 'card';
}

/** Seconds to type a line in, and to fade it out. */
const TYPE = 0.45;
const FADE = 0.5;
/** Text height, against the frame's, by place. */
const SIZE = {bottom: 0.045, center: 0.075, top: 0.045};
const ROW = {bottom: 0.84, center: 0.5, top: 0.16};
/** A card is taller: its band sits further in. */
const CARD_ROW = {bottom: 0.76, center: 0.5, top: 0.24};
const CARD_FADE = 0.35;

export class Captions implements VizLayer {
    /** Song seconds each line is gone by: its fade's end, or the next line's start in its place. */
    private readonly gone: number[];

    /** `now` is the song time being drawn, in seconds. */
    constructor(private readonly lines: readonly CaptionLine[], private readonly now: () => number) {
        this.gone = lines.map((line) => {
            const end = line.until + (line.style === 'card' ? CARD_FADE : FADE);
            const next = lines
                .filter((other) => other.style === line.style && other.place === line.place && other.at > line.at)
                .reduce((at, other) => Math.min(at, other.at), Infinity);
            return Math.min(end, next);
        });
    }

    layout(): void {}

    update(): void {}

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const t = this.now();
        this.lines.forEach((line, i) => {
            const fade = line.style === 'card' ? CARD_FADE : FADE;
            if (t < line.at || t >= this.gone[i]) return;
            const alpha = t < line.until ? 1 : 1 - (t - line.until) / fade;
            if (line.style === 'card') {
                drawCard(ctx, s, {text: line.say, since: t - line.at, t, alpha, y: CARD_ROW[line.place], kicker: null});
            } else {
                this.draw(ctx, s, line, t - line.at, alpha);
            }
        });
    }

    private draw(ctx: CanvasRenderingContext2D, s: VizServices, line: CaptionLine, since: number, alpha: number): void {
        const {width: w, height: h} = s;
        const shown = line.say.slice(0, Math.ceil(line.say.length * clamp01(since / TYPE)));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `600 ${Math.round(h * SIZE[line.place])}px ${MONO_FONT}`;
        // Long lines shrink to fit.
        const full = ctx.measureText(line.say).width;
        const size = Math.round(h * SIZE[line.place] * Math.min(1, (w * 0.86) / full));
        ctx.font = `600 ${size}px ${MONO_FONT}`;
        ctx.textBaseline = 'middle';
        const width = ctx.measureText(line.say).width;
        const left = (w - width) / 2;
        const y = h * ROW[line.place];
        outline(ctx, s, shown, left, y, size * 0.18);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = s.theme.neon;
        ctx.shadowBlur = size * 0.35;
        ctx.fillText(shown, left, y);
        ctx.restore();
    }
}
