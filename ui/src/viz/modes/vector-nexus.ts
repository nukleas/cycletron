/** VECTOR NEXUS — bounded, batched vector geometry; no particles, blur, or readbacks. */
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU} from '../util.js';

const BANDS = 96;
const VERTICES = 12;

class VectorNexusMode implements VizMode {
    private readonly directions = new Float32Array(BANDS * 2);
    private readonly levels = new Float32Array(BANDS);
    private readonly vertices = new Float32Array(VERTICES * 3);
    private readonly projected = new Float32Array(VERTICES * 3);
    private readonly edges: number[] = [];
    private phase = 0;
    private bass = 0;
    private mids = 0;
    private treble = 0;
    private bassFloor = 0;
    private impact = 0;
    private tilt = 0.4;
    private radius = 0;

    constructor() {
        for (let i = 0; i < BANDS; i++) {
            const angle = i / BANDS * TAU - Math.PI / 2;
            this.directions[i * 2] = Math.cos(angle);
            this.directions[i * 2 + 1] = Math.sin(angle);
        }
        // Two staggered pentagons and two poles form an icosahedral core.
        for (let i = 0; i < 10; i++) {
            const angle = (i % 5) / 5 * TAU + (i >= 5 ? Math.PI / 5 : 0);
            this.vertices[i * 3] = Math.cos(angle) * 0.8944;
            this.vertices[i * 3 + 1] = i < 5 ? -0.4472 : 0.4472;
            this.vertices[i * 3 + 2] = Math.sin(angle) * 0.8944;
        }
        this.vertices[31] = -1;
        this.vertices[34] = 1;
        for (let i = 0; i < VERTICES; i++) {
            for (let j = i + 1; j < VERTICES; j++) {
                const distance = Math.hypot(
                    this.vertices[i * 3] - this.vertices[j * 3],
                    this.vertices[i * 3 + 1] - this.vertices[j * 3 + 1],
                    this.vertices[i * 3 + 2] - this.vertices[j * 3 + 2]);
                if (distance < 1.1) this.edges.push(i, j);
            }
        }
    }

    layout(s: VizServices): void {
        this.radius = Math.max(0, Math.min(s.width, s.height) * 0.34);
    }

    update(dt: number, s: VizServices): void {
        const step = Math.min(Math.max(dt, 0), 0.1);
        const smoothing = 1 - Math.exp(-step * 12);
        // Fast attack / slower release preserves drum transients. The host has
        // already applied sensitivity; lift quiet bands without multiplying it twice.
        const low = Math.sqrt(Math.min(1, Math.max(0, s.low)));
        const mid = Math.sqrt(Math.min(1, Math.max(0, s.mid)));
        const high = Math.sqrt(Math.min(1, Math.max(0, s.high)));
        this.bass += (low - this.bass) * (1 - Math.exp(-step * (low > this.bass ? 32 : 7)));
        this.mids += (mid - this.mids) * smoothing;
        this.treble += (high - this.treble) * (1 - Math.exp(-step * (high > this.treble ? 28 : 9)));
        this.bassFloor += (low - this.bassFloor) * (1 - Math.exp(-step * 3));
        this.impact = Math.max(this.impact * Math.exp(-step * 9),
            Math.min(1, Math.max(0, this.bass - this.bassFloor) * 2.5));
        this.phase = (this.phase + step * (0.16 + this.mids * 0.65 + this.impact * 1.4)) % TAU;
        this.tilt = (this.tilt + step * (0.11 + this.treble * 0.35)) % TAU;
        const data = s.freqData;
        for (let i = 0; i < BANDS; i++) {
            // Mirror a logarithmic frequency sweep around the instrument.
            const band = Math.min(i, BANDS - 1 - i) / (BANDS / 2 - 1);
            const bin = data?.length ? Math.min(data.length - 1,
                Math.floor(Math.pow(data.length, band) - 1)) : 0;
            const target = data?.length ? Math.min(1, data[bin] / 255 * s.sensitivity) : 0;
            this.levels[i] += (target - this.levels[i]) * smoothing;
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const r = this.radius;
        if (r <= 0) return;
        ctx.save();
        ctx.translate(s.width / 2, s.height / 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = s.theme.neon;

        // Instrument reticle: one batched path for all fixed ticks and rings.
        ctx.globalAlpha = 0.24;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.moveTo(r * 0.91, 0);
        ctx.arc(0, 0, r * 0.91, 0, TAU);
        for (let i = 0; i < BANDS; i++) {
            const x = this.directions[i * 2], y = this.directions[i * 2 + 1];
            const outer = i % 8 === 0 ? 1.075 : 1.035;
            ctx.moveTo(x * r * 1.015, y * r * 1.015);
            ctx.lineTo(x * r * outer, y * r * outer);
        }
        ctx.stroke();

        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < BANDS; i++) {
            const x = this.directions[i * 2], y = this.directions[i * 2 + 1];
            const tip = r * (1.09 + this.levels[i] * 0.24);
            ctx.moveTo(x * r * 1.09, y * r * 1.09);
            ctx.lineTo(x * tip, y * tip);
        }
        ctx.stroke();

        // Counter-rotating orbital arcs leave intentional gaps and crisp endpoints.
        ctx.strokeStyle = s.theme.neonSecondary;
        ctx.lineWidth = 1.5 + this.treble;
        ctx.globalAlpha = 0.5 + this.treble * 0.35;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
            const a = -this.phase * 1.4 + i * TAU / 3;
            ctx.moveTo(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82);
            ctx.arc(0, 0, r * 0.82, a, a + 1.1);
        }
        ctx.stroke();

        const cy = Math.cos(this.phase), sy = Math.sin(this.phase);
        const tilt = this.tilt + this.mids * 0.5;
        const cx = Math.cos(tilt), sx = Math.sin(tilt);
        const size = r * (0.46 + this.bass * 0.16 + this.impact * 0.07);
        for (let i = 0; i < VERTICES; i++) {
            const k = i * 3;
            // Each vertex follows a different smoothed spectrum band. Midrange
            // stretches the poles; treble adds a small, asymmetric surface ripple.
            const band = this.levels[Math.floor(i / VERTICES * (BANDS / 2))];
            const dilation = 1 + band * 0.13 + this.treble * 0.06 * Math.sin(i * 2.4 + this.phase * 2);
            const vx = this.vertices[k] * dilation * (1 - this.mids * 0.08);
            const vy = this.vertices[k + 1] * dilation * (1 + this.mids * 0.19);
            const vz = this.vertices[k + 2] * dilation;
            const x = vx * cy + vz * sy;
            const z = -vx * sy + vz * cy;
            const y = vy * cx - z * sx;
            const depth = vy * sx + z * cx;
            const perspective = 3 / (3 - depth);
            this.projected[k] = x * size * perspective;
            this.projected[k + 1] = y * size * perspective;
            this.projected[k + 2] = depth;
        }
        // Two depth batches, no per-frame arrays or sorting.
        ctx.strokeStyle = s.theme.neon;
        for (let layer = 0; layer < 2; layer++) {
            ctx.globalAlpha = layer === 0 ? 0.2 + this.treble * 0.15 : 0.75 + this.treble * 0.25;
            ctx.lineWidth = layer === 0 ? 1 : 1.5 + this.impact * 1.2;
            ctx.beginPath();
            for (let i = 0; i < this.edges.length; i += 2) {
                const a = this.edges[i] * 3, b = this.edges[i + 1] * 3;
                if (Number(this.projected[a + 2] + this.projected[b + 2] >= 0) !== layer) continue;
                ctx.moveTo(this.projected[a], this.projected[a + 1]);
                ctx.lineTo(this.projected[b], this.projected[b + 1]);
            }
            ctx.stroke();
        }
        ctx.fillStyle = s.theme.active;
        ctx.globalAlpha = 0.95;
        const nodeSize = 3 + this.treble * 3;
        for (let i = 0; i < VERTICES; i++) {
            if (this.projected[i * 3 + 2] < 0) continue;
            ctx.fillRect(this.projected[i * 3] - nodeSize / 2,
                this.projected[i * 3 + 1] - nodeSize / 2, nodeSize, nodeSize);
        }

        // Waveform is sampled to a fixed budget independent of analyser FFT size.
        ctx.strokeStyle = s.theme.neon;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 128; i++) {
            const data = s.timeData;
            const sample = data?.length ? (data[Math.floor(i / 128 * (data.length - 1))] - 128) / 128 : 0;
            const x = (i / 128 - 0.5) * r * 1.5;
            const y = sample * r * 0.13;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
    }
}

export const vectorNexusDef: VizModeDef = {
    id: 'vector-nexus',
    name: 'VECTOR NEXUS',
    create: () => new VectorNexusMode(),
};
