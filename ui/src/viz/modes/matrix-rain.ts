/**
 * MATRIX RAIN — green glyph streams on a persistent phosphor layer, drum-
 * machine style: kicks burst streams in the left third of the columns, snares
 * center, hats right, and the bar downbeat throws a wide accented volley.
 * The layer is opaque and faded by painting translucent bg over it each frame
 * so trails converge to exactly the background color. Layer lives in device
 * pixels.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TransientDetector, beatEnv, rgbOf} from '../util.js';

/** Glyph pool — katakana + digits + latin, drawn per cell. */
const RAIN_GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEFGHJKLMNPQRSTUVWXYZ$+*:;.<>=';

interface RainStream {
    /** Column index. */
    col: number;
    /** Head position in fractional rows. */
    y: number;
    /** Rows per second. */
    speed: number;
    /** Rows left to live — stream dies after this distance or off-screen. */
    remaining: number;
    /** 1 on downbeat-accented streams: brighter head, brighter body. */
    accent: number;
}

class MatrixRainMode implements VizMode {
    private layer: HTMLCanvasElement | null = null;
    private layerCtx: CanvasRenderingContext2D | null = null;
    private streams: RainStream[] = [];
    private cellW = 0;
    private cellH = 0;
    private cols = 0;
    private rows = 0;
    private silence = 0;
    private lastBeatIndex = -1;
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    /** theme.bg as rgb components — the trail-fade fill and silence fill. */
    private bg: [number, number, number] = [5, 6, 10];

    layout(s: VizServices): void {
        if (s.width === 0 || s.height === 0) return;

        const cellH = Math.max(14, Math.min(22, s.height / 42));
        const cellW = cellH * 0.62;
        this.cellW = cellW;
        this.cellH = cellH;
        this.cols = Math.max(4, Math.floor(s.width / cellW));
        this.rows = Math.max(4, Math.ceil(s.height / cellH));
        this.streams.length = 0;

        const layer = document.createElement('canvas');
        layer.width = Math.max(1, Math.ceil(s.width * s.dpr));
        layer.height = Math.max(1, Math.ceil(s.height * s.dpr));
        this.layer = layer;
        const ctx = layer.getContext('2d', {alpha: false})!;
        // Device-pixel space; font state persists across frames.
        ctx.font = `${(cellH * 0.9 * s.dpr).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        this.layerCtx = ctx;

        this.bg = rgbOf(s.theme.bg, [5, 6, 10]);
        ctx.fillStyle = `rgb(${this.bg[0]}, ${this.bg[1]}, ${this.bg[2]})`;
        ctx.fillRect(0, 0, layer.width, layer.height);
    }

    update(dt: number, s: VizServices): void {
        if (!this.layerCtx) this.layout(s);
        const rctx = this.layerCtx;
        if (!rctx || !this.layer) return;

        const {low, mid, high} = s;
        const totalEnergy = low + mid + high;
        const isActive = totalEnergy > 0.12;

        const [br, bg, bb] = this.bg;
        if (!isActive) {
            this.silence += dt;
            this.streams.length = 0;
            this.lastBeatIndex = -1;
            if (this.silence > 1.5) {
                rctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
                rctx.fillRect(0, 0, this.layer.width, this.layer.height);
                return;
            }
            const fadeOut = 1 - Math.exp(-dt * 4);
            rctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${fadeOut.toFixed(4)})`;
            rctx.fillRect(0, 0, this.layer.width, this.layer.height);
            return;
        }
        this.silence = 0;

        // Trail fade — slower than the transient cooldowns so tails stretch
        // several rows behind the head.
        const fade = 1 - Math.exp(-dt * 2.0);
        rctx.fillStyle = `rgba(${br}, ${bg}, ${bb}, ${fade.toFixed(4)})`;
        rctx.fillRect(0, 0, this.layer.width, this.layer.height);

        // ---- Spawning — every stream is a musical event ----
        const spawn = (x0: number, x1: number, speedMul: number, len: number, accent: number): void => {
            this.streams.push({
                col: Math.min(this.cols - 1, Math.floor((x0 + Math.random() * (x1 - x0)) * this.cols)),
                y: -1,
                speed: (9 + Math.random() * 6) * speedMul,
                remaining: len + Math.random() * 8,
                accent,
            });
        };

        // Lengths scale with the grid so streams actually traverse the screen
        // instead of dying halfway and leaving the bottom permanently dark.
        const R = this.rows;
        const downbeatIndex = Math.floor(s.cycle);
        if (downbeatIndex !== this.lastBeatIndex) {
            this.lastBeatIndex = downbeatIndex;
            for (let i = 0; i < 5; i++) {
                spawn(0.02 + i * 0.19, 0.02 + i * 0.19 + 0.15, 1.4, R * 0.9, 1);
            }
        }

        // Per-band transient lanes.
        const hits = this.transients.update(dt, low, mid, high);
        if (hits.kick) {
            spawn(0.0, 0.33, 1.6, R * 1.1, 1);
            spawn(0.0, 0.33, 1.4, R * 0.9, 0);
            spawn(0.0, 0.33, 1.2, R * 0.7, 0);
        }
        if (hits.snare) {
            spawn(0.33, 0.66, 1.3, R * 0.6, 0);
            spawn(0.33, 0.66, 1.2, R * 0.5, 0);
        }
        if (hits.hat) {
            spawn(0.66, 1.0, 1.9, R * 0.4, 0);
        }

        const MAX_STREAMS = 120;
        if (this.streams.length > MAX_STREAMS) {
            this.streams.splice(0, this.streams.length - MAX_STREAMS);
        }

        // ---- Advance streams, stamping glyphs into crossed cells ----
        // The whole field surges on every quarter note and crawls between
        // them — the tempo lock is the loudest visual cue that the rain is
        // listening. Head brightness pumps with the same envelope.
        const beat = beatEnv(s.cycle * 4);
        const tempo = 0.45 + beat * 1.1 + totalEnergy * 0.35;
        const cellWDev = this.cellW * s.dpr;
        const cellHDev = this.cellH * s.dpr;
        for (let i = this.streams.length - 1; i >= 0; i--) {
            const stream = this.streams[i];
            const prevRow = Math.floor(stream.y);
            const advance = stream.speed * tempo * dt;
            stream.y += advance;
            stream.remaining -= advance;
            const headRow = Math.floor(stream.y);
            const x = (stream.col + 0.5) * cellWDev;

            // Body glyphs — one stamp per newly-entered cell, matrix green.
            rctx.fillStyle = stream.accent
                ? 'hsla(125, 90%, 62%, 0.55)'
                : 'hsla(125, 85%, 50%, 0.45)';
            for (let r = prevRow + 1; r <= headRow; r++) {
                if (r < 0 || r >= this.rows) continue;
                rctx.fillText(
                    RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)],
                    x, (r + 0.55) * cellHDev);
            }

            // Bright head — restamped every frame, flashing with the beat.
            if (headRow >= 0 && headRow < this.rows) {
                rctx.fillStyle = stream.accent
                    ? `hsla(120, 95%, 88%, ${(0.55 + beat * 0.4).toFixed(3)})`
                    : `hsla(122, 90%, 75%, ${(0.4 + beat * 0.4).toFixed(3)})`;
                rctx.fillText(
                    RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)],
                    x, (headRow + 0.55) * cellHDev);
            }

            if (stream.remaining <= 0 || headRow > this.rows) {
                this.streams.splice(i, 1);
            }
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.layer) ctx.drawImage(this.layer, 0, 0, s.width, s.height);
    }
}

export const matrixRainDef: VizModeDef = {
    id: 'matrix-rain',
    name: 'MATRIX RAIN',
    create: () => new MatrixRainMode(),
};
