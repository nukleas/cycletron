/** Two- and four-frame skeleton cycles, plus the figure in a window. */

import {clamp01} from '../../util.js';
import {drawSprite} from './pixel.js';
import {SKEL_OUT, SKEL_STEP, SKEL_UP, WIN_A, WIN_B, type Sprite} from './sprites.js';

const DANCE: readonly {sprite: Sprite; flip: boolean}[] = [
    {sprite: SKEL_UP, flip: false},
    {sprite: SKEL_OUT, flip: false},
    {sprite: SKEL_STEP, flip: false},
    {sprite: SKEL_STEP, flip: true},
];

const CYCLES: readonly (readonly number[])[] = [
    [0, 1, 0, 1],
    [0, 1, 2, 3],
    [2, 3, 2, 3],
    [1, 3, 0, 2],
];

/** Frame 0..3. `style` 0..3 picks the cycle; two beats cover it. */
export function danceFrame(beat: number, style: number): number {
    return CYCLES[style & 3][Math.floor(beat * 2) & 3];
}

/** Feet on `groundY`. `rise` 0..1 climbs the sprite out of the ground. */
export function drawDancer(
    ctx: CanvasRenderingContext2D, x: number, groundY: number, frame: number, rise: number,
    bone: string, eye: string, outline: string,
): void {
    const spec = DANCE[frame & 3];
    const shown = Math.round(clamp01(rise) * spec.sprite.h);
    if (shown <= 0) return;
    drawSprite(ctx, spec.sprite, Math.round(x - spec.sprite.w / 2), groundY - shown, [null, bone, eye], {
        flip: spec.flip,
        clipBottom: groundY,
        outline,
    });
}

/** Dark figure clipped to a window. Two frames, keyed by the caller. */
export function drawWindowDancer(
    ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frame: number, color: string,
): void {
    const s = (frame & 1) === 0 ? WIN_A : WIN_B;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    drawSprite(ctx, s, Math.round(x + (w - s.w) / 2), Math.round(y + h - s.h - 1), [null, color]);
    ctx.restore();
}
