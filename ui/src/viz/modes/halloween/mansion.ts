/** The NES mansion: one layout, drawn as flat rects and two roof triangles. */

import {frameRect, fillTri, HUD_Y, PW, type Pix} from './pixel.js';
import {drawRidge, drawTree} from './sky.js';
import {PUMP_A} from './sprites.js';

export interface Win {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Mansion {
    windows: Win[];
    groups: {bass: number[]; mid: number[]; lead: number[]; tower: number[]};
    door: Win;
    chimney: {x: number; y: number; w: number; h: number};
    vane: {x: number; y: number};
    pumpkins: {x: number; y: number}[];
    yard: number;
    horizon: number;
    main: Win;
    tower: Win;
    porch: Win;
    posts: readonly number[];
    gable: readonly [number, number, number, number, number, number];
    spire: readonly [number, number, number, number, number, number];
}

const YARD = 156;
const HORIZON = 118;

export const HOUSE: Mansion = build();

export function drawShell(ctx: CanvasRenderingContext2D, pix: Pix): void {
    const ink = pix.ink;
    const {main, tower, porch, door, chimney, posts, gable, spire, yard, horizon} = HOUSE;

    ctx.fillStyle = ink.hillDark;
    ctx.fillRect(0, horizon, PW, HUD_Y - horizon);
    ctx.fillStyle = pix.hillDither;
    ctx.fillRect(0, horizon - 6, PW, 8);
    ctx.fillStyle = ink.hill;
    ctx.fillRect(0, yard, PW, HUD_Y - yard);

    drawRidge(ctx, horizon, ink.sil);
    drawTree(ctx, 4, horizon + 6, 2, ink.line);
    drawTree(ctx, PW - 30, horizon + 6, 2, ink.line);
    drawTree(ctx, 36, horizon - 4, 1, ink.sil);
    drawTree(ctx, PW - 52, horizon - 4, 1, ink.sil);
    drawSideFence(ctx, horizon, ink.line);

    ctx.fillStyle = ink.wallDark;
    ctx.fillRect(tower.x, tower.y, tower.w, tower.h);
    bricks(ctx, tower, ink.wall, 2);
    frameRect(ctx, tower.x, tower.y, tower.w, tower.h, ink.line);

    ctx.fillStyle = ink.wall;
    ctx.fillRect(main.x, main.y, main.w, main.h);
    bricks(ctx, main, ink.wallDark, 0);
    frameRect(ctx, main.x, main.y, main.w, main.h, ink.line);

    fillTri(ctx, gable[0], gable[1], gable[2], gable[3], gable[4], gable[5], ink.roof, ink.roofAlt);
    fillTri(ctx, spire[0], spire[1], spire[2], spire[3], spire[4], spire[5], ink.roof, ink.roofAlt);
    ctx.fillStyle = ink.red;
    ctx.fillRect(gable[0], gable[1], gable[4] - gable[0], 2);

    ctx.fillStyle = ink.stoneDark;
    ctx.fillRect(chimney.x, chimney.y, chimney.w, chimney.h);
    bricks(ctx, chimney, ink.stone, 1);
    frameRect(ctx, chimney.x, chimney.y, chimney.w, chimney.h, ink.line);
    ctx.fillStyle = ink.line;
    ctx.fillRect(chimney.x + 2, chimney.y, chimney.w - 4, 4);

    ctx.fillStyle = ink.roof;
    ctx.fillRect(porch.x, porch.y, porch.w, porch.h);
    ctx.fillStyle = ink.roofAlt;
    ctx.fillRect(porch.x, porch.y, porch.w, 1);
    ctx.fillStyle = ink.wallDark;
    for (const x of posts) ctx.fillRect(x, porch.y + porch.h, 3, yard - (porch.y + porch.h));

    // A dark slot, so the swinging door has a hole to open onto.
    ctx.fillStyle = ink.line;
    ctx.fillRect(door.x, door.y, door.w, door.h);

    let stepW = door.w + 16;
    for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 === 0 ? ink.stone : ink.stoneDark;
        ctx.fillRect(Math.round(door.x + door.w / 2 - stepW / 2), yard + i * 3, stepW, 3);
        stepW += 16;
    }
}

function drawSideFence(ctx: CanvasRenderingContext2D, y: number, color: string): void {
    ctx.fillStyle = color;
    const runs: readonly [number, number][] = [[0, 76], [244, PW]];
    for (const [x0, x1] of runs) {
        ctx.fillRect(x0, y, x1 - x0, 2);
        ctx.fillRect(x0, y + 4, x1 - x0, 1);
        for (let x = x0 + 2; x < x1; x += 10) ctx.fillRect(x, y - 3, 2, 10);
    }
}

function bricks(ctx: CanvasRenderingContext2D, box: Win, color: string, shift: number): void {
    ctx.fillStyle = color;
    for (let y = box.y + 6 + shift; y < box.y + box.h - 2; y += 8) ctx.fillRect(box.x + 1, y, box.w - 2, 1);
}

function build(): Mansion {
    const windows: Win[] = [];
    const groups = {bass: [] as number[], mid: [] as number[], lead: [] as number[], tower: [] as number[]};
    const push = (group: number[], win: Win) => {
        group.push(windows.length);
        windows.push(win);
    };

    const main: Win = {x: 104, y: 78, w: 128, h: 78};
    const tower: Win = {x: 76, y: 50, w: 30, h: 106};
    const door: Win = {x: 156, y: 122, w: 20, h: 34};
    const porch: Win = {x: 96, y: 118, w: 148, h: 4};

    push(groups.bass, {x: 114, y: 130, w: 14, h: 16});
    push(groups.bass, {x: 134, y: 130, w: 14, h: 16});
    push(groups.bass, {x: 188, y: 130, w: 14, h: 16});
    push(groups.bass, {x: 208, y: 130, w: 14, h: 16});

    for (const x of [112, 136, 160, 184, 208]) push(groups.mid, {x, y: 96, w: 14, h: 16});
    for (const x of [118, 146, 186, 208]) push(groups.lead, {x, y: 80, w: 14, h: 14});
    push(groups.lead, {x: 150, y: 58, w: 12, h: 12});
    push(groups.lead, {x: 176, y: 58, w: 12, h: 12});

    for (const y of [134, 110, 86, 62]) push(groups.tower, {x: 85, y, w: 12, h: 14});

    const cx = door.x + door.w / 2;
    const pumpkins: {x: number; y: number}[] = [];
    for (let i = 0; i < 5; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const stepW = door.w + 16 + i * 16;
        pumpkins.push({
            x: Math.round(cx + side * (stepW / 2 - 4) - PUMP_A.w / 2),
            y: YARD + i * 3 - PUMP_A.h,
        });
    }

    return {
        windows,
        groups,
        door,
        chimney: {x: 198, y: 40, w: 12, h: 28},
        vane: {x: 91, y: 30},
        pumpkins,
        yard: YARD,
        horizon: HORIZON,
        main,
        tower,
        porch,
        posts: [100, 150, 182, 236],
        gable: [96, 78, 168, 46, 240, 78],
        spire: [70, 50, 91, 28, 112, 50],
        };
}
