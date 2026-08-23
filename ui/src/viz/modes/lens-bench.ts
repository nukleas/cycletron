/**
 * LENS BENCH — blueprint optical bench with a live ray trace. A real 2D
 * meridional trace (vector Snell through spherical surfaces) of classic
 * prescriptions, drawn as an optical-engineering blueprint. Pattern haps ride
 * the rays as light pulses; the FFT breathes the fan, swings the field angle,
 * and splits the trace chromatically.
 */

import {currentBpm} from '../../bpm.js';
import {TrackModel} from '../tracks.js';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, TransientDetector, beatEnv, rgbOf} from '../util.js';

interface LensSurface {
    /** Radius of curvature in mm; 0 = plane. */
    r: number;
    /** Axial distance to the next surface (last surface: to the image plane). */
    t: number;
    /** Refractive index of the medium AFTER this surface; 1 = air. */
    nd: number;
    /** Abbe number of that medium (dispersion); 0 for air. */
    vd: number;
    /** Semi-diameter (clear aperture) in mm — rays beyond it vignette. */
    sd: number;
    stop?: boolean;
    glass?: string;
}

interface LensDesign {
    name: string;
    sheet: string;
    efl: string;
    fno: string;
    maxFieldDeg: number;
    surfaces: LensSurface[];
}

/**
 * Real prescriptions (rustoptic import fixtures / Kingslake, Smith). The
 * Double Gauss stop sits on a dummy plane inside the front SF5 element,
 * exactly as the fixture records it — the trace crosses it un-refracted
 * (n1 === n2) and the aperture still clips there.
 */
const LENS_DESIGNS: LensDesign[] = [
    {
        name: 'ACHROMAT DOUBLET 100mm',
        sheet: 'DWG 012-A · FRAUNHOFER',
        efl: 'EFL 100.0',
        fno: 'f/4',
        maxFieldDeg: 3,
        surfaces: [
            { r: 61.0, t: 4.0, nd: 1.5168, vd: 64.2, sd: 12.7, glass: 'N-BK7' },
            { r: -44.3, t: 2.5, nd: 1.6200, vd: 36.4, sd: 12.7, glass: 'F2' },
            { r: -129.0, t: 96.0, nd: 1, vd: 0, sd: 12.7 },
        ],
    },
    {
        name: 'COOKE TRIPLET 50mm',
        sheet: 'DWG 041-C · GB 22,607',
        efl: 'EFL 50.0',
        fno: 'f/4',
        maxFieldDeg: 7,
        surfaces: [
            { r: 26.1, t: 4.5, nd: 1.6204, vd: 60.3, sd: 9, glass: 'N-SK16' },
            { r: 253.0, t: 6.0, nd: 1, vd: 0, sd: 9 },
            { r: -69.0, t: 1.5, nd: 1.6200, vd: 36.4, sd: 5, stop: true, glass: 'F2' },
            { r: 37.0, t: 5.5, nd: 1.6204, vd: 60.3, sd: 9, glass: 'N-SK16' },
            { r: -28.7, t: 44.5, nd: 1, vd: 0, sd: 9 },
        ],
    },
    {
        name: 'DOUBLE GAUSS 50mm',
        sheet: 'DWG 107-B · KINGSLAKE',
        efl: 'EFL 50.0',
        fno: 'f/2',
        maxFieldDeg: 10,
        surfaces: [
            { r: 57.08, t: 6.0, nd: 1.6223, vd: 53.3, sd: 16, glass: 'N-SSK2' },
            { r: 149.58, t: 0.5, nd: 1, vd: 0, sd: 16 },
            { r: 37.68, t: 8.0, nd: 1.6910, vd: 54.7, sd: 14, glass: 'N-LAK9' },
            { r: 0, t: 3.5, nd: 1.6727, vd: 32.2, sd: 11, glass: 'N-SF5' },
            { r: 0, t: 3.5, nd: 1.6727, vd: 32.2, sd: 10, stop: true },
            { r: -30.39, t: 1.5, nd: 1, vd: 0, sd: 11 },
            { r: -30.39, t: 8.0, nd: 1.6910, vd: 54.7, sd: 14, glass: 'N-LAK9' },
            { r: -72.91, t: 0.5, nd: 1, vd: 0, sd: 16 },
            { r: 300.0, t: 5.0, nd: 1.6223, vd: 53.3, sd: 16, glass: 'N-SSK2' },
            { r: -57.08, t: 40.0, nd: 1, vd: 0, sd: 16 },
        ],
    },
];

const RAYS = 15;              // rays per fan, per wavelength lane
const LANES = 3;              // d (reference), F (blue), C (red)
/** Index offset scale per lane — exaggerated so the split reads at px scale. */
const LANE_DELTA = [0, 0.9, -0.6];
const DISPERSION_GAIN = 8;
const MAX_PULSES = 64;
const DESIGN_BARS = 16;       // bars per prescription before rotating
/** Points per ray: launch + one per surface (max 10) + image plane. */
const MAX_PTS = 12;

interface Pulse {
    /** Ray index in the d-line lane the pulse rides. */
    ray: number;
    /** Position in point-index parameter space (segments are near-uniform,
     *  so we skip arclength — visually indistinguishable at pulse speed). */
    s: number;
    speed: number;
    color: string;
    /** 1 while travelling; fades out after arrival. */
    life: number;
    arrived: boolean;
}

/** Sag (axial depth) of a spherical surface at height y; 0 for planes. */
function sagZ(r: number, y: number): number {
    if (r === 0 || Math.abs(r) > 1e6) return 0;
    const ay = Math.min(Math.abs(y), Math.abs(r));
    return r - Math.sign(r) * Math.sqrt(r * r - ay * ay);
}

/** Vertex z positions + image plane, refilled per trace. */
const zScratch = new Float64Array(16);

const MONO = '"JetBrains Mono", ui-monospace, monospace';

class LensBenchMode implements VizMode {
    private designIdx = 0;
    private field = 0;          // current field angle, radians
    private split = 0;          // smoothed chromatic split, 0..1
    private lowSm = 0;          // smoothed bands — trace geometry inputs
    private midSm = 0;
    private driftT = 0;
    private scale = 0;          // world mm → css px; 0 = unfitted
    private ox = 0;             // screen x of world z = 0
    private cy = 0;             // screen y of the optical axis
    /** Ray polylines, (z, y) world-mm pairs, MAX_PTS stride per ray. */
    private readonly polys = new Float32Array(LANES * RAYS * MAX_PTS * 2);
    private readonly polyLen = new Uint8Array(LANES * RAYS);
    /** Surface index where the ray died (vignette/TIR/miss), -1 = reached image. */
    private readonly polyClip = new Int8Array(LANES * RAYS);
    /** Image-plane y per d-lane ray, NaN for dead rays — feeds the bloom. */
    private readonly imageHits = new Float32Array(RAYS).fill(NaN);
    private pulses: Pulse[] = [];
    private bloom = 0;
    private titleFlash = 0;
    private readonly tracks = new TrackModel();
    private readonly transients = new TransientDetector(0.1, 0.08, 0.04);
    private vw = 0;
    private vh = 0;

    layout(s: VizServices): void {
        this.vw = s.width;
        this.vh = s.height;
        if (s.width === 0 || s.height === 0) return;
        // Land on whatever design the auto-rotation currently shows.
        this.designIdx = Math.floor(Math.max(0, s.cycle) / DESIGN_BARS) % LENS_DESIGNS.length;
        this.refit();
    }

    /** Fit the design's world box (mm) to the canvas — margins reserve the
     *  callout strip on top and the title block row at the bottom. */
    private refit(): void {
        if (this.vw === 0 || this.vh === 0) return;
        const design = LENS_DESIGNS[this.designIdx];
        let zImg = 0;
        let sdMax = 0;
        for (const surf of design.surfaces) {
            zImg += surf.t;
            if (surf.sd > sdMax) sdMax = surf.sd;
        }
        const zMin = -0.18 * zImg;
        const zMax = zImg * 1.04;
        const yMax = sdMax * 1.3;
        const mL = 48, mR = 48, mT = 56, mB = 76;
        const scale = Math.min(
            (this.vw - mL - mR) / (zMax - zMin),
            (this.vh - mT - mB) / (2 * yMax),
        );
        this.scale = Math.max(0.1, scale);
        this.ox = mL + (this.vw - mL - mR - (zMax - zMin) * this.scale) / 2
            - zMin * this.scale;
        this.cy = mT + (this.vh - mT - mB) / 2;
    }

    /**
     * 2D meridional trace, re-run every frame (≤45 rays × ≤10 surfaces of
     * quadratic math — trivially cheap, and it buys continuous field-angle and
     * chromatic animation with zero cache invalidation). Vector Snell through
     * spherical surfaces; rays die on vignette, TIR, or a full miss.
     */
    private trace(): void {
        const design = LENS_DESIGNS[this.designIdx];
        const S = design.surfaces;
        const nS = S.length;
        let z = 0;
        for (let k = 0; k < nS; k++) {
            zScratch[k] = z;
            z += S[k].t;
        }
        const zImg = z;
        const zStart = -0.18 * zImg;
        const fill = 0.6 + this.lowSm * 0.32;
        const slope = -Math.tan(this.field);
        const dirLen = Math.sqrt(1 + slope * slope);
        const split = this.split;

        for (let w = 0; w < LANES; w++) {
            // Chromatic lanes only exist while the highs hold them open.
            const laneOn = w === 0 || split > 0.015;
            for (let i = 0; i < RAYS; i++) {
                const rayIdx = w * RAYS + i;
                if (!laneOn) {
                    this.polyLen[rayIdx] = 0;
                    continue;
                }
                const base = rayIdx * MAX_PTS * 2;
                const p = (i / (RAYS - 1)) * 2 - 1;
                const y1 = p * S[0].sd * fill;

                // Tilted parallel bundle arriving at height y1 at z=0.
                let pz = zStart;
                let py = y1 + slope * zStart;
                let dz = 1 / dirLen;
                let dy = slope / dirLen;
                let n1 = 1;
                let np = 1;
                let clip = -1;
                this.polys[base] = pz;
                this.polys[base + 1] = py;

                for (let k = 0; k < nS; k++) {
                    const surf = S[k];
                    const r = surf.r;
                    const Zk = zScratch[k];
                    let qz: number;
                    let qy: number;
                    let nx: number;
                    let ny: number;

                    if (r === 0 || Math.abs(r) > 1e6) {
                        if (Math.abs(dz) < 1e-9) { clip = k; break; }
                        const t = (Zk - pz) / dz;
                        if (t < 1e-6) { clip = k; break; }
                        qz = pz + dz * t;
                        qy = py + dy * t;
                        nx = 1;
                        ny = 0;
                    } else {
                        // Sphere centered on-axis at Zk + r. Root choice picks
                        // the vertex-side intersection for either curvature
                        // sign: r>0 → −b−√disc, r<0 → −b+√disc.
                        const cz = Zk + r;
                        const ocz = pz - cz;
                        const ocy = py;
                        const b = dz * ocz + dy * ocy;
                        const c = ocz * ocz + ocy * ocy - r * r;
                        const disc = b * b - c;
                        if (disc < 0) {
                            // Missed the surface sphere — visibly fly off.
                            this.polys[base + np * 2] = pz + dz * zImg * 0.25;
                            this.polys[base + np * 2 + 1] = py + dy * zImg * 0.25;
                            np++;
                            clip = k;
                            break;
                        }
                        const sq = Math.sqrt(disc);
                        const t = r > 0 ? -b - sq : -b + sq;
                        if (t < 1e-6) { clip = k; break; }
                        qz = pz + dz * t;
                        qy = py + dy * t;
                        // Dividing by signed r keeps the normal consistently
                        // oriented; the refraction step re-flips as needed.
                        nx = (qz - cz) / r;
                        ny = qy / r;
                    }

                    this.polys[base + np * 2] = qz;
                    this.polys[base + np * 2 + 1] = qy;
                    np++;

                    if (Math.abs(qy) > surf.sd) { clip = k; break; } // vignetted

                    const n2 = surf.nd > 1
                        ? surf.nd + LANE_DELTA[w] * ((surf.nd - 1) / Math.max(surf.vd, 1))
                            * DISPERSION_GAIN * split
                        : 1;
                    const mu = n1 / n2;
                    let cosI = -(dz * nx + dy * ny);
                    if (cosI < 0) { nx = -nx; ny = -ny; cosI = -cosI; }
                    const sin2T = mu * mu * (1 - cosI * cosI);
                    if (sin2T > 1) { clip = k; break; } // TIR
                    const kk = mu * cosI - Math.sqrt(1 - sin2T);
                    dz = mu * dz + kk * nx;
                    dy = mu * dy + kk * ny;
                    const inv = 1 / Math.sqrt(dz * dz + dy * dy);
                    dz *= inv;
                    dy *= inv;
                    n1 = n2;
                    pz = qz;
                    py = qy;
                }

                if (clip < 0 && dz > 1e-9) {
                    const t = (zImg - pz) / dz;
                    const qy = py + dy * t;
                    this.polys[base + np * 2] = zImg;
                    this.polys[base + np * 2 + 1] = qy;
                    np++;
                    if (w === 0) this.imageHits[i] = qy;
                } else {
                    if (clip < 0) clip = nS - 1;
                    if (w === 0) this.imageHits[i] = NaN;
                }
                this.polyLen[rayIdx] = np;
                this.polyClip[rayIdx] = clip;
            }
        }
    }

    private spawnPulse(ray: number, durSec: number, color: string): void {
        if (this.pulses.length >= MAX_PULSES) this.pulses.shift();
        const np = this.polyLen[ray];
        const segs = Math.max(2, np) - 1;
        this.pulses.push({
            ray,
            s: 0,
            speed: segs / Math.max(0.05, durSec),
            color,
            life: 1,
            arrived: false,
        });
    }

    update(dt: number, s: VizServices): void {
        this.vw = s.width;
        this.vh = s.height;
        const {low, mid, high} = s;

        // Smoothed bands feed trace geometry so the fan breathes, not jitters.
        const sm = Math.min(1, dt * 5);
        this.lowSm += (Math.min(1, low) - this.lowSm) * sm;
        this.midSm += (Math.min(1, mid) - this.midSm) * sm;
        this.split += (Math.min(1, high * 1.6) - this.split) * Math.min(1, dt * 3);
        this.driftT += dt;

        // Prescription rotation.
        const want = Math.floor(Math.max(0, s.cycle) / DESIGN_BARS) % LENS_DESIGNS.length;
        if (want !== this.designIdx) {
            this.designIdx = want;
            this.pulses.length = 0;
            this.titleFlash = 1;
            this.refit();
        }

        // Field angle sways slowly; the mid band opens the swing.
        const design = LENS_DESIGNS[this.designIdx];
        const maxField = (design.maxFieldDeg * Math.PI) / 180;
        this.field = Math.sin(this.driftT * 0.35) * maxField * (0.25 + this.midSm * 0.75);

        // Pattern onsets → light pulses riding the d-line rays. Pitched notes
        // map C1..C7 across the fan; unpitched haps hash to a stable ray.
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        if (sync.pattern && sync.phase >= sync.prevPhase) {
            const cps = Math.max(0.05, currentBpm() / 240);
            for (const track of this.tracks.tracks) {
                for (let e = 0; e < track.count; e++) {
                    const begin = track.begins[e];
                    if (begin > sync.prevPhase && begin <= sync.phase) {
                        track.activity = Math.min(1, track.activity + 0.45);
                        const note = track.notes[e];
                        const ray = Number.isFinite(note)
                            ? Math.round(((Math.min(96, Math.max(24, note)) - 24) / 72) * (RAYS - 1))
                            : (track.slot * 5 + Math.floor(begin * 16) * 3) % RAYS;
                        const durCycles = Math.min(1, Math.max(0.05, track.ends[e] - begin));
                        const durSec = Math.min(1.2, Math.max(0.12, durCycles / cps));
                        this.spawnPulse(ray, durSec, track.accentCss);
                    }
                }
            }
        }
        this.tracks.decay(dt);

        // FFT transients: kicks flood the marginal rays + bloom the focal
        // plane, hats fire one fast spark.
        const hits = this.transients.update(dt, low, mid, high);
        if (hits.kick) {
            this.bloom = 1;
            this.spawnPulse(0, 0.25, s.theme.neon);
            this.spawnPulse(RAYS - 1, 0.25, s.theme.neon);
            this.spawnPulse(RAYS >> 1, 0.22, s.theme.active);
        }
        if (hits.hat) {
            const upper = (RAYS >> 1) + 1 + Math.floor(Math.random() * (RAYS >> 1));
            this.spawnPulse(Math.min(RAYS - 1, upper), 0.15, '#ffffff');
        }

        // Advance pulses in point-index space; arrivals at the image plane
        // feed the bloom (vignetted rays just die at the clip point).
        for (let n = this.pulses.length - 1; n >= 0; n--) {
            const pulse = this.pulses[n];
            if (!pulse.arrived) {
                const np = this.polyLen[pulse.ray];
                if (np < 2) { this.pulses.splice(n, 1); continue; }
                pulse.s += pulse.speed * dt;
                if (pulse.s >= np - 1) {
                    pulse.s = np - 1;
                    pulse.arrived = true;
                    if (this.polyClip[pulse.ray] < 0) {
                        this.bloom = Math.min(1.2, this.bloom + 0.35);
                    }
                }
            } else {
                pulse.life -= dt * 5;
                if (pulse.life <= 0) this.pulses.splice(n, 1);
            }
        }
        this.bloom *= Math.exp(-dt * 4);
        this.titleFlash *= Math.exp(-dt * 3);

        // Geometry last so render sees this frame's fan.
        this.trace();
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.scale === 0) this.layout(s);
        if (this.scale === 0) return;

        const theme = s.theme;
        const {width: w} = s;
        const h = s.height;
        const beat = beatEnv(s.cycle * 4);
        const downbeat = beatEnv(s.cycle);
        const design = LENS_DESIGNS[this.designIdx];
        const S = design.surfaces;
        const nS = S.length;
        const scale = this.scale;
        const ox = this.ox;
        const cy = this.cy;
        const sx = (z: number): number => ox + z * scale;
        const sy = (y: number): number => cy - y * scale;

        let zAcc = 0;
        let sdMax = 0;
        for (let k = 0; k < nS; k++) {
            zScratch[k] = zAcc;
            zAcc += S[k].t;
            if (S[k].sd > sdMax) sdMax = S[k].sd;
        }
        const zImg = zAcc;

        const [br, bgc, bb] = theme.borderRgb;
        const [tr, tg, tb] = theme.textRgb;
        const neonRgb = rgbOf(theme.neon, [71, 246, 255]);
        const redRgb = rgbOf(theme.red, [255, 69, 108]);

        // 1. Blueprint grid — world-mm pitch snapped through the transform.
        const pitch = 10 * scale < 7 ? 50 : 10;
        const zw0 = Math.ceil((0 - ox) / scale / pitch) * pitch;
        const zw1 = (w - ox) / scale;
        const yw1 = cy / scale;
        const yw0 = Math.ceil((cy - h) / scale / pitch) * pitch;
        const gMinor = `rgba(${br}, ${bgc}, ${bb}, ${(0.16 + beat * 0.08 + this.bloom * 0.10).toFixed(3)})`;
        const gMajor = `rgba(${br}, ${bgc}, ${bb}, ${(0.34 + beat * 0.10).toFixed(3)})`;
        ctx.lineWidth = 1;
        for (const major of [false, true]) {
            ctx.strokeStyle = major ? gMajor : gMinor;
            ctx.beginPath();
            for (let z = zw0; z <= zw1; z += pitch) {
                if ((Math.round(z) % 50 === 0) !== major) continue;
                const x = sx(z);
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
            }
            for (let y = yw0; y <= yw1; y += pitch) {
                if ((Math.round(y) % 50 === 0) !== major) continue;
                const yy = sy(y);
                ctx.moveTo(0, yy);
                ctx.lineTo(w, yy);
            }
            ctx.stroke();
        }

        // 2. Optical axis — dash-dot centerline, lifting with the beat.
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.4 + beat * 0.25).toFixed(3)})`;
        ctx.setLineDash([12, 5, 2, 5]);
        ctx.beginPath();
        ctx.moveTo(16, cy);
        ctx.lineTo(Math.min(w - 16, sx(zImg) + 28), cy);
        ctx.stroke();
        ctx.setLineDash([]);

        // Surface vertex ticks + numbers along the axis.
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.4)`;
        ctx.font = `8px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.35)`;
        ctx.beginPath();
        for (let k = 0; k < nS; k++) {
            const x = sx(zScratch[k]);
            ctx.moveTo(x, cy - 3);
            ctx.lineTo(x, cy + 3);
        }
        ctx.stroke();
        for (let k = 0; k < nS; k++) {
            ctx.fillText(String(k + 1), sx(zScratch[k]), cy + 12 + (k % 2) * 9);
        }

        // 3. Glass elements — sagged front/back profiles, flat edges. Cemented
        // interfaces show up as the shared internal hairline.
        const glassFill = `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${(0.05 + this.lowSm * 0.05).toFixed(3)})`;
        const glassStroke = `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, 0.5)`;
        const steps = 16;
        for (let k = 0; k < nS - 1; k++) {
            if (S[k].nd <= 1) continue;
            const sdF = S[k].sd;
            const sdB = S[k + 1].sd;
            const zF = zScratch[k];
            const zB = zScratch[k + 1];
            ctx.beginPath();
            for (let m = 0; m <= steps; m++) {
                const y = -sdF + (2 * sdF * m) / steps;
                const x = sx(zF + sagZ(S[k].r, y));
                if (m === 0) ctx.moveTo(x, sy(y));
                else ctx.lineTo(x, sy(y));
            }
            for (let m = steps; m >= 0; m--) {
                const y = -sdB + (2 * sdB * m) / steps;
                ctx.lineTo(sx(zB + sagZ(S[k + 1].r, y)), sy(y));
            }
            ctx.closePath();
            ctx.fillStyle = glassFill;
            ctx.fill();
            ctx.strokeStyle = glassStroke;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // 4. Aperture-stop blades — hatched, brightening on the beat.
        for (let k = 0; k < nS; k++) {
            if (!S[k].stop) continue;
            const bx = sx(zScratch[k]);
            const sd = S[k].sd;
            const ext = Math.min(6, sd * 0.8);
            ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.5 + beat * 0.3).toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (const sign of [1, -1]) {
                ctx.moveTo(bx, sy(sign * sd));
                ctx.lineTo(bx, sy(sign * (sd + ext)));
                // Blade tip tick at the aperture edge.
                ctx.moveTo(bx - 4, sy(sign * sd));
                ctx.lineTo(bx + 4, sy(sign * sd));
            }
            ctx.stroke();
            // 45° hatching on the outer side of each blade.
            ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.3 + beat * 0.15).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (const sign of [1, -1]) {
                for (let m = 1; m <= 4; m++) {
                    const yy = sy(sign * (sd + (ext * m) / 5));
                    ctx.moveTo(bx, yy);
                    ctx.lineTo(bx + 7, yy - sign * 7);
                }
            }
            ctx.stroke();
        }

        // 5. Rays — one batched path per wavelength lane; d-line drawn last so
        // the reference trace sits on top of the chromatic fringe.
        const laneColors = [
            `rgba(${tr}, ${tg}, ${tb}, ${(0.12 + this.midSm * 0.16).toFixed(3)})`,
            `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${(this.split * (0.08 + s.high * 0.16)).toFixed(3)})`,
            `rgba(${redRgb[0]}, ${redRgb[1]}, ${redRgb[2]}, ${(this.split * (0.08 + s.high * 0.16)).toFixed(3)})`,
        ];
        ctx.lineWidth = 1;
        for (let lane = LANES - 1; lane >= 0; lane--) {
            ctx.strokeStyle = laneColors[lane];
            ctx.beginPath();
            for (let i = 0; i < RAYS; i++) {
                const rayIdx = lane * RAYS + i;
                const np = this.polyLen[rayIdx];
                if (np < 2) continue;
                const end = this.polyClip[rayIdx] >= 0 ? np - 1 : np;
                const base = rayIdx * MAX_PTS * 2;
                ctx.moveTo(sx(this.polys[base]), sy(this.polys[base + 1]));
                for (let m = 1; m < end; m++) {
                    ctx.lineTo(sx(this.polys[base + m * 2]), sy(this.polys[base + m * 2 + 1]));
                }
            }
            ctx.stroke();
            // Dimmed final segments of vignetted/dead rays.
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            for (let i = 0; i < RAYS; i++) {
                const rayIdx = lane * RAYS + i;
                const np = this.polyLen[rayIdx];
                if (np < 2 || this.polyClip[rayIdx] < 0) continue;
                const base = rayIdx * MAX_PTS * 2;
                ctx.moveTo(sx(this.polys[base + (np - 2) * 2]), sy(this.polys[base + (np - 2) * 2 + 1]));
                ctx.lineTo(sx(this.polys[base + (np - 1) * 2]), sy(this.polys[base + (np - 1) * 2 + 1]));
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // 6. Pulses riding the d-line rays — short trail + hot dot.
        for (const pulse of this.pulses) {
            const np = this.polyLen[pulse.ray];
            if (np < 2) continue;
            const base = pulse.ray * MAX_PTS * 2;
            const sPos = Math.min(pulse.s, np - 1.001);
            const alpha = pulse.arrived ? pulse.life : 1;
            const at = (t: number): [number, number] => {
                const i0 = Math.min(np - 2, Math.floor(t));
                const f = t - i0;
                return [
                    sx(this.polys[base + i0 * 2] + (this.polys[base + (i0 + 1) * 2] - this.polys[base + i0 * 2]) * f),
                    sy(this.polys[base + i0 * 2 + 1] + (this.polys[base + (i0 + 1) * 2 + 1] - this.polys[base + i0 * 2 + 1]) * f),
                ];
            };
            const [px, py] = at(sPos);
            const [qx, qy] = at(Math.max(0, sPos - 0.5));
            ctx.strokeStyle = pulse.color;
            ctx.globalAlpha = 0.55 * alpha;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(qx, qy);
            ctx.lineTo(px, py);
            ctx.stroke();
            ctx.fillStyle = pulse.color;
            ctx.globalAlpha = 0.2 * alpha;
            ctx.beginPath();
            ctx.arc(px, py, 4.5, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 0.95 * alpha;
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 7. Image plane + focal bloom sized by the live RMS spot.
        const imgX = sx(zImg);
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.45)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(imgX, sy(sdMax * 1.15));
        ctx.lineTo(imgX, sy(-sdMax * 1.15));
        ctx.stroke();
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.5)`;
        ctx.font = `8px ${MONO}`;
        ctx.fillText('IMG', imgX, sy(sdMax * 1.15) - 4);

        let sum = 0, sum2 = 0, cnt = 0;
        for (let i = 0; i < RAYS; i++) {
            const v = this.imageHits[i];
            if (Number.isFinite(v)) { sum += v; sum2 += v * v; cnt++; }
        }
        if (cnt > 0) {
            const mean = sum / cnt;
            const rms = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
            const radius = 6 + rms * scale * 2 + this.bloom * 26;
            const grad = ctx.createRadialGradient(imgX, sy(mean), 0, imgX, sy(mean), radius);
            grad.addColorStop(0, `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${(0.12 + this.bloom * 0.45).toFixed(3)})`);
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(imgX, sy(mean), radius, 0, TAU);
            ctx.fill();
        }

        // 8. Glass callouts with leader lines, staggered on two rows.
        ctx.font = `10px ${MONO}`;
        ctx.textAlign = 'center';
        let runIdx = 0;
        for (let k = 0; k < nS - 1; k++) {
            if (S[k].nd <= 1 || !S[k].glass) continue;
            // Only the first surface of a cemented run gets the label.
            if (k > 0 && S[k - 1].nd > 1 && S[k - 1].glass === S[k].glass) continue;
            const runEnd = k + 1;
            const cxEl = (sx(zScratch[k]) + sx(zScratch[runEnd])) / 2;
            const topY = sy(Math.max(S[k].sd, S[runEnd].sd));
            const labelY = 30 + (runIdx % 2) * 13;
            ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.55 + downbeat * 0.3).toFixed(3)})`;
            ctx.fillText(S[k].glass!, cxEl, labelY);
            ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.25)`;
            ctx.beginPath();
            ctx.moveTo(cxEl, labelY + 3);
            ctx.lineTo(cxEl, topY - 3);
            ctx.stroke();
            runIdx++;
        }

        // 9. Readout strip + title block.
        ctx.textAlign = 'left';
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.7)`;
        const fieldDeg = ((this.field * 180) / Math.PI).toFixed(1);
        ctx.fillText(
            `${design.efl}   ${design.fno}   FIELD ${fieldDeg}°   λ-SPLIT ${this.split.toFixed(2)}`,
            48, 18,
        );

        const tbW = 224;
        const tbH = 52;
        const tbX = w - 48 - tbW;
        const tbY = h - 18 - tbH;
        ctx.strokeStyle = `rgba(${br}, ${bgc}, ${bb}, 0.9)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(tbX, tbY, tbW, tbH);
        ctx.beginPath();
        ctx.moveTo(tbX, tbY + 18);
        ctx.lineTo(tbX + tbW, tbY + 18);
        ctx.stroke();
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.9)`;
        ctx.fillText(design.name, tbX + 8, tbY + 13);
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.5)`;
        ctx.font = `9px ${MONO}`;
        ctx.fillText(design.sheet, tbX + 8, tbY + 31);
        ctx.fillText(
            `BAR ${Math.max(0, Math.floor(s.cycle))}   SCALE ${scale.toFixed(2)}px/mm`,
            tbX + 8, tbY + 45,
        );
        const flash = 0.3 + this.titleFlash * 0.5 + downbeat * 0.2;
        ctx.fillStyle = `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${flash.toFixed(3)})`;
        ctx.fillRect(tbX, tbY + tbH, tbW, 2);
    }
}

export const lensBenchDef: VizModeDef = {
    id: 'lens-bench',
    name: 'LENS BENCH',
    create: () => new LensBenchMode(),
};
