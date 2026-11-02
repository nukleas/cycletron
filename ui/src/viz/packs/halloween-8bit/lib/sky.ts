/**
 * Night sky, staircase bolts, and bats. Bolts and bats are spawned in
 * update(); drawing them is a pure read of that state plus `cycle`.
 */

import {hash32, rand01, SeededRandom, TAU} from '../../../sdk.js';
import {drawSprite, PH, PW, type Pix} from './pixel.js';
import {BATS, GHOSTS, MOON, TREE} from './sprites.js';

export interface Bolt {
    age: number;
    life: number;
    paths: Float32Array[];
}

/** Jagged bolt from (x, y0) to y1, built in update(). */
export function makeBolt(seed: number, x: number, y0: number, y1: number, forks: number, life: number): Bolt {
    const rnd = new SeededRandom(seed);
    const segs = 8;
    const main = new Float32Array((segs + 1) * 2);
    const dy = (y1 - y0) / segs;
    let px = x;
    for (let i = 0; i <= segs; i++) {
        main[i * 2] = Math.round(px);
        main[i * 2 + 1] = Math.round(y0 + dy * i);
        px += rnd.range(-12, 12);
    }
    const paths = [main];
    for (let f = 0; f < forks; f++) {
        const at = 2 + Math.floor(rnd.next() * (segs - 3));
        const n = 4;
        const fork = new Float32Array((n + 1) * 2);
        let fx = main[at * 2];
        let fy = main[at * 2 + 1];
        const side = rnd.next() < 0.5 ? -1 : 1;
        for (let i = 0; i <= n; i++) {
            fork[i * 2] = Math.round(fx);
            fork[i * 2 + 1] = Math.round(fy);
            fx += side * rnd.range(4, 10);
            fy += rnd.range(4, 9);
        }
        paths.push(fork);
    }
    return {age: 0, life, paths};
}

export function drawBolt(ctx: CanvasRenderingContext2D, bolt: Bolt, css: string): void {
    const k = 1 - bolt.age / bolt.life;
    if (k <= 0.15) return;
    ctx.fillStyle = css;
    for (const p of bolt.paths) {
        for (let i = 2; i < p.length; i += 2) stair(ctx, p[i - 2], p[i - 1], p[i], p[i + 1]);
    }
}

export function boltFlash(bolts: readonly Bolt[]): number {
    let f = 0;
    for (const b of bolts) {
        const k = 1 - b.age / b.life;
        if (k > f) f = k;
    }
    return f;
}

export function ageBolts(bolts: Bolt[], dt: number): void {
    for (let i = bolts.length - 1; i >= 0; i--) {
        bolts[i].age += dt;
        if (bolts[i].age >= bolts[i].life) bolts.splice(i, 1);
    }
}

export interface Bat {
    age: number;
    life: number;
    x0: number;
    y0: number;
    dir: number;
    speed: number;
    phase: number;
}

/** A bat crossing the 320-wide sky. */
export function makeBat(seed: number): Bat {
    const r = (n: number) => rand01(hash32(seed, n));
    const dir = (seed & 1) === 0 ? 1 : -1;
    const speed = 90 + r(2) * 50;
    return {
        age: 0,
        life: (PW + 36) / speed,
        x0: dir > 0 ? -14 : PW + 4,
        y0: 16 + r(1) * 48,
        dir,
        speed,
        phase: r(3) * TAU,
    };
}

export function drawBats(ctx: CanvasRenderingContext2D, bats: readonly Bat[], css: string): void {
    for (const b of bats) {
        const x = Math.round(b.x0 + b.dir * b.speed * b.age);
        const y = Math.round(b.y0 + Math.sin(b.age * 3 + b.phase) * 5);
        const frame = Math.floor(b.age * 12 + b.phase) & 1;
        drawSprite(ctx, BATS[frame], x, y, [null, css]);
    }
}

export function ageBats(bats: Bat[], dt: number): void {
    for (let i = bats.length - 1; i >= 0; i--) {
        bats[i].age += dt;
        if (bats[i].age >= bats[i].life) bats.splice(i, 1);
    }
}

/** Pac-Man ghost. Colour 1 body, 2 pupil, 3 eye. */
export function drawGhostAt(
    ctx: CanvasRenderingContext2D, x: number, y: number, frame: number,
    body: string, pupil: string, eye: string, outline?: string, scale = 1,
): void {
    drawSprite(ctx, GHOSTS[frame & 1], Math.round(x), Math.round(y), [null, body, pupil, eye], {scale, outline});
}

export function drawTree(ctx: CanvasRenderingContext2D, x: number, groundY: number, scale: number, color: string): void {
    drawSprite(ctx, TREE, x, groundY - TREE.h * scale, [null, color], {scale});
}

/** Sky, scrolling dither clouds, moon, and two ambient bats. */
export function drawNight(
    ctx: CanvasRenderingContext2D, pix: Pix, cycle: number, flash: number,
    moonX: number, moonY: number, bats = true,
): void {
    const hot = flash > 0.88;
    ctx.fillStyle = hot ? pix.ink.moon : pix.ink.skyDeep;
    ctx.fillRect(0, 0, PW, 44);
    ctx.fillStyle = hot ? pix.ink.moonDim : pix.ink.sky;
    ctx.fillRect(0, 44, PW, PH - 44);
    if (!hot) {
        ctx.fillStyle = pix.skyDither;
        ctx.fillRect(0, 32, PW, 18);
        drawStars(ctx, 80, cycle, pix.ink.moon);
        drawClouds(ctx, cycle, pix.skyDither);
    }
    drawSprite(ctx, MOON, moonX, moonY, [null, hot ? pix.ink.bone : pix.ink.moon, pix.ink.moonDim]);
    if (bats) drawAmbientBats(ctx, cycle, pix.ink.line);
}

function drawStars(ctx: CanvasRenderingContext2D, horizon: number, cycle: number, color: string): void {
    const epoch = Math.floor(cycle / 8);
    const tick = Math.floor(cycle * 2);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 42; i++) {
        if ((hash32(i * 7 + 3, tick) & 3) === 0) continue;
        const x = hash32(i * 7 + 1, epoch) % PW;
        const y = hash32(i * 7 + 2, epoch) % horizon;
        ctx.rect(x, y, 1, 1);
        if ((hash32(i * 7 + 4, epoch) & 7) === 0) {
            ctx.rect(x - 1, y, 1, 1);
            ctx.rect(x + 1, y, 1, 1);
            ctx.rect(x, y - 1, 1, 1);
            ctx.rect(x, y + 1, 1, 1);
        }
    }
    ctx.fill();
}

function drawClouds(ctx: CanvasRenderingContext2D, cycle: number, pattern: CanvasPattern): void {
    const span = PW + 48;
    const scroll = Math.floor(cycle * 6) % span;
    ctx.fillStyle = pattern;
    const blobs = [
        [12, 16, 28, 5],
        [84, 26, 18, 4],
        [156, 14, 34, 6],
        [236, 24, 22, 4],
        [308, 18, 24, 5],
    ];
    for (const [x, y, w, h] of blobs) {
        let px = x - scroll;
        if (px < -w) px += span;
        ctx.fillRect(px, y, w, h);
        if (w > 10) ctx.fillRect(px + 3, y - 2, w - 8, 3);
    }
}

/** Stepped hills on a horizon. Sizes come from the index, not from a clock. */
export function drawRidge(ctx: CanvasRenderingContext2D, base: number, color: string): void {
    ctx.fillStyle = color;
    for (let i = 0; i < 8; i++) {
        const w = 28 + (hash32(i, 4) % 14);
        const h = 8 + (hash32(i, 9) % 10);
        const x = i * 42 - 12;
        ctx.fillRect(x, base - (h >> 1), w, h >> 1);
        ctx.fillRect(x + 4, base - h, w - 8, h);
        ctx.fillRect(x + 10, base - h - 5, Math.max(6, w - 20), 6);
    }
}

function drawAmbientBats(ctx: CanvasRenderingContext2D, cycle: number, css: string): void {
    for (let i = 0; i < 2; i++) {
        const t = cycle * 0.35 + i * 1.7;
        const x = Math.round(PW * (0.12 + 0.76 * (0.5 + 0.5 * Math.sin(t))));
        const y = Math.round(22 + i * 12 + 5 * Math.sin(t * 2.2));
        const frame = Math.floor(cycle * 8 + i) & 1;
        drawSprite(ctx, BATS[frame], x, y, [null, css]);
    }
}

function stair(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    let x = x0 | 0;
    let y = y0 | 0;
    const tx = x1 | 0;
    const ty = y1 | 0;
    const sx = Math.sign(tx - x);
    const sy = Math.sign(ty - y);
    ctx.fillRect(x, y, 2, 1);
    let guard = 0;
    while ((x !== tx || y !== ty) && guard++ < 80) {
        for (let i = 0; i < 3 && x !== tx; i++) {
            x += sx;
            ctx.fillRect(x, y, 2, 1);
        }
        for (let i = 0; i < 3 && y !== ty; i++) {
            y += sy;
            ctx.fillRect(x, y, 2, 1);
        }
    }
}
