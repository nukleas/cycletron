/** Tactical instruments: quiet plates, fine reticle brackets and track-colored signals. */
import {MONO_FONT} from '../../util.js';
import {hudHeader, hudPanel, hudText, INK, MUTED, EDGE, type DriveHudLayout} from '../drive-hud.js';
import type {Camera} from './scene.js';

export const HUD_ACCENT = '#80d9df';
export const RADAR_BUILDING = '#408080';
const READY_GREEN = '#80d9df';
const WHITE = INK;

/** Visible half-width of the heading tape, degrees. */
const TAPE_DEGREES = 22;

export type HudLayout = DriveHudLayout;

export interface ScoreRow {
    name: string;
    css: string;
    kills: number;
    fade: number;
}

/** One console line: runs of text, each in its own color. */
export type ConsoleLine = Array<[string, string]>;

export interface RadarItem {
    kind: 'tank' | 'flag' | 'box' | 'pyramid' | 'shot';
    x: number;
    z: number;
    /** Footprint half-width (x) and length (z) for buildings. */
    hw: number;
    len: number;
    css: string;
    alpha: number;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, css: string, px: number,
    align: CanvasTextAlign = 'left', weight = ''): void {
    ctx.fillStyle = css;
    ctx.font = `${weight}${weight ? ' ' : ''}${Math.round(px)}px ${MONO_FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
}

/** Half-sizes of the outer and dead-zone squares, as BZFlag computes them. */
export function reticleSize(L: HudLayout): {outer: number; inner: number} {
    const scale = Math.min(L.vw / 256, L.vh / 192) * 0.82;
    return {outer: 37 * scale, inner: 5 * scale};
}

/**
 * Reticle brackets, heading tape on the top edge, altitude tape and shot
 * meters on the right. `marker` is the next target's bearing relative to the
 * heading, in degrees, drawn as a diamond (or an end triangle off the tape).
 */
export function drawReticle(ctx: CanvasRenderingContext2D, L: HudLayout, cx: number, cy: number,
    heading: number, marker: {deg: number; css: string} | null, meters: Float32Array, color = HUD_ACCENT): void {
    const {outer, inner} = reticleSize(L);
    const px = Math.max(10, 14 * L.sc);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const x = cx + sx * outer, y = cy + sy * outer;
        ctx.moveTo(x - sx * outer * 0.2, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * outer * 0.2);
    }
    ctx.stroke();
    ctx.strokeRect(Math.round(cx - inner) + 0.5, Math.round(cy - inner) + 0.5, Math.round(inner * 2), Math.round(inner * 2));

    // Heading tape: clipped to the square's width, labels every 10°.
    const top = cy - outer;
    const perDeg = outer / TAPE_DEGREES;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - outer - px * 2, top - px * 3, outer * 2 + px * 4, px * 3);
    ctx.clip();
    ctx.beginPath();
    const first = Math.ceil((heading - TAPE_DEGREES - 2) / 5) * 5;
    for (let d = first; d <= heading + TAPE_DEGREES + 2; d += 5) {
        const x = Math.round(cx + (d - heading) * perDeg) + 0.5;
        if (x < cx - outer - 0.5 || x > cx + outer + 0.5) continue;
        const major = ((d % 10) + 10) % 10 === 0;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top - (major ? 6 : 3) * L.sc);
        if (major) text(ctx, String(((d % 360) + 360) % 360), x, top - px * 1.5, color, px, 'center');
    }
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, top);
    ctx.lineTo(cx + 0.5, top + 5 * L.sc);
    ctx.stroke();

    if (marker) {
        const r = 4 * L.sc;
        const off = marker.deg * perDeg;
        ctx.fillStyle = marker.css;
        ctx.beginPath();
        if (Math.abs(off) <= outer) {
            const x = cx + off, y = top - 3 * L.sc;
            ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
        } else {
            const side = Math.sign(off);
            const x = cx + side * outer, y = top - 3 * L.sc;
            ctx.moveTo(x + side * r * 1.5, y); ctx.lineTo(x, y - r); ctx.lineTo(x, y + r);
        }
        ctx.closePath();
        ctx.fill();
    }

    // Altitude tape, reading the ground: 0 at the centre, labels every 5.
    const right = cx + outer;
    const perUnit = outer / 27;
    ctx.beginPath();
    for (let a = 0; a <= 25; a += 5) {
        const y = Math.round(cy - a * perUnit) + 0.5;
        ctx.moveTo(right, y);
        ctx.lineTo(right + 5 * L.sc, y);
        text(ctx, String(a), right + 8 * L.sc, y, color, px * 0.9);
    }
    ctx.stroke();

    // Shot meters: one bar per shot; full = ready, otherwise reloading.
    const mw = Math.max(8, L.vw / 50), mh = Math.max(3, L.vh / 80);
    const mx = right + 8 * L.sc + px * 2.4;
    for (let i = 0; i < meters.length; i++) {
        const y = cy - (meters.length / 2 - i) * (mh + 3);
        const v = meters[i];
        ctx.globalAlpha = 0.5;
        if (v >= 1) {
            ctx.fillStyle = WHITE;
            ctx.fillRect(mx, y, mw, mh);
        } else {
            ctx.fillStyle = READY_GREEN;
            ctx.fillRect(mx, y, mw * v, mh);
            ctx.fillStyle = EDGE;
            ctx.fillRect(mx + mw * v, y, mw * (1 - v), mh);
        }
    }
    ctx.restore();
}

/** Callsign and score top-left, status top-centre, clock and flag top-right. */
export function drawStatusLine(ctx: CanvasRenderingContext2D, L: HudLayout, s: {
    callsign: string; kills: number; playerCss: string; ready: boolean; clock: string; flag: string; flagAlpha: number;
}): void {
    hudHeader(ctx, L, 'TANK FIELD', 'PATTERN INTERCEPT / 02 CYCLES', s.ready ? 'SYNC / LIVE' : 'SYNC / IDLE');
    const m = Math.max(16, 28 * L.sc);
    const px = Math.max(10, 13 * L.sc);
    hudText(ctx, `HITS / ${String(s.kills).padStart(3, '0')}`, m, 66, px, MUTED);
    hudText(ctx, `CYCLE / ${s.clock}`, L.vw - m, 66, px, INK, 'right');
    if (s.flagAlpha > 0.01 && s.flag && L.vh >= 420) {
        ctx.save(); ctx.globalAlpha = s.flagAlpha;
        hudText(ctx, s.flag.toUpperCase(), L.vw - m, 88, px, s.playerCss, 'right');
        ctx.restore();
    }
}

/** Track labels and hit counts in a compact instrument plate. */
export function drawScoreboard(ctx: CanvasRenderingContext2D, L: HudLayout, rows: readonly ScoreRow[], top: number): void {
    const px = Math.max(10, 13 * L.sc);
    const x = Math.max(16, 28 * L.sc), w = Math.max(180, 260 * L.sc);
    const rowH = Math.max(21, 28 * L.sc);
    hudPanel(ctx, x, top, w, 34 + rows.length * rowH, L.theme.neon);
    hudText(ctx, 'SIGNAL BANK', x + 12, top + 16, px - 1);
    hudText(ctx, 'HITS', x + w - 12, top + 16, px - 1, MUTED, 'right');
    rows.forEach((r, i) => {
        const y = top + 38 + i * rowH;
        ctx.globalAlpha = r.fade;
        ctx.fillStyle = r.css; ctx.fillRect(x + 12, y - 4, 2, 8);
        hudText(ctx, r.name.slice(0, 15).toUpperCase(), x + 24, y, px, INK);
        hudText(ctx, String(r.kills).padStart(2, '0'), x + w - 12, y, px, r.css, 'right');
    });
    ctx.globalAlpha = 1;
}

/**
 * Top-down radar, forward up. `range` world units fill half the square.
 * Items are positioned through the camera transform, so the radar turns with
 * the view and the north marker orbits the edge.
 */
export function drawRadar(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, cam: Camera,
    items: readonly RadarItem[], range: number, halfFov: number, heading: number, playerCss: string): void {
    const cx = x + side / 2, cy = y + side / 2;
    const k = side / 2 / range;
    ctx.save();
    hudPanel(ctx, x, y, side, side, playerCss);
    ctx.beginPath();
    ctx.rect(x, y, side, side);
    ctx.clip();

    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    for (const r of [0.2, 0.4]) {
        ctx.beginPath(); ctx.arc(cx, cy, side * r, 0, Math.PI * 2); ctx.stroke();
    }
    // View cone: a V from the tank out to the far edges of the field of view.
    ctx.strokeStyle = playerCss;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const reach = side;
    ctx.moveTo(cx - Math.tan(halfFov) * reach, cy - reach);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + Math.tan(halfFov) * reach, cy - reach);
    ctx.stroke();

    const at = (wx: number, wz: number): [number, number] => {
        cam.toCamera(wx, 0, wz);
        return [cx + cam.rx * k, cy - cam.rz * k];
    };
    for (const it of items) {
        ctx.globalAlpha = it.alpha;
        if (it.kind === 'box' || it.kind === 'pyramid') {
            ctx.strokeStyle = it.css;
            ctx.beginPath();
            const c = [at(it.x - it.hw, it.z), at(it.x + it.hw, it.z), at(it.x + it.hw, it.z + it.len), at(it.x - it.hw, it.z + it.len)];
            ctx.moveTo(c[0][0], c[0][1]);
            for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1]);
            ctx.closePath();
            ctx.stroke();
        } else {
            const [px, py] = at(it.x, it.z);
            ctx.fillStyle = it.css;
            ctx.strokeStyle = it.css;
            if (it.kind === 'tank') {
                const r = Math.max(2.5, 3.5 * k);
                ctx.fillRect(px - r, py - r, r * 2, r * 2);
                ctx.beginPath();
                ctx.moveTo(px, py - r * 2); ctx.lineTo(px + r * 2, py); ctx.lineTo(px, py + r * 2); ctx.lineTo(px - r * 2, py);
                ctx.closePath();
                ctx.stroke();
            } else if (it.kind === 'flag') {
                ctx.beginPath();
                ctx.moveTo(px - 3, py); ctx.lineTo(px + 3, py);
                ctx.moveTo(px, py - 3); ctx.lineTo(px, py + 3);
                ctx.stroke();
            } else {
                ctx.fillRect(px - 1, py - 1, 2, 2);
            }
        }
    }
    ctx.globalAlpha = 1;

    // North: world bearing 0, with travel at `heading` degrees.
    const n = -heading * Math.PI / 180;
    const nr = side * 0.45;
    const nx = cx + Math.sin(n) * nr, ny = cy - Math.cos(n) * nr;
    ctx.strokeStyle = WHITE;
    ctx.beginPath();
    ctx.moveTo(nx - 3, ny + 4); ctx.lineTo(nx - 3, ny - 4); ctx.lineTo(nx + 3, ny + 4); ctx.lineTo(nx + 3, ny - 4);
    ctx.stroke();
    // Forward tick at the top centre, then the player's own square.
    ctx.beginPath();
    ctx.moveTo(cx, y); ctx.lineTo(cx, y + 6);
    ctx.stroke();
    ctx.fillStyle = playerCss;
    ctx.fillRect(cx - 3, cy - 3, 6, 6);
    ctx.restore();

    hudText(ctx, 'SCAN / 02', x + 10, y + 14, 9, MUTED);
}

/** Compact event history; deliberately kept off the central chase view. */
export function drawConsole(ctx: CanvasRenderingContext2D, L: HudLayout, x: number, y: number, w: number, h: number,
    lines: readonly ConsoleLine[], playerCss: string): void {
    const px = Math.max(10, 13 * L.sc);
    ctx.save();
    hudPanel(ctx, x, y, w, h, playerCss);
    hudText(ctx, 'EVENT LOG', x + 12, y + 16, px - 1);
    ctx.beginPath(); ctx.rect(x + 12, y + 30, w - 24, h - 36); ctx.clip();
    const lineH = Math.max(18, 24 * L.sc);
    const room = Math.max(0, Math.min(4, Math.floor((h - 36) / lineH)));
    const shown = lines.slice(lines.length - room);
    shown.forEach((line, i) => {
        let lx = x + 12;
        ctx.globalAlpha = 0.4 + 0.6 * (i + 1) / shown.length;
        for (const [value, css] of line) {
            hudText(ctx, value, lx, y + 39 + i * lineH, px, css === '#ffffff' ? MUTED : css);
            lx += ctx.measureText(value).width;
        }
    });
    ctx.restore();
}
