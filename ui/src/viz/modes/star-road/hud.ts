/** Racing telemetry in Cycletron's instrument style. */
import {TAU} from '../../util.js';
import {hudHeader, hudPanel, hudText, INK, MUTED, EDGE, type DriveHudLayout} from '../drive-hud.js';
import {roadHeading, roadX} from './road.js';

const GOLD = '#efbd73';
export type HudLayout = DriveHudLayout;
export interface Racer { label: string; css: string; player: boolean; }

const margin = (L: HudLayout): number => Math.max(16, 28 * L.sc);
const compact = (L: HudLayout): boolean => L.vw < 480 || L.vh < 380;
const font = (L: HudLayout): number => Math.max(10, 13 * L.sc);

/** Compact, aligned rows leave the road's vanishing point clear. */
export function drawRacerStack(ctx: CanvasRenderingContext2D, L: HudLayout, racers: readonly Racer[]): void {
    const x = margin(L), y = 98, w = Math.max(130, 190 * L.sc);
    const rh = Math.max(21, 28 * L.sc);
    // Short panes show only the lead group, with the player always included.
    const room = Math.max(1, Math.min(racers.length, Math.floor((L.vh - 280) / rh)));
    const shown = racers.slice(0, room);
    const player = racers.find(r => r.player);
    if (player && !shown.includes(player)) shown[shown.length - 1] = player;
    hudPanel(ctx, x, y, w, 32 + rh * shown.length, L.theme.neon);
    hudText(ctx, 'RUNNING ORDER', x + 12, y + 16, font(L) - 1);
    shown.forEach((r, i) => {
        const ry = y + 38 + i * rh;
        if (r.player) { ctx.fillStyle = 'rgba(128, 217, 223, 0.06)'; ctx.fillRect(x + 5, ry - rh / 2, w - 10, rh); }
        hudText(ctx, String(racers.indexOf(r) + 1).padStart(2, '0'), x + 12, ry, font(L), r.player ? INK : MUTED);
        ctx.fillStyle = r.css; ctx.fillRect(x + 38, ry - 4, 2, 8);
        hudText(ctx, r.label, x + 50, ry, font(L), r.player ? INK : r.css);
    });
}

export function drawLapAndTime(ctx: CanvasRenderingContext2D, L: HudLayout, lap: number, laps: number, seconds: number,
    ready: boolean): void {
    hudHeader(ctx, L, 'STAR ROAD', 'SPECTRAL CIRCUIT / 08 BARS', ready ? 'SYNC / LIVE' : 'SYNC / IDLE');
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60), cs = Math.floor((seconds * 100) % 100);
    const clock = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    hudText(ctx, `LAP / ${String(lap).padStart(2, '0')} — ${String(laps).padStart(2, '0')}`, margin(L), 66, font(L), INK);
    hudText(ctx, clock, L.vw - margin(L), 66, font(L), INK, 'right');
}

export function drawPlace(ctx: CanvasRenderingContext2D, L: HudLayout, place: number): void {
    if (compact(L)) {
        const x = margin(L), y = L.vh - margin(L) - 64;
        hudPanel(ctx, x, y, L.vw - x * 2, 64, L.theme.neon);
        hudText(ctx, 'POSITION', x + 12, y + 15, 9);
        hudText(ctx, String(place).padStart(2, '0'), x + 12, y + 40, 28, INK);
        return;
    }
    const x = margin(L), y = L.vh - margin(L) - 94;
    hudPanel(ctx, x, y, 142, 94, L.theme.neon);
    hudText(ctx, 'POSITION', x + 12, y + 17, font(L) - 1);
    hudText(ctx, String(place).padStart(2, '0'), x + 12, y + 53, 36, INK);
    hudText(ctx, place === 1 ? 'LEAD' : 'CHASE', x + 74, y + 57, 10, L.theme.neon);
}

export function drawCoins(ctx: CanvasRenderingContext2D, L: HudLayout, coins: number, charge: number, chargeCss: string): void {
    if (compact(L)) {
        const x = L.vw - margin(L) - 130, y = L.vh - margin(L) - 64;
        hudText(ctx, 'COINS', x, y + 16, 9);
        hudText(ctx, String(coins).padStart(3, '0'), x + 118, y + 16, 11, GOLD, 'right');
        ctx.fillStyle = EDGE; ctx.fillRect(x, y + 39, 118, 3);
        ctx.fillStyle = chargeCss; ctx.fillRect(x, y + 39, 118 * Math.max(0, Math.min(1, charge)), 3);
        return;
    }
    const x = margin(L), y = L.vh - margin(L) - 94;
    hudPanel(ctx, x, y - 46, 142, 38);
    hudText(ctx, 'COINS', x + 12, y - 27, font(L) - 1);
    hudText(ctx, String(coins).padStart(3, '0'), x + 130, y - 27, font(L), GOLD, 'right');
    // Charge is drawn below the position value, after its plate has been painted.
    ctx.fillStyle = EDGE; ctx.fillRect(x + 12, y + 78, 118, 3);
    ctx.fillStyle = chargeCss; ctx.fillRect(x + 12, y + 78, 118 * Math.max(0, Math.min(1, charge)), 3);
}

/** Original item glyphs for the roulette: star, bolt, shield, arrow. */
function itemGlyph(ctx: CanvasRenderingContext2D, which: number, x: number, y: number, r: number): void {
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.beginPath();
    switch (which % 4) {
        case 0:
            for (let i = 0; i < 10; i++) {
                const a = -Math.PI / 2 + (i * Math.PI) / 5;
                const rr = i % 2 === 0 ? r : r * 0.42;
                if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
                else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
            }
            ctx.closePath();
            ctx.fillStyle = GOLD;
            break;
        case 1:
            ctx.moveTo(x + r * 0.2, y - r); ctx.lineTo(x - r * 0.45, y + r * 0.1); ctx.lineTo(x, y + r * 0.1);
            ctx.lineTo(x - r * 0.2, y + r); ctx.lineTo(x + r * 0.45, y - r * 0.1); ctx.lineTo(x, y - r * 0.1);
            ctx.closePath();
            ctx.fillStyle = '#7fd4ff';
            break;
        case 2:
            ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.8, y - r * 0.6); ctx.lineTo(x + r * 0.7, y + r * 0.3);
            ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.7, y + r * 0.3); ctx.lineTo(x - r * 0.8, y - r * 0.6);
            ctx.closePath();
            ctx.fillStyle = '#7dff6a';
            break;
        default:
            ctx.moveTo(x - r * 0.8, y + r * 0.35); ctx.lineTo(x, y - r * 0.6); ctx.lineTo(x + r * 0.8, y + r * 0.35);
            ctx.lineTo(x + r * 0.35, y + r * 0.35); ctx.lineTo(x + r * 0.35, y + r); ctx.lineTo(x - r * 0.35, y + r);
            ctx.lineTo(x - r * 0.35, y + r * 0.35);
            ctx.closePath();
            ctx.fillStyle = '#ff8ec8';
            break;
    }
    ctx.fill();
    ctx.stroke();
}

/** Roulette slot: restrained glass, with the same original item glyphs. */
export function drawItemSlot(ctx: CanvasRenderingContext2D, L: HudLayout, item: number, spin: number, time: number): void {
    if (L.vh < 300) return;
    const size = Math.max(40, 64 * L.sc);
    const x = L.vw / 2 - size / 2, y = L.vw < 480 ? 94 : 57;
    hudPanel(ctx, x, y, size, size, spin > 0 ? L.theme.neonSecondary : L.theme.neon);
    if (spin > 0 || item >= 0) itemGlyph(ctx, spin > 0 ? Math.floor(time * 14) : item, x + size / 2, y + size / 2, size * 0.25);
    else hudText(ctx, '—', x + size / 2, y + size / 2, 14, MUTED, 'center');
}

export function drawMinimap(ctx: CanvasRenderingContext2D, L: HudLayout, s: number, behind: number, ahead: number,
    racers: ReadonlyArray<{ds: number; lane: number; css: string}>, playerLane: number): void {
    if (compact(L)) return;
    const w = Math.max(110, 220 * L.sc), h = Math.max(100, 180 * L.sc);
    const x = L.vw - margin(L) - w, y = L.vh - margin(L) - h;
    hudPanel(ctx, x, y, w, h, L.theme.neon);
    const h0 = roadHeading(s);
    const c = Math.cos(h0), sn = Math.sin(h0);
    const x0 = roadX(s);
    const span = behind + ahead;
    const k = (h - 20) / span;
    const cx = x + w / 2;
    const base = y + h - 10 - behind * k;
    const at = (ds: number, lane: number): [number, number] => {
        const dx = roadX(s + ds) + lane - x0;
        // Rotate so the heading at the player points up.
        const rx = dx * c - ds * sn;
        const rz = dx * sn + ds * c;
        return [cx + rx * k, base - rz * k];
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = MUTED;
    ctx.lineWidth = Math.max(1, 1.5 * L.sc);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let ds = -behind; ds <= ahead; ds += 4) {
        const [px, py] = at(ds, 0);
        if (ds === -behind) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (const r of racers) {
        const [px, py] = at(r.ds, r.lane);
        ctx.fillStyle = r.css;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(3, 4.5 * L.sc), 0, TAU);
        ctx.fill();
    }
    const [px, py] = at(0, playerLane);
    const r = Math.max(5, 8 * L.sc);
    ctx.fillStyle = L.theme.neon;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py - r); ctx.lineTo(px + r * 0.7, py + r * 0.6); ctx.lineTo(px, py + r * 0.25); ctx.lineTo(px - r * 0.7, py + r * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** A small transient announcement below the item slot. */
export function drawBanner(ctx: CanvasRenderingContext2D, L: HudLayout, text: string, alpha: number): void {
    if (alpha <= 0.01 || L.vh < 360) return;
    const y = L.vw < 480 ? 152 : 136;
    ctx.save(); ctx.globalAlpha = alpha;
    hudPanel(ctx, L.vw / 2 - 70, y, 140, 30, L.theme.neonSecondary);
    hudText(ctx, text, L.vw / 2, y + 15, font(L), INK, 'center');
    ctx.restore();
}
