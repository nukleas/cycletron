/** Two- and four-frame skeleton cycles, plus the figure in a window. */

import {clamp01} from '../../util.js';
import {drawSprite} from './pixel.js';
import {SKEL_DOWN, SKEL_OUT, SKEL_STEP, SKEL_UP, WIN_A, WIN_B, type Sprite} from './sprites.js';

const DANCE: readonly {sprite: Sprite; hop: number}[] = [
    {sprite: SKEL_DOWN, hop: 0},
    {sprite: SKEL_UP, hop: 3},
    {sprite: SKEL_STEP, hop: 0},
    {sprite: SKEL_OUT, hop: 2},
];

const CYCLES: readonly (readonly number[])[] = [
    [0, 1, 2, 3],
    [1, 2, 3, 0],
    [2, 3, 0, 1],
    [3, 0, 1, 2],
];

/** Skull, then ribs, on the climbing pose. Legs fill the last stretch. */
const SKULL_ROWS = 6;
const RIB_ROWS = 11;

/** Frame 0..3. `style` 0..3 picks the cycle; two beats cover it. */
export function danceFrame(beat: number, style: number): number {
    return CYCLES[style & 3][Math.floor(beat * 2) & 3];
}

/** Feet on `groundY`. `rise` 0..1 climbs skull, then ribs, then legs. A full rise dances. */
export function drawDancer(
    ctx: CanvasRenderingContext2D, x: number, groundY: number, frame: number, rise: number,
    bone: string, eye: string, outline: string,
): void {
    const r = clamp01(rise);
    const posed = r >= 1;
    const spec = posed ? DANCE[frame & 3] : {sprite: SKEL_DOWN, hop: 0};
    const shown = posed ? spec.sprite.h : risenRows(r, spec.sprite.h);
    if (shown <= 0) return;
    drawSprite(ctx, spec.sprite, Math.round(x - spec.sprite.w / 2), groundY - shown - spec.hop, [null, bone, eye], {
        clipBottom: groundY,
        outline,
    });
}

function risenRows(rise: number, h: number): number {
    const skull = Math.min(SKULL_ROWS, h);
    const ribs = Math.min(RIB_ROWS, h);
    if (rise < 0.42) return Math.max(1, Math.round((rise / 0.42) * skull));
    if (rise < 0.72) return skull + Math.round(((rise - 0.42) / 0.3) * (ribs - skull));
    return Math.min(h, ribs + Math.round(((rise - 0.72) / 0.28) * (h - ribs)));
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
