/**
 * NEON CIRCUIT — a circuit board wired to the pattern schedule.
 *
 * The outer ring holds one node per track (stable by slot, spread around the
 * ring, labelled when there is room); the unowned ring positions and the
 * inner ring are relays, and the centre is the hub on a horizontal data bus.
 * Every scheduled onset launches a packet from its track's node, through a
 * relay, into the hub, where it splits left and right along the bus — so the
 * traffic *is* the rhythm, leaving on the scheduled event. Node cores swell
 * with the track's activity envelope, traversed traces stay lit briefly, and
 * a thin ring leaves the hub on each downbeat that actually plays.
 *
 * FFT is a second opinion: the smoothed low band lifts the bus. With no
 * pattern, band transients send occasional neutral packets on top of a slow
 * idle heartbeat, so the board never goes dark.
 *
 * The board spins in musical time — once every 16 bars — and each kick onset
 * shoves it forward; the inner relays lag behind the shove, so the spokes
 * twist on the kick and relax back. The edge list is fixed; node positions
 * are re-placed along their ellipses each frame, so packets, traces and
 * labels ride the spin. Packets live in fixed round-robin pools.
 */

import type {Theme, VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel, instrumentFamily, type TrackSync, type VizTrack} from '../tracks.js';
import {
    TAU, TransientDetector, alphaRamp, clamp01, drawLabel, follow, hash32, rampAt, rgbOf,
} from '../util.js';

const OUTER = 16;
const INNER = 8;
const HUB = OUTER + INNER;
const NODES = HUB + 1;

// Edge list layout: [outer ring][outer → relay][inner ring][relay → hub].
const E_OUTER = 0;
const E_SPOKE = OUTER;
const E_INNER = E_SPOKE + OUTER;
const E_HUB = E_INNER + INNER;
const EDGES = E_HUB + INNER;

const MAX_PACKETS = 128;
const MAX_BUS = 48;
/** Graph segments per second — outer → relay → hub takes ~0.4 s at any size. */
const PACKET_SPEED = 5;
/** Bus half-widths per second. */
const BUS_SPEED = 1.3;
const SHOCK_SECONDS = 0.9;
const IDLE_HEARTBEAT = 1.6;
/** Outer-ring turns per bar while playing (one per 16 bars). */
const SPIN_PER_BAR = TAU / 16;
/** Seconds of shove the inner relays lag by — the twist on a kick. */
const INNER_LAG = 0.45;
/** Radians per second when nothing is scheduled. */
const IDLE_SPIN = 0.06;
/** Angular velocity a kick onset adds (rad/s), decaying at SPIN_DECAY. */
const KICK_SHOVE = 0.55;
const SPIN_DECAY = 3;

/** Track slot → outer ring position. 5 is coprime with 16, so a few tracks spread out. */
function ringPosition(slot: number): number {
    return (slot * 5) % OUTER;
}

class NeonCircuitMode implements VizMode {
    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.3, 0.35, 0.5);

    // --- geometry (layout) --------------------------------------------------
    private u = 0;
    private lw = 1;
    private cx = 0;
    private cy = 0;
    private rx = 0;
    private ry = 0;
    private busHalf = 0;
    private readonly nodeX = new Float32Array(NODES);
    private readonly nodeY = new Float32Array(NODES);
    private readonly edgeA = new Uint8Array(EDGES);
    private readonly edgeB = new Uint8Array(EDGES);

    // --- simulation ---------------------------------------------------------
    private readonly edgeGlow = new Float32Array(EDGES);
    private readonly owner: (VizTrack | null)[] = new Array<VizTrack | null>(OUTER).fill(null);

    private readonly pActive = new Uint8Array(MAX_PACKETS);
    private readonly pFrom = new Uint8Array(MAX_PACKETS);
    private readonly pT = new Float32Array(MAX_PACKETS);
    private readonly pColor: string[] = new Array<string>(MAX_PACKETS).fill('');
    private pNext = 0;

    private readonly bActive = new Uint8Array(MAX_BUS);
    private readonly bX = new Float32Array(MAX_BUS);   // -1..1 of the bus half-width
    private readonly bDir = new Int8Array(MAX_BUS);
    private readonly bColor: string[] = new Array<string>(MAX_BUS).fill('');
    private bNext = 0;

    private hubEnv = 0;
    private spin = 0;
    private spinVel = 0;
    private lastCycle = NaN;
    private lowF = 0;
    private shockAge = SHOCK_SECONDS;
    private lastBar = NaN;
    private idleTimer = 0;
    private idleSeq = 0;

    // --- theme cache --------------------------------------------------------
    private theme: Theme | null = null;
    private neonRamp: string[] = [];
    private secRamp: string[] = [];
    private borderRamp: string[] = [];
    private textRamp: string[] = [];

    constructor() {
        for (let i = 0; i < OUTER; i++) {
            this.edgeA[E_OUTER + i] = i;
            this.edgeB[E_OUTER + i] = (i + 1) % OUTER;
            this.edgeA[E_SPOKE + i] = i;
            this.edgeB[E_SPOKE + i] = OUTER + (i >> 1);
        }
        for (let j = 0; j < INNER; j++) {
            this.edgeA[E_INNER + j] = OUTER + j;
            this.edgeB[E_INNER + j] = OUTER + (j + 1) % INNER;
            this.edgeA[E_HUB + j] = OUTER + j;
            this.edgeB[E_HUB + j] = HUB;
        }
    }

    layout(s: VizServices): void {
        const w = s.width, h = s.height;
        this.u = Math.min(w, h) / 720;
        this.lw = Math.min(2, Math.max(1, 0.9 + this.u * 0.35));
        this.cx = w / 2;
        this.cy = h / 2;
        // A wide ellipse on landscape, a tall one in a sidebar pane.
        this.rx = Math.min(w * 0.4, h * 0.38 * 1.5);
        this.ry = Math.min(h * 0.36, w * 0.4 * 1.2);
        this.busHalf = Math.max(0, w / 2 - Math.max(12, w * 0.03));
        this.placeNodes();
    }

    /** Nodes along their ellipses at the current spin; the hub stays put. */
    private placeNodes(): void {
        const outer = -Math.PI / 2 + this.spin;
        for (let i = 0; i < OUTER; i++) {
            const a = outer + (i / OUTER) * TAU;
            this.nodeX[i] = this.cx + Math.cos(a) * this.rx;
            this.nodeY[i] = this.cy + Math.sin(a) * this.ry;
        }
        const inner = -Math.PI / 2 + this.spin - this.spinVel * INNER_LAG;
        for (let j = 0; j < INNER; j++) {
            // Starts between the two outer nodes that feed it.
            const a = inner + ((j * 2 + 0.5) / OUTER) * TAU;
            this.nodeX[OUTER + j] = this.cx + Math.cos(a) * this.rx * 0.5;
            this.nodeY[OUTER + j] = this.cy + Math.sin(a) * this.ry * 0.5;
        }
        this.nodeX[HUB] = this.cx;
        this.nodeY[HUB] = this.cy;
    }

    private ensureTheme(theme: Theme): void {
        if (theme === this.theme) return;
        this.theme = theme;
        this.neonRamp = alphaRamp(rgbOf(theme.neon, [71, 246, 255]));
        this.secRamp = alphaRamp(rgbOf(theme.neonSecondary, [255, 71, 214]));
        this.borderRamp = alphaRamp(theme.borderRgb);
        this.textRamp = alphaRamp(theme.textRgb);
    }

    private launch(node: number, color: string): void {
        const i = this.pNext;
        this.pNext = (i + 1) % MAX_PACKETS;
        this.pActive[i] = 1;
        this.pFrom[i] = node;
        this.pT[i] = 0;
        this.pColor[i] = color;
    }

    private toBus(color: string): void {
        for (let dir = -1; dir <= 1; dir += 2) {
            const i = this.bNext;
            this.bNext = (i + 1) % MAX_BUS;
            this.bActive[i] = 1;
            this.bX[i] = 0;
            this.bDir[i] = dir;
            this.bColor[i] = color;
        }
    }

    private readonly onOnset = (track: VizTrack): void => {
        this.launch(ringPosition(track.slot), track.accentCss);
        if (instrumentFamily(track.name) === 'kick') this.spinVel += KICK_SHOVE;
    };

    update(dt: number, s: VizServices): void {
        this.ensureTheme(s.theme);
        const sync: TrackSync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        const playing = sync.pattern !== null;
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);

        this.owner.fill(null);
        if (playing) {
            for (const t of this.tracks.tracks) {
                if (t.count === 0 && t.activity < 0.02) continue;
                const pos = ringPosition(t.slot);
                if (!this.owner[pos]) this.owner[pos] = t;
            }
        }

        const low = Number.isFinite(s.low) ? Math.max(0, s.low) : 0;
        const mid = Number.isFinite(s.mid) ? Math.max(0, s.mid) : 0;
        const high = Number.isFinite(s.high) ? Math.max(0, s.high) : 0;
        this.lowF = follow(this.lowF, Math.min(1.5, low), dt, 30, 7);
        const hits = this.transients.update(dt, low, mid, high);

        if (!playing) {
            // Neutral traffic from hashed positions: transients plus a slow heartbeat.
            const th = this.theme!;
            if (hits.kick) this.launch(hash32(this.idleSeq++, 11) % OUTER, th.neon);
            if (hits.snare) this.launch(hash32(this.idleSeq++, 11) % OUTER, th.neonSecondary);
            if (hits.hat) this.launch(hash32(this.idleSeq++, 11) % OUTER, th.active);
            this.idleTimer += dt;
            if (this.idleTimer >= IDLE_HEARTBEAT) {
                this.idleTimer = 0;
                this.launch(hash32(this.idleSeq++, 11) % OUTER, th.violet);
            }
        } else {
            this.idleTimer = 0;
        }

        // Spin: musical time while playing (a seek or stall moves nothing),
        // a slow drift when idle, plus the decaying kick shove.
        const dCycle = s.cycle - this.lastCycle;
        this.lastCycle = s.cycle;
        const advance = playing
            ? (dCycle > 0 && dCycle < 0.25 ? dCycle * SPIN_PER_BAR : 0)
            : dt * IDLE_SPIN;
        this.spinVel *= Math.exp(-dt * SPIN_DECAY);
        this.spin = (this.spin + advance + this.spinVel * dt) % TAU;
        this.placeNodes();

        // Shockwave only on a downbeat reached by playing forward, never on
        // mode entry or a seek.
        const bar = Math.floor(s.cycle);
        if (playing && bar === this.lastBar + 1) this.shockAge = 0;
        this.lastBar = bar;
        this.shockAge = Math.min(SHOCK_SECONDS, this.shockAge + dt);

        const glowK = Math.exp(-dt * 4);
        for (let e = 0; e < EDGES; e++) this.edgeGlow[e] *= glowK;
        this.hubEnv *= Math.exp(-dt * 5);

        for (let i = 0; i < MAX_PACKETS; i++) {
            if (!this.pActive[i]) continue;
            const t = this.pT[i] + dt * PACKET_SPEED;
            const from = this.pFrom[i];
            if (t >= 2) {
                this.pActive[i] = 0;
                this.hubEnv = Math.min(1, this.hubEnv + 0.35);
                this.toBus(this.pColor[i]);
                continue;
            }
            this.pT[i] = t;
            this.edgeGlow[t < 1 ? E_SPOKE + from : E_HUB + (from >> 1)] = 1;
        }
        for (let i = 0; i < MAX_BUS; i++) {
            if (!this.bActive[i]) continue;
            const x = this.bX[i] + this.bDir[i] * dt * BUS_SPEED;
            if (Math.abs(x) >= 1) this.bActive[i] = 0;
            else this.bX[i] = x;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const w = s.width, h = s.height;
        if (w <= 0 || h <= 0) return;
        if (this.u === 0) this.layout(s);
        this.ensureTheme(s.theme);
        const {u, lw, cx, cy} = this;
        const nx = this.nodeX, ny = this.nodeY;

        ctx.save();
        ctx.lineCap = 'round';

        // Data bus through the hub.
        ctx.lineWidth = lw * 1.5;
        ctx.strokeStyle = rampAt(this.secRamp, 0.16 + clamp01(this.lowF) * 0.24 + this.hubEnv * 0.15);
        ctx.beginPath();
        ctx.moveTo(cx - this.busHalf, cy);
        ctx.lineTo(cx + this.busHalf, cy);
        ctx.stroke();

        // Traces: one batched pass, then the lit ones in three alpha buckets.
        ctx.lineWidth = lw;
        ctx.strokeStyle = rampAt(this.borderRamp, 0.55);
        ctx.beginPath();
        for (let e = 0; e < EDGES; e++) {
            ctx.moveTo(nx[this.edgeA[e]], ny[this.edgeA[e]]);
            ctx.lineTo(nx[this.edgeB[e]], ny[this.edgeB[e]]);
        }
        ctx.stroke();
        for (let bucket = 0; bucket < 3; bucket++) {
            const lo = 0.1 + bucket * 0.3, hi = lo + 0.3;
            ctx.strokeStyle = rampAt(this.neonRamp, 0.25 + bucket * 0.25);
            ctx.lineWidth = lw * (1 + bucket * 0.25);
            ctx.beginPath();
            let any = false;
            for (let e = 0; e < EDGES; e++) {
                const g = this.edgeGlow[e];
                if (g < lo || (g >= hi && bucket < 2)) continue;
                ctx.moveTo(nx[this.edgeA[e]], ny[this.edgeA[e]]);
                ctx.lineTo(nx[this.edgeB[e]], ny[this.edgeB[e]]);
                any = true;
            }
            if (any) ctx.stroke();
        }

        // Downbeat ring — thin, follows the board's ellipse outward.
        if (this.shockAge < SHOCK_SECONDS) {
            const t = this.shockAge / SHOCK_SECONDS;
            const k = 0.12 + t * 1.05;
            ctx.strokeStyle = rampAt(this.secRamp, (1 - t) * 0.55);
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.ellipse(cx, cy, this.rx * k, this.ry * k, 0, 0, TAU);
            ctx.stroke();
        }

        // Packets: a square head with a short tail along its trace.
        const ps = Math.max(3, 4.5 * u);
        const tail = 0.12;
        ctx.lineWidth = lw;
        for (let i = 0; i < MAX_PACKETS; i++) {
            if (!this.pActive[i]) continue;
            const from = this.pFrom[i];
            const t = this.pT[i];
            const a = t < 1 ? from : OUTER + (from >> 1);
            const b = t < 1 ? OUTER + (from >> 1) : HUB;
            const f = t < 1 ? t : t - 1;
            const ft = Math.max(0, f - tail);
            const x = nx[a] + (nx[b] - nx[a]) * f;
            const y = ny[a] + (ny[b] - ny[a]) * f;
            ctx.strokeStyle = this.pColor[i];
            ctx.fillStyle = this.pColor[i];
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(nx[a] + (nx[b] - nx[a]) * ft, ny[a] + (ny[b] - ny[a]) * ft);
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillRect(x - ps / 2, y - ps / 2, ps, ps);
        }
        const dash = Math.max(6, 16 * u);
        const bh = Math.max(2, 2.4 * u);
        for (let i = 0; i < MAX_BUS; i++) {
            if (!this.bActive[i]) continue;
            const x = cx + this.bX[i] * this.busHalf;
            ctx.globalAlpha = 0.9 * (1 - Math.abs(this.bX[i]));
            ctx.fillStyle = this.bColor[i];
            ctx.fillRect(this.bDir[i] > 0 ? x - dash : x, cy - bh / 2, dash, bh);
        }
        ctx.globalAlpha = 1;

        // Relays: inner ring and unowned outer positions, one batched path.
        const rs = Math.max(3, 4.5 * u);
        ctx.beginPath();
        for (let i = 0; i < HUB; i++) {
            if (i < OUTER && this.owner[i]) continue;
            ctx.rect(nx[i] - rs / 2, ny[i] - rs / 2, rs, rs);
        }
        ctx.fillStyle = s.theme.bg;
        ctx.fill();
        ctx.strokeStyle = rampAt(this.neonRamp, 0.45);
        ctx.lineWidth = lw;
        ctx.stroke();

        // Track nodes: flat accent core scaled by activity, fine outline.
        const nodeR = Math.max(3, 6 * u);
        const labels = w >= 420 && h >= 300;
        const fontSize = Math.round(Math.min(11, Math.max(9, 8 + u * 1.5)));
        for (let i = 0; i < OUTER; i++) {
            const t = this.owner[i];
            if (!t) continue;
            const act = clamp01(t.activity);
            const r = nodeR * (1 + act * 0.7);
            ctx.beginPath();
            ctx.arc(nx[i], ny[i], r, 0, TAU);
            ctx.fillStyle = s.theme.bg;
            ctx.fill();
            ctx.globalAlpha = 0.3 + act * 0.7;
            ctx.fillStyle = t.accentCss;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = t.accentCss;
            ctx.lineWidth = lw;
            ctx.stroke();
            if (labels) {
                // Outward from the ring, aligned away from the centre.
                const dx = nx[i] - cx, dy = ny[i] - cy;
                const d = Math.hypot(dx, dy) || 1;
                const off = r + 6 * u + 4;
                const lx = nx[i] + (dx / d) * off;
                const ly = ny[i] + (dy / d) * off;
                const align: CanvasTextAlign = Math.abs(dx) < d * 0.2 ? 'center' : dx > 0 ? 'left' : 'right';
                drawLabel(ctx, t.name, lx, ly, rampAt(this.textRamp, 0.45 + act * 0.45), fontSize, align);
            }
        }

        // Hub.
        const hubR = Math.max(5, 11 * u) * (1 + this.hubEnv * 0.2);
        ctx.beginPath();
        ctx.arc(cx, cy, hubR, 0, TAU);
        ctx.fillStyle = s.theme.bg;
        ctx.fill();
        ctx.fillStyle = rampAt(this.neonRamp, 0.15 + this.hubEnv * 0.75);
        ctx.fill();
        ctx.strokeStyle = s.theme.neon;
        ctx.lineWidth = lw * 1.2;
        ctx.stroke();

        ctx.restore();
    }
}

export const neonCircuitDef: VizModeDef = {
    id: 'neon-circuit',
    name: 'NEON CIRCUIT',
    create: () => new NeonCircuitMode(),
};
