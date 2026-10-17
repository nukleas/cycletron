/** Shared instrument surfaces for the two chase-camera modes. */
import type {Theme} from '../types.js';
import {MONO_FONT} from '../util.js';

export interface DriveHudLayout {
    vw: number;
    vh: number;
    sc: number;
    theme: Theme;
}

export const INK = '#d7e9ed';
export const MUTED = '#7899aa';
export const EDGE = '#2a4352';
export const SURFACE = 'rgba(8, 17, 26, 0.86)';

export function hudText(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size = 11,
    color = MUTED, align: CanvasTextAlign = 'left'): void {
    ctx.font = `500 ${Math.round(size)}px ${MONO_FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
}

/** A chamfered plate with one accent tick, like the cockpit instruments. */
export function hudPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
    accent = EDGE): void {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + 6, y + 0.5); ctx.lineTo(x + w - 0.5, y + 0.5);
    ctx.lineTo(x + w - 0.5, y + h - 6); ctx.lineTo(x + w - 6, y + h - 0.5);
    ctx.lineTo(x + 0.5, y + h - 0.5); ctx.lineTo(x + 0.5, y + 6); ctx.closePath();
    ctx.fillStyle = SURFACE; ctx.fill();
    ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.beginPath(); ctx.moveTo(x + 12, y + 0.5); ctx.lineTo(x + 32, y + 0.5); ctx.stroke();
    ctx.restore();
}

export function hudHeader(ctx: CanvasRenderingContext2D, L: DriveHudLayout, name: string, detail: string, status: string): void {
    const m = Math.max(16, 28 * L.sc);
    const px = Math.max(10, 13 * L.sc);
    const g = ctx.createLinearGradient(0, 0, 0, 74);
    g.addColorStop(0, 'rgba(5, 10, 17, 0.95)'); g.addColorStop(1, 'rgba(5, 10, 17, 0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, L.vw, 74);
    hudText(ctx, name, m, 26, px, INK);
    if (L.vw >= 760) hudText(ctx, detail, L.vw / 2, 26, px - 1, MUTED, 'center');
    hudText(ctx, status, L.vw - m, 26, px, L.theme.neon, 'right');
    ctx.strokeStyle = EDGE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m, 46.5); ctx.lineTo(L.vw - m, 46.5); ctx.stroke();
}
