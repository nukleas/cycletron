/**
 * SPOT FIELD — a wild, fullscreen optical spot diagram. Every pattern track
 * is a gaussian ray-spot cloud orbiting the optical axis; hap onsets make a
 * cloud burst and refocus, the mids stretch the clouds astigmatically, the
 * highs split them into chromatic ghosts, and kicks defocus the whole field
 * and fire Airy rings from the center. Trail background smears the motion
 * like long-exposure film. Reticle chrome + live per-cloud RMS readouts keep
 * the optical-test-bench flavor without a single wiggly line chart.
 */

import {TrackModel} from '../tracks.js';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, TransientDetector, beatEnv} from '../util.js';

const SPOT_POINTS = 140;
const MAX_CLOUDS = 6;
const GOLDEN = 2.39996;

/** Per-track animation state that outlives a single bar rebuild. */
interface CloudAnim {
    /** Onset burst envelope — 1 at hit, fast exponential decay. */
    burst: number;
    /** Smoothed vertical offset from the cloud's pitched notes. */
    noteOffset: number;
    /** Target for noteOffset, set on pitched onsets. */
    noteTarget: number;
}

class SpotFieldMode implements VizMode {
    /** Shared unit-gaussian (x, y) pairs, scaled per cloud each frame. */
    private readonly unit = new Float32Array(SPOT_POINTS * 2);
    private readonly tracks = new TrackModel();
    private readonly anims = new Map<string, CloudAnim>();
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    private driftT = 0;
    /** Seconds since the last kick — drives the Airy-ring flash. */
    private kickAge = 10;
    /** Global defocus envelope — kicks swell every cloud. */
    private defocus = 0;

    constructor() {
        for (let i = 0; i < SPOT_POINTS; i++) {
            // Box–Muller
            const u = Math.random() || 1e-6;
            const v = Math.random();
            const mag = Math.sqrt(-2 * Math.log(u));
            this.unit[i * 2] = mag * Math.cos(TAU * v);
            this.unit[i * 2 + 1] = mag * Math.sin(TAU * v);
        }
    }

    layout(_s: VizServices): void {}

    private animFor(name: string): CloudAnim {
        let a = this.anims.get(name);
        if (!a) {
            a = { burst: 0, noteOffset: 0, noteTarget: 0 };
            this.anims.set(name, a);
        }
        return a;
    }

    update(dt: number, s: VizServices): void {
        this.driftT += dt;
        this.kickAge += dt;

        // Hap onsets: burst the track's cloud; pitched notes steer it.
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        if (sync.pattern && sync.phase >= sync.prevPhase) {
            for (const track of this.tracks.tracks) {
                for (let e = 0; e < track.count; e++) {
                    const begin = track.begins[e];
                    if (begin > sync.prevPhase && begin <= sync.phase) {
                        track.activity = Math.min(1, track.activity + 0.5);
                        const anim = this.animFor(track.name);
                        anim.burst = 1;
                        const note = track.notes[e];
                        if (Number.isFinite(note)) {
                            // C4-centered: low notes sink, high notes rise.
                            anim.noteTarget = -((note - 60) / 36);
                        }
                    }
                }
            }
        }
        this.tracks.decay(dt);

        // Anim envelopes.
        const burstDecay = Math.exp(-dt * 7);
        for (const anim of this.anims.values()) {
            anim.burst *= burstDecay;
            anim.noteOffset += (anim.noteTarget - anim.noteOffset) * Math.min(1, dt * 6);
        }
        // Drop anim state for tracks that no longer exist.
        if (this.anims.size > this.tracks.tracks.length + 8) {
            const live = new Set(this.tracks.tracks.map((t) => t.name));
            for (const name of this.anims.keys()) {
                if (!live.has(name)) this.anims.delete(name);
            }
        }

        // Kicks defocus the whole field + fire the Airy rings; hats add a
        // one-frame shimmer via the high band directly in render.
        const hits = this.transients.update(dt, s.low, s.mid, s.high);
        if (hits.kick) {
            this.kickAge = 0;
            this.defocus = 1;
        }
        this.defocus *= Math.exp(-dt * 3.5);
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h, low, mid, high} = s;
        const theme = s.theme;
        const cx = w / 2;
        const cy = h / 2;
        const R = Math.min(w, h) * 0.36;
        const beat = beatEnv(s.cycle * 4);
        const downbeat = beatEnv(s.cycle);
        const [tr, tg, tb] = theme.textRgb;
        const mono = '"JetBrains Mono", ui-monospace, monospace';

        // ---- Reticle chrome — re-asserted every frame over the trails ----
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.10 + beat * 0.08).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(w, cy);
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
        // Axis ticks every R/4 along both axes.
        ctx.beginPath();
        for (let m = 1; m <= 6; m++) {
            for (const sign of [1, -1]) {
                ctx.moveTo(cx + sign * (R * m) / 4, cy - 4);
                ctx.lineTo(cx + sign * (R * m) / 4, cy + 4);
                ctx.moveTo(cx - 4, cy + sign * (R * m) / 4);
                ctx.lineTo(cx + 4, cy + sign * (R * m) / 4);
            }
        }
        ctx.stroke();
        // Field-edge circle.
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.14)`;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.28, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);

        // ---- Kick Airy rings — expanding from the axis on every kick ----
        if (this.kickAge < 0.7) {
            const t = this.kickAge / 0.7;
            ctx.setLineDash([6, 5]);
            for (let ring = 0; ring < 3; ring++) {
                const rr = (t * 1.4 + ring * 0.18) * R;
                const alpha = (1 - t) * (0.4 - ring * 0.1);
                if (alpha <= 0.01) continue;
                ctx.strokeStyle = `hsla(${theme.neonHue}, 92%, 70%, ${alpha.toFixed(3)})`;
                ctx.lineWidth = 1.5 - ring * 0.4;
                ctx.beginPath();
                ctx.arc(cx, cy, rr, 0, TAU);
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
        }

        // ---- Clouds — one per track, band-driven fallback when idle ----
        interface Cloud {
            name: string;
            accent: [number, number, number];
            energy: number;
            burst: number;
            noteOffset: number;
            slot: number;
        }
        const clouds: Cloud[] = [];
        if (this.tracks.tracks.length > 0) {
            for (const t of this.tracks.tracks) {
                if (clouds.length >= MAX_CLOUDS) break;
                const anim = this.animFor(t.name);
                clouds.push({
                    name: t.name,
                    accent: t.accent,
                    energy: t.activity,
                    burst: anim.burst,
                    noteOffset: anim.noteOffset,
                    slot: t.slot,
                });
            }
        } else {
            const pool = theme.accentPool;
            const bands: Array<[string, number]> = [['LOW', low], ['MID', mid], ['HIGH', high]];
            for (let i = 0; i < 3; i++) {
                clouds.push({
                    name: bands[i][0],
                    accent: pool[i * 2 % pool.length],
                    energy: Math.min(1, bands[i][1]),
                    burst: 0,
                    noteOffset: 0,
                    slot: i,
                });
            }
        }

        ctx.globalCompositeOperation = 'lighter';
        ctx.font = `10px ${mono}`;
        ctx.textAlign = 'center';
        for (let ci = 0; ci < clouds.length; ci++) {
            const cloud = clouds[ci];
            const energy = Math.min(1, cloud.energy);

            // Orbit: each cloud owns a stable bearing (slot × golden angle),
            // crawling with the drift clock; bass widens the whole formation.
            const bearing = cloud.slot * GOLDEN + this.driftT * 0.12;
            const orbit = clouds.length === 1 ? 0 : R * (0.55 + low * 0.25);
            const ocx = cx + Math.cos(bearing) * orbit;
            const ocy = cy + Math.sin(bearing) * orbit * 0.72
                + cloud.noteOffset * h * 0.18;

            // Radius: bursts blow the cloud open, defocus (kicks) swells all,
            // then everything refocuses tight. Mids stretch astigmatically.
            const base = R * (0.10 + energy * 0.16);
            const rx = base * (1 + cloud.burst * 2.4 + this.defocus * 0.9);
            const ry = rx * (1 + mid * 1.6);
            const ang = this.driftT * (0.5 + energy * 1.6) + cloud.slot * 1.7;
            const [ar, ag, ab] = cloud.accent;

            // Chromatic ghosts: two offset passes split by the highs, then
            // the accent-colored core on top. Additive blending fuses them.
            const splitPx = high * 9 + cloud.burst * 4;
            const passes: Array<{ dx: number; color: string; alpha: number; size: number }> = [
                { dx: -splitPx, color: theme.neon, alpha: 0.10 + high * 0.14, size: 2 },
                { dx: splitPx, color: theme.red, alpha: 0.10 + high * 0.14, size: 2 },
                {
                    dx: 0,
                    color: `rgb(${ar}, ${ag}, ${ab})`,
                    alpha: 0.30 + energy * 0.45 + cloud.burst * 0.25,
                    size: 2.4,
                },
            ];
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            for (const pass of passes) {
                if (pass.dx !== 0 && splitPx < 0.8) continue;
                ctx.fillStyle = pass.color;
                ctx.globalAlpha = pass.alpha;
                for (let i = 0; i < SPOT_POINTS; i++) {
                    const px = this.unit[i * 2] * rx * 0.45;
                    const py = this.unit[i * 2 + 1] * ry * 0.45;
                    ctx.fillRect(
                        ocx + pass.dx + px * ca - py * sa,
                        ocy + px * sa + py * ca,
                        pass.size, pass.size,
                    );
                }
            }
            ctx.globalAlpha = 1;

            // Burst ring — expands as the burst decays.
            if (cloud.burst > 0.04) {
                ctx.strokeStyle = `rgba(${ar}, ${ag}, ${ab}, ${(cloud.burst * 0.8).toFixed(3)})`;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(ocx, ocy, rx * 0.8 + (1 - cloud.burst) * R * 0.5, 0, TAU);
                ctx.stroke();
                ctx.lineWidth = 1;
            }

            // Label + live RMS readout under the cloud (screen-space text is
            // outside the additive pass on purpose — keep it crisp).
            ctx.globalCompositeOperation = 'source-over';
            const rms = (rx / R) * 42; // fictional µm scale, moves honestly
            ctx.fillStyle = `rgba(${ar}, ${ag}, ${ab}, ${(0.4 + energy * 0.5).toFixed(3)})`;
            ctx.fillText(cloud.name.toUpperCase(), ocx, ocy + ry * 0.6 + 18);
            ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.45)`;
            ctx.fillText(`RMS ${rms.toFixed(1)}µm`, ocx, ocy + ry * 0.6 + 30);
            ctx.globalCompositeOperation = 'lighter';
        }
        ctx.globalCompositeOperation = 'source-over';

        // ---- Header readout ----
        ctx.textAlign = 'left';
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.6 + downbeat * 0.3).toFixed(3)})`;
        ctx.fillText('SPOT FIELD', 22, 20);
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.4)`;
        ctx.fillText(
            `BAR ${Math.max(0, Math.floor(s.cycle))}   FLD 0.7   DEFOCUS ${this.defocus.toFixed(2)}   λ d/F/C`,
            110, 20,
        );
    }
}

export const spotFieldDef: VizModeDef = {
    id: 'spot-field',
    name: 'SPOT FIELD',
    trailFade: 0.22,
    create: () => new SpotFieldMode(),
};
