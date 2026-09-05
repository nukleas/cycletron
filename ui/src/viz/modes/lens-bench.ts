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
    /**
     * Published focal length in mm. At load the prescription is scaled
     * uniformly so its paraxial EFL equals this (a lens scaled by k has EFL
     * k·f and the same aberration *shape*), and the image plane is moved to
     * the paraxial focus. Omit for afocal/diverging designs.
     */
    efl?: number;
    /**
     * Published working f-number. Caps the fan at efl / (2·fno) when the
     * prescription's apertures would pass a faster bundle (fixture stops are
     * often oversized); the trace's own marginal ray is the limit otherwise.
     */
    fno?: number;
    /** Readout override for designs with no real focus ("VIRTUAL FOCUS"). */
    focusLabel?: string;
    maxFieldDeg: number;
    /** Afocal/diverging designs terminate at a display screen, not a focus. */
    screen?: boolean;
    /** Fixed world-space framing for expanding beams; avoids audio-driven zoom. */
    viewSemiDiameter?: number;
    surfaces: LensSurface[];
}

/** Numbers the bench derives from the prescription itself, never typed in. */
interface DesignOptics {
    /** Paraxial effective focal length at the d line, mm. */
    efl: number;
    /** Paraxial back focal distance from the last vertex, mm. */
    bfl: number;
    /** Tallest on-axis launch height that clears every clear aperture. */
    hMax: number;
    /** Working f-number at full aperture, efl / (2·hMax). */
    fno: number;
    /** Sum of thicknesses: the z of the image plane / screen. */
    zImg: number;
    /** z of the last vertex; readouts measure focus from here. */
    lastVertex: number;
    /**
     * z of the real best focus (circle of least confusion of the on-axis
     * fan) — the image plane for focusing designs, an internal crossing for
     * an afocal pair. NaN when the bundle never converges.
     */
    focusZ: number;
    /** RMS spot radius at that focus, mm. */
    focusRms: number;
    /**
     * For a diverging bundle: z where the exit rays' backward extensions
     * meet (least squares) — the virtual focus a textbook draws dashed.
     */
    virtualFocusZ: number;
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
        efl: 100,
        fno: 4,
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
        efl: 50,
        fno: 4,
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
        efl: 50,
        fno: 2,
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
    // Manufacturer geometry and derived bench distances: docs/LENS_BENCH.md.
    {
        name: 'FAST CONDENSER 30mm',
        sheet: 'EO 70-265 · PCX',
        efl: 30,
        fno: 1.2,
        maxFieldDeg: 4,
        surfaces: [
            { r: 15.50, t: 8.06, nd: 1.5168, vd: 64.17, sd: 11.10, glass: 'N-BK7' },
            { r: 0, t: 24.69, nd: 1, vd: 0, sd: 11.10 },
        ],
    },
    {
        name: 'DIVERGING FAN -50mm',
        sheet: 'EO 45-028 · PCV',
        maxFieldDeg: 4,
        screen: true,
        viewSemiDiameter: 30,
        surfaces: [
            { r: -25.84, t: 3.50, nd: 1.5168, vd: 64.17, sd: 12, glass: 'N-BK7' },
            // Positive display distance, NOT the manufacturer's negative BFL.
            { r: 0, t: 35, nd: 1, vd: 0, sd: 12 },
        ],
    },
    {
        name: 'KEPLERIAN CROSSOVER',
        sheet: 'DERIVED · 2× EO 47-368',
        focusLabel: 'INVERTING',
        maxFieldDeg: 1,
        screen: true,
        surfaces: [
            { r: 50.80, t: 5, nd: 1.5168, vd: 64.17, sd: 12, glass: 'N-BK7' },
            // Symmetric lenses: air gap = twice the published 48.29mm BFL.
            { r: -50.80, t: 96.58, nd: 1, vd: 0, sd: 12 },
            { r: 50.80, t: 5, nd: 1.5168, vd: 64.17, sd: 12, glass: 'N-BK7' },
            { r: -50.80, t: 40, nd: 1, vd: 0, sd: 12 },
        ],
    },
];

const RAYS = 15;              // rays per fan, per wavelength lane
const LANES = 3;              // d (reference), F (blue), C (red)
/**
 * Index offset per lane in units of (n_d − 1) / V_d, i.e. the glass's own
 * F−C dispersion. For normal crown/flint glass the d line sits about 31% of
 * the way up from C to F (N-BK7: n_C 1.51432, n_d 1.51680, n_F 1.52238), so
 * F is +0.69 and C is −0.31 of the F−C spread. Real values: an achromat's
 * lanes land on top of each other, a singlet's fan out — which is the point.
 */
const LANE_DELTA = [0, 0.69, -0.31];
const MAX_PULSES = 64;
const DESIGN_BARS = 16;       // bars per prescription before rotating
/** Points per ray: launch + one per surface (max 10) + image plane. */
const MAX_PTS = 12;

interface Pulse {
    /** Ray index in the d-line lane the pulse rides. */
    ray: number;
    /** Distance travelled along the ray in world millimetres. */
    s: number;
    speed: number;
    color: string;
    /** 1 while travelling; fades out after arrival. */
    life: number;
    arrived: boolean;
}

/**
 * Paraxial (y, u) trace of a marginal ray from infinity at the d line.
 * Returns EFL and the back focal distance from the last vertex; both are
 * ±Infinity for an afocal system.
 */
function paraxial(S: LensSurface[]): {efl: number; bfl: number} {
    let n1 = 1;
    let y = 1;
    let u = 0;
    for (let k = 0; k < S.length; k++) {
        const n2 = S[k].nd;
        const c = S[k].r === 0 || Math.abs(S[k].r) > 1e6 ? 0 : 1 / S[k].r;
        u = (n1 * u - y * (n2 - n1) * c) / n2;
        if (k < S.length - 1) y += u * S[k].t;
        n1 = n2;
    }
    // A nominally afocal pair traces to a focal length of tens of metres
    // through rounding; anything beyond a few metres is afocal on a bench.
    if (Math.abs(u) < 1e-12 || Math.abs(1 / u) > 5000) return {efl: Infinity, bfl: Infinity};
    return {efl: -1 / u, bfl: -y / u};
}

/**
 * Trace one meridional ray through `S` (vertex z's in `zs`, image plane at
 * `zImg`), launched at height `y1` at z=0 with slope `slope`. `lane` picks
 * the wavelength via LANE_DELTA. With `out`, the polyline (z, y) pairs are
 * written at `base` and the point count returned in `np`; `clip` is the
 * surface index where the ray died, −1 if it reached the image plane, and
 * `yImg` its height there.
 */
function traceRay(
    S: LensSurface[], zs: Float64Array, zImg: number, zStart: number,
    y1: number, slope: number, lane: number,
    out: Float32Array | null, base: number,
): {np: number; clip: number; yImg: number} {
    const dirLen = Math.sqrt(1 + slope * slope);
    let pz = zStart;
    let py = y1 + slope * zStart;
    let dz = 1 / dirLen;
    let dy = slope / dirLen;
    let n1 = 1;
    let np = 1;
    let clip = -1;
    if (out) { out[base] = pz; out[base + 1] = py; }

    for (let k = 0; k < S.length; k++) {
        const surf = S[k];
        const r = surf.r;
        const Zk = zs[k];
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
            // Sphere centered on-axis at Zk + r. Root choice picks the
            // vertex-side intersection for either curvature sign.
            const cz = Zk + r;
            const ocz = pz - cz;
            const b = dz * ocz + dy * py;
            const c = ocz * ocz + py * py - r * r;
            const disc = b * b - c;
            if (disc < 0) {
                // Missed the surface sphere — visibly fly off.
                if (out) {
                    out[base + np * 2] = pz + dz * zImg * 0.25;
                    out[base + np * 2 + 1] = py + dy * zImg * 0.25;
                }
                np++;
                clip = k;
                break;
            }
            const sq = Math.sqrt(disc);
            const t = r > 0 ? -b - sq : -b + sq;
            if (t < 1e-6) { clip = k; break; }
            qz = pz + dz * t;
            qy = py + dy * t;
            // Dividing by signed r keeps the normal consistently oriented;
            // the refraction step re-flips as needed.
            nx = (qz - cz) / r;
            ny = qy / r;
        }

        if (out) { out[base + np * 2] = qz; out[base + np * 2 + 1] = qy; }
        np++;

        if (Math.abs(qy) > surf.sd) { clip = k; break; } // vignetted

        const n2 = surf.nd > 1
            ? surf.nd + LANE_DELTA[lane] * ((surf.nd - 1) / Math.max(surf.vd, 1))
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

    let yImg = NaN;
    if (clip < 0 && dz > 1e-9) {
        const t = (zImg - pz) / dz;
        yImg = py + dy * t;
        if (out) { out[base + np * 2] = zImg; out[base + np * 2 + 1] = yImg; }
        np++;
    } else if (clip < 0) {
        clip = S.length - 1;
    }
    return {np, clip, yImg};
}

/**
 * Height of a traced ray at axial position z, interpolated along its
 * polyline and extended along its first / last segment beyond the ends —
 * so the same call serves a focus inside the system, at the image plane, or
 * a virtual focus behind the lens.
 */
function yAtZ(polys: Float32Array, base: number, np: number, z: number): number {
    if (np < 2) return NaN;
    let j = 1;
    while (j < np - 1 && polys[base + j * 2] < z) j++;
    const z0 = polys[base + (j - 1) * 2];
    const y0 = polys[base + (j - 1) * 2 + 1];
    const z1 = polys[base + j * 2];
    const y1 = polys[base + j * 2 + 1];
    if (z1 === z0) return y0;
    return y0 + (y1 - y0) * (z - z0) / (z1 - z0);
}

/** RMS of the lane-0 fan's heights at z (rays that reached the image plane). */
function fanRmsAt(polys: Float32Array, polyLen: Uint8Array, polyClip: Int8Array | Int16Array, z: number): number {
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < RAYS; i++) {
        if (polyClip[i] >= 0) continue;
        const y = yAtZ(polys, i * MAX_PTS * 2, polyLen[i], z);
        if (Number.isFinite(y)) { sum2 += y * y; n++; }
    }
    return n > 0 ? Math.sqrt(sum2 / n) : NaN;
}

/**
 * Normalise a prescription in place and derive its optics. Designs with a
 * published `efl` are scaled so the trace agrees with the label, and every
 * focusing design gets its image plane at the paraxial focus — typed image
 * distances are how a bench ends up showing a blur at "IMG". The marginal
 * height is found by bisection on the real trace so the fan fills the
 * working aperture with no vignetting on axis.
 */
function prepareDesign(design: LensDesign): DesignOptics {
    const S = design.surfaces;
    if (design.efl !== undefined && !design.screen) {
        const k = design.efl / paraxial(S).efl;
        for (const surf of S) {
            surf.r *= k;
            surf.t *= k;
            surf.sd *= k;
        }
        if (design.viewSemiDiameter !== undefined) design.viewSemiDiameter *= k;
    }
    let {efl, bfl} = paraxial(S);
    if (!design.screen && Number.isFinite(bfl) && bfl > 0) {
        S[S.length - 1].t = bfl;
    }
    let zImg = 0;
    const zs = new Float64Array(S.length);
    for (let k = 0; k < S.length; k++) {
        zs[k] = zImg;
        zImg += S[k].t;
    }
    const zStart = -0.18 * zImg;
    let lo = 0;
    let hi = S[0].sd * 1.01;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (traceRay(S, zs, zImg, zStart, mid, 0, 0, null, 0).clip < 0) lo = mid;
        else hi = mid;
    }
    if (!Number.isFinite(efl)) { efl = Infinity; bfl = Infinity; }
    const hMax = design.fno !== undefined && efl > 0
        ? Math.min(lo, efl / (2 * design.fno))
        : lo;
    const lastVertex = zs[S.length - 1];

    // Where does the on-axis fan at full aperture actually come together?
    // Scan the RMS spot along the bench: the minimum is the circle of least
    // confusion — ahead of paraxial focus for a lens with spherical
    // aberration, between the elements for a Keplerian pair. If the fan
    // never tightens (a negative lens) the exit rays' backward extensions
    // give the virtual focus instead.
    const fan = new Float32Array(RAYS * MAX_PTS * 2);
    const fanLen = new Uint8Array(RAYS);
    const fanClip = new Int16Array(RAYS);
    let launchRms = 0;
    for (let i = 0; i < RAYS; i++) {
        const y1 = ((i / (RAYS - 1)) * 2 - 1) * hMax;
        const hit = traceRay(S, zs, zImg, zStart, y1, 0, 0, fan, i * MAX_PTS * 2);
        fanLen[i] = hit.np;
        fanClip[i] = hit.clip;
        launchRms += y1 * y1;
    }
    launchRms = Math.sqrt(launchRms / RAYS);
    let focusZ = NaN;
    let focusRms = Infinity;
    const steps = 600;
    for (let k = 0; k <= steps; k++) {
        const z = (zImg * k) / steps;
        const rms = fanRmsAt(fan, fanLen, fanClip, z);
        if (rms < focusRms) { focusRms = rms; focusZ = z; }
    }
    for (let k = -40; k <= 40; k++) {
        const z = focusZ + (k / 40) * (zImg / steps);
        const rms = fanRmsAt(fan, fanLen, fanClip, z);
        if (rms < focusRms) { focusRms = rms; focusZ = z; }
    }
    // A real focus is a bundle that has actually converged, not the least
    // bad spot of one that only ever spreads.
    const converges = focusRms < 0.2 * launchRms;
    let virtualFocusZ = NaN;
    if (!converges) {
        focusZ = NaN;
        focusRms = NaN;
        let sab = 0;
        let sbb = 0;
        for (let i = 0; i < RAYS; i++) {
            const np = fanLen[i];
            if (fanClip[i] >= 0 || np < 2) continue;
            const base = i * MAX_PTS * 2;
            const z0 = fan[base + (np - 2) * 2], y0 = fan[base + (np - 2) * 2 + 1];
            const z1 = fan[base + (np - 1) * 2], y1 = fan[base + (np - 1) * 2 + 1];
            const b = (y1 - y0) / (z1 - z0);
            const a = y0 - b * z0;
            sab += a * b;
            sbb += b * b;
        }
        if (sbb > 0) {
            const zls = -sab / sbb;
            if (zls < lastVertex) virtualFocusZ = zls;
        }
    }
    // Focusing designs image at best focus, not at the paraxial plane.
    if (!design.screen && converges && focusZ > lastVertex) {
        S[S.length - 1].t = focusZ - lastVertex;
        zImg = focusZ;
    }
    return {efl, bfl, hMax, fno: efl / (2 * hMax), zImg, lastVertex, focusZ, focusRms, virtualFocusZ};
}

const DESIGN_OPTICS: DesignOptics[] = LENS_DESIGNS.map(prepareDesign);

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
    /** Live centroid / spread of the d-line fan at the design's focus. */
    private focusY = NaN;
    private focusRms = NaN;
    private pulses: Pulse[] = [];
    private bloom = 0;
    private readonly distances = new Float32Array(RAYS * MAX_PTS);
    // Fixed ring pool: dense passages cannot grow rendering work indefinitely.
    private readonly impactAge = new Float32Array(8).fill(1);
    private readonly impactY = new Float32Array(8);
    private nextImpact = 0;
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
        const optics = DESIGN_OPTICS[this.designIdx];
        const zMin = Number.isFinite(optics.virtualFocusZ)
            ? Math.min(-0.18 * zImg, optics.virtualFocusZ - 0.06 * zImg)
            : -0.18 * zImg;
        const zMax = zImg * 1.04;
        const yMax = design.viewSemiDiameter ?? sdMax * 1.3;
        // Blueprint margins for the callout strip and title block, shrunk
        // proportionally so the sidebar-sized canvas still shows a bench.
        const mL = Math.min(48, this.vw * 0.06), mR = mL;
        const mT = Math.min(56, this.vh * 0.18), mB = Math.min(76, this.vh * 0.26);
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
        const optics = DESIGN_OPTICS[this.designIdx];
        const S = design.surfaces;
        let z = 0;
        for (let k = 0; k < S.length; k++) {
            zScratch[k] = z;
            z += S[k].t;
        }
        const zImg = z;
        const zStart = -0.18 * zImg;
        // The fan fills 70–100% of the working aperture with the low band, so
        // the loudest state is the lens wide open and nothing vignettes on axis.
        const fill = 0.7 + this.lowSm * 0.3;
        const slope = -Math.tan(this.field);
        const split = this.split;

        for (let w = 0; w < LANES; w++) {
            // Chromatic lanes only exist while the highs hold them open. Their
            // geometry is physical whenever they are drawn; `split` is opacity.
            const laneOn = w === 0 || split > 0.015;
            for (let i = 0; i < RAYS; i++) {
                const rayIdx = w * RAYS + i;
                if (!laneOn) {
                    this.polyLen[rayIdx] = 0;
                    continue;
                }
                const base = rayIdx * MAX_PTS * 2;
                const p = (i / (RAYS - 1)) * 2 - 1;
                const y1 = p * optics.hMax * fill;
                const hit = traceRay(S, zScratch, zImg, zStart, y1, slope, w, this.polys, base);
                this.polyLen[rayIdx] = hit.np;
                this.polyClip[rayIdx] = hit.clip;
                if (w === 0) this.imageHits[i] = hit.yImg;
            }
        }

        // Where the fan is tightest this frame: the field angle slides the
        // focus laterally, so read it off the live rays rather than the
        // on-axis number. A virtual focus is read off the exit rays'
        // backward extensions.
        const fz = Number.isFinite(optics.focusZ) ? optics.focusZ : optics.virtualFocusZ;
        if (Number.isFinite(fz)) {
            let sum = 0, sum2 = 0, n = 0;
            for (let i = 0; i < RAYS; i++) {
                if (this.polyClip[i] >= 0) continue;
                const y = yAtZ(this.polys, i * MAX_PTS * 2, this.polyLen[i], fz);
                if (!Number.isFinite(y)) continue;
                sum += y; sum2 += y * y; n++;
            }
            this.focusY = n > 0 ? sum / n : NaN;
            this.focusRms = n > 0 ? Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) : NaN;
        } else {
            this.focusY = NaN;
            this.focusRms = NaN;
        }
    }

    private spawnPulse(ray: number, durSec: number, color: string): void {
        if (this.pulses.length >= MAX_PULSES) this.pulses.shift();
        const np = this.polyLen[ray];
        if (np < 2) return;
        const length = this.distances[ray * MAX_PTS + np - 1];
        if (length <= 0) return;
        this.pulses.push({
            ray,
            s: 0,
            speed: length / Math.max(0.05, durSec),
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
            this.impactAge.fill(1);
            this.bloom = 0;
            this.titleFlash = 1;
            this.refit();
        }

        // Field angle sways slowly; the mid band opens the swing.
        const design = LENS_DESIGNS[this.designIdx];
        const maxField = (design.maxFieldDeg * Math.PI) / 180;
        this.field = Math.sin(this.driftT * 0.35) * maxField * (0.25 + this.midSm * 0.75);

        // Trace before spawning and advancing so lengths and clipping agree
        // with the geometry displayed this frame (including prescription changes).
        this.trace();
        for (let ray = 0; ray < RAYS; ray++) {
            const base = ray * MAX_PTS * 2;
            const offset = ray * MAX_PTS;
            this.distances[offset] = 0;
            for (let j = 1; j < this.polyLen[ray]; j++) {
                this.distances[offset + j] = this.distances[offset + j - 1] + Math.hypot(
                    this.polys[base + j * 2] - this.polys[base + (j - 1) * 2],
                    this.polys[base + j * 2 + 1] - this.polys[base + (j - 1) * 2 + 1]);
            }
        }
        for (let i = 0; i < this.impactAge.length; i++) this.impactAge[i] += dt;

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

        // FFT transients: kicks flood the marginal rays; their arrivals light
        // the focal plane. Hats fire one fast spark.
        const hits = this.transients.update(dt, low, mid, high);
        if (hits.kick) {
            this.spawnPulse(0, 0.25, s.theme.neon);
            this.spawnPulse(RAYS - 1, 0.25, s.theme.neon);
            this.spawnPulse(RAYS >> 1, 0.22, s.theme.active);
        }
        if (hits.hat) {
            const upper = (RAYS >> 1) + 1 + Math.floor(Math.random() * (RAYS >> 1));
            this.spawnPulse(Math.min(RAYS - 1, upper), 0.15, '#ffffff');
        }

        // Advance at constant world-space speed; arrivals at the image plane
        // feed the bloom (vignetted rays just die at the clip point).
        for (let n = this.pulses.length - 1; n >= 0; n--) {
            const pulse = this.pulses[n];
            if (!pulse.arrived) {
                const np = this.polyLen[pulse.ray];
                if (np < 2) { this.pulses.splice(n, 1); continue; }
                pulse.s += pulse.speed * dt;
                const length = this.distances[pulse.ray * MAX_PTS + np - 1];
                if (pulse.s >= length) {
                    pulse.s = length;
                    pulse.arrived = true;
                    if (this.polyClip[pulse.ray] < 0) {
                        this.bloom = Math.min(1.2, this.bloom + 0.35);
                        this.impactAge[this.nextImpact] = 0;
                        this.impactY[this.nextImpact] = this.imageHits[pulse.ray];
                        this.nextImpact = (this.nextImpact + 1) % this.impactAge.length;
                    }
                }
            } else {
                pulse.life -= dt * 5;
                if (pulse.life <= 0) this.pulses.splice(n, 1);
            }
        }
        this.bloom *= Math.exp(-dt * 4);
        this.titleFlash *= Math.exp(-dt * 3);

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
            `rgba(${tr}, ${tg}, ${tb}, ${(0.18 + this.midSm * 0.16).toFixed(3)})`,
            `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${(this.split * (0.16 + this.split * 0.2)).toFixed(3)})`,
            `rgba(${redRgb[0]}, ${redRgb[1]}, ${redRgb[2]}, ${(this.split * (0.16 + this.split * 0.2)).toFixed(3)})`,
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

        // Three principal rays provide a bright, legible optical silhouette.
        ctx.strokeStyle = theme.neon;
        ctx.globalAlpha = 0.4 + this.lowSm * 0.25;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let ray = 0; ray < RAYS; ray += (RAYS - 1) / 2) {
            const np = this.polyLen[ray];
            const end = this.polyClip[ray] >= 0 ? np - 1 : np;
            const base = ray * MAX_PTS * 2;
            for (let j = 0; j < end; j++) {
                const x = sx(this.polys[base + j * 2]);
                const y = sy(this.polys[base + j * 2 + 1]);
                if (j === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // 6. Distance-clipped tails follow every refraction bend. No per-pulse
        // coordinate arrays; the same path supplies a soft sheath and hot core.
        for (const pulse of this.pulses) {
            const np = this.polyLen[pulse.ray];
            if (np < 2) continue;
            const base = pulse.ray * MAX_PTS * 2;
            const offset = pulse.ray * MAX_PTS;
            const head = Math.min(pulse.s, this.distances[offset + np - 1]);
            const tail = Math.max(0, head - Math.min(48 / scale, pulse.speed * 0.065));
            const alpha = pulse.arrived ? pulse.life : 1;
            let px = sx(this.polys[base]), py = sy(this.polys[base + 1]);
            let started = false;
            ctx.beginPath();
            for (let j = 1; j < np; j++) {
                const start = this.distances[offset + j - 1];
                const end = this.distances[offset + j];
                if (end < tail || start > head || end <= start) continue;
                const from = Math.max(0, (tail - start) / (end - start));
                const to = Math.min(1, (head - start) / (end - start));
                const z = this.polys[base + (j - 1) * 2];
                const y = this.polys[base + (j - 1) * 2 + 1];
                const dz = this.polys[base + j * 2] - z;
                const dy = this.polys[base + j * 2 + 1] - y;
                if (!started) { ctx.moveTo(sx(z + dz * from), sy(y + dy * from)); started = true; }
                px = sx(z + dz * to);
                py = sy(y + dy * to);
                ctx.lineTo(px, py);
            }
            ctx.strokeStyle = pulse.color;
            ctx.globalAlpha = 0.14 * alpha;
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.globalAlpha = 0.85 * alpha;
            ctx.lineWidth = 1.7;
            ctx.stroke();
            ctx.fillStyle = pulse.color;
            ctx.globalAlpha = 0.2 * alpha;
            ctx.beginPath();
            ctx.arc(px, py, 4.5, 0, TAU);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.95 * alpha;
            ctx.beginPath();
            ctx.arc(px, py, 1.7, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        // 7. Image plane + focal bloom sized by the live RMS spot.
        const imgX = sx(zImg);
        ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.45)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const planeHeight = design.screen ? (design.viewSemiDiameter ?? sdMax * 1.3) * 0.9 : sdMax * 1.15;
        ctx.moveTo(imgX, sy(planeHeight));
        ctx.lineTo(imgX, sy(-planeHeight));
        ctx.stroke();
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.5)`;
        ctx.font = `8px ${MONO}`;
        ctx.fillText(design.screen ? 'SCREEN' : 'IMG', imgX, sy(planeHeight) - 4);

        let sum = 0, sum2 = 0, cnt = 0;
        for (let i = 0; i < RAYS; i++) {
            const v = this.imageHits[i];
            if (Number.isFinite(v)) { sum += v; sum2 += v * v; cnt++; }
        }
        if (design.screen) {
            // Show the actual spread at the observation plane, not an invented
            // bright focus at the centroid of a divergent or collimated bundle.
            ctx.strokeStyle = theme.neon;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            for (let i = 0; i < RAYS; i++) {
                if (!Number.isFinite(this.imageHits[i])) continue;
                const y = sy(this.imageHits[i]);
                ctx.moveTo(imgX - 3, y);
                ctx.lineTo(imgX + 3, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        // The focus marker follows the trace: at the image plane for a
        // focusing design (now placed at best focus), between the elements for
        // an afocal pair, and behind the lens — with the exit rays projected
        // back as dashed lines — for a diverging one.
        const optics = DESIGN_OPTICS[this.designIdx];
        const virtual = !Number.isFinite(optics.focusZ) && Number.isFinite(optics.virtualFocusZ);
        const fz = virtual ? optics.virtualFocusZ : optics.focusZ;
        if (Number.isFinite(fz) && Number.isFinite(this.focusY)) {
            const fx = sx(fz);
            const focalY = sy(this.focusY);
            if (virtual) {
                ctx.save();
                ctx.setLineDash([3, 4]);
                ctx.strokeStyle = theme.neon;
                ctx.globalAlpha = 0.28;
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let i = 0; i < RAYS; i++) {
                    const np = this.polyLen[i];
                    if (this.polyClip[i] >= 0 || np < 2) continue;
                    const base = i * MAX_PTS * 2;
                    const y = yAtZ(this.polys, base, np, fz);
                    if (!Number.isFinite(y)) continue;
                    ctx.moveTo(sx(this.polys[base + (np - 2) * 2]), sy(this.polys[base + (np - 2) * 2 + 1]));
                    ctx.lineTo(fx, sy(y));
                }
                ctx.stroke();
                ctx.restore();
            }
            const rms = virtual ? 0 : this.focusRms;
            const radius = 6 + rms * scale * 2 + this.bloom * 26;
            const grad = ctx.createRadialGradient(fx, focalY, 0, fx, focalY, radius);
            grad.addColorStop(0, `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${(0.12 + this.bloom * 0.45).toFixed(3)})`);
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(fx, focalY, radius, 0, TAU);
            ctx.fill();
            // Local flare uses crisp strokes, keeping the beam's landing point
            // readable without a canvas-wide blur or compositing pass.
            const flare = 5 + Math.min(1, this.bloom) * 30;
            ctx.strokeStyle = theme.neon;
            ctx.globalAlpha = 0.2 + Math.min(1, this.bloom) * 0.45;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(fx, focalY - flare);
            ctx.lineTo(fx, focalY + flare);
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(fx, focalY, 1.5 + Math.min(1, this.bloom) * 1.5, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 1;
            if (design.screen) {
                ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.6)`;
                ctx.font = `8px ${MONO}`;
                ctx.textAlign = 'center';
                ctx.fillText(virtual ? 'VIRTUAL FOCUS' : 'FOCUS', fx, focalY - flare - 6);
            }
        }

        // Arrival rings retain each ray's actual hit position. Eight slots cap
        // work even when many notes converge in the same frame.
        ctx.strokeStyle = theme.neon;
        ctx.lineWidth = 1;
        for (let i = 0; i < this.impactAge.length; i++) {
            const age = this.impactAge[i];
            if (age >= 0.45 || !Number.isFinite(this.impactY[i])) continue;
            const progress = age / 0.45;
            ctx.globalAlpha = (1 - progress) * (1 - progress) * 0.6;
            ctx.beginPath();
            ctx.arc(imgX, sy(this.impactY[i]), 3 + progress * 32, 0, TAU);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

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
        // Readouts come from the trace, not the label: an afocal pair reads
        // AFOCAL, a negative lens its (virtual) EFL, everything else EFL/BFL
        // and the working f-number of the fan at full aperture.
        // Focus distances: from the last vertex when the focus is past it (the
        // usual BFL sense), otherwise as a bench z from the front vertex.
        const focusText = Number.isFinite(optics.focusZ)
            ? optics.focusZ > optics.lastVertex
                ? `FOCUS ${(optics.focusZ - optics.lastVertex).toFixed(2)}`
                : `FOCUS z ${optics.focusZ.toFixed(1)}`
            : Number.isFinite(optics.virtualFocusZ)
                ? `VIRTUAL FOCUS z ${optics.virtualFocusZ.toFixed(1)}`
                : '';
        const eflText = !Number.isFinite(optics.efl)
            ? `AFOCAL  ${focusText}`
            : design.screen
                ? `EFL ${optics.efl.toFixed(1)}  ${focusText}`
                : `EFL ${optics.efl.toFixed(1)}  BFL ${optics.bfl.toFixed(2)}  ${focusText}`;
        const fnoText = design.focusLabel ?? (optics.efl > 0 && Number.isFinite(optics.efl) ? `f/${optics.fno.toFixed(1)}` : '');
        ctx.fillText(
            `${eflText}   ${fnoText}   FIELD ${fieldDeg}°   λ-SPLIT ${this.split.toFixed(2)}`,
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
            `DESIGN ${this.designIdx + 1}/${LENS_DESIGNS.length}   BAR ${Math.max(0, Math.floor(s.cycle))}`,
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
