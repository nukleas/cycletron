/**
 * LENS BENCH optics — the prescriptions and the meridional ray trace behind
 * the blueprint. Pure math, no canvas: vector Snell through spherical
 * surfaces, clear-aperture clipping, a paraxial (y, u) trace for the
 * first-order numbers, pupil aiming so every field's bundle is defined at
 * the aperture stop, and a closed-form tangential focus per field.
 */

export interface LensSurface {
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

export interface LensDesign {
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
export interface DesignOptics {
    /** Vertex z of every surface; fixed once the prescription is prepared. */
    zs: Float64Array;
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
    /** Rays are launched here, ahead of the front vertex. */
    zStart: number;
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
    /** Surface that acts as the aperture stop (flagged, else the front). */
    stopIdx: number;
    /** Height at the stop of the on-axis ray launched at hMax: the working
     *  pupil semi-height, so every field samples the same aperture. */
    stopHalf: number;
    /** Paraxial stop height per unit launch height (y = 1, u = 0). */
    M: number;
    /** Paraxial stop height per unit launch slope (y = 0, u = 1). */
    N: number;
    /** Image-plane height per unit slope of the paraxial chief ray, at the
     *  bench's actual (best-focus) image plane — the distortion baseline. */
    chiefGain: number;
    /** Tallest |y| any bundle reaches at max field: fixed framing height. */
    yExtent: number;
}

/**
 * Real prescriptions (rustoptic import fixtures / Kingslake, Smith). The
 * Double Gauss stop sits on a dummy plane inside the front SF5 element,
 * exactly as the fixture records it — the trace crosses it un-refracted
 * (n1 === n2) and the aperture still clips there.
 */
export const LENS_DESIGNS: LensDesign[] = [
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

/** Field points as fractions of the design's max field; ± pairs are the
 *  same field point (rotational symmetry) seen from both sides of the axis. */
export const FIELD_FRAC = new Float32Array([-1, -0.6, 0, 0.6, 1]);
export const FIELDS = FIELD_FRAC.length;
export const AXIS = 2;
/** Rays per field per lane — odd, so the middle ray is the chief ray. */
export const RAYS = 11;
export const CHIEF = (RAYS - 1) / 2;
export const LANES = 3;              // d (reference), F (blue), C (red)
/**
 * Index offset per lane in units of (n_d − 1) / V_d, i.e. the glass's own
 * F−C dispersion. For normal crown/flint glass the d line sits about 31% of
 * the way up from C to F (N-BK7: n_C 1.51432, n_d 1.51680, n_F 1.52238), so
 * F is +0.69 and C is −0.31 of the F−C spread. Real values: an achromat's
 * lanes land on top of each other, a singlet's fan out — which is the point.
 */
export const LANE_DELTA = [0, 0.69, -0.31];
/** Points per ray: launch + one per surface (max 10) + image plane. */
export const MAX_PTS = 12;
/** On-axis fan used at load to find best focus; separate from the live
 *  RAYS so the derived focus numbers do not move with the display density. */
const FAN_RAYS = 15;

/** Ray index in the packed polyline buffers. Lane 0 ids are contiguous
 *  0..FIELDS·RAYS−1, so pulses index the d-line arrays directly. */
export function rayIndex(lane: number, field: number, i: number): number {
    return (lane * FIELDS + field) * RAYS + i;
}

/** Result of the last {@link traceRay}; one mutable record, ~200 calls a frame. */
export interface RayHit {
    /** Polyline points written (when an output buffer was given). */
    np: number;
    /** Surface index where the ray died (vignette/TIR/miss), −1 if it reached the image plane. */
    clip: number;
    /** Height at the image plane; NaN for a dead ray. */
    yImg: number;
    /** Height where the ray crossed the stop surface; NaN if it died first. */
    yStop: number;
}

export const HIT: RayHit = {np: 0, clip: -1, yImg: NaN, yStop: NaN};

/**
 * Paraxial (y, u) trace at the d line from (y, u) at z = 0 (the front
 * vertex). Returns the height at the stop surface, the height and slope at
 * the last vertex, and the height at the image plane.
 */
export function paraxialRay(
    S: LensSurface[], y: number, u: number, stopIdx: number,
): {yStop: number; y: number; u: number; yImg: number} {
    let n1 = 1;
    let yStop = NaN;
    for (let k = 0; k < S.length; k++) {
        if (k === stopIdx) yStop = y;
        const n2 = S[k].nd;
        const c = S[k].r === 0 || Math.abs(S[k].r) > 1e6 ? 0 : 1 / S[k].r;
        u = (n1 * u - y * (n2 - n1) * c) / n2;
        if (k < S.length - 1) y += u * S[k].t;
        n1 = n2;
    }
    return {yStop, y, u, yImg: y + u * S[S.length - 1].t};
}

/**
 * EFL and back focal distance from the last vertex of a marginal ray from
 * infinity; both ±Infinity for an afocal system.
 */
function paraxial(S: LensSurface[]): {efl: number; bfl: number} {
    const {y, u} = paraxialRay(S, 1, 0, -1);
    // A nominally afocal pair traces to a focal length of tens of metres
    // through rounding; anything beyond a few metres is afocal on a bench.
    if (Math.abs(u) < 1e-12 || Math.abs(1 / u) > 5000) return {efl: Infinity, bfl: Infinity};
    return {efl: -1 / u, bfl: -y / u};
}

/**
 * Trace one meridional ray through `S` (vertex z's in `zs`, image plane at
 * `zImg`), launched from `zStart` along the line of height `y1` at z = 0
 * and slope `slope`. `lane` picks the wavelength via LANE_DELTA. With
 * `out`, the polyline (z, y) pairs are written at `base`. The result lands
 * in {@link HIT}. The stop height is recorded before the vignette test so
 * a ray clipped at the stop itself still tells the aiming solve where it
 * crossed.
 */
export function traceRay(
    S: LensSurface[], zs: Float64Array, zImg: number, zStart: number,
    y1: number, slope: number, lane: number, stopIdx: number,
    out: Float32Array | null, base: number,
): RayHit {
    const dirLen = Math.sqrt(1 + slope * slope);
    let pz = zStart;
    let py = y1 + slope * zStart;
    let dz = 1 / dirLen;
    let dy = slope / dirLen;
    let n1 = 1;
    let np = 1;
    let clip = -1;
    let yStop = NaN;
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
        if (k === stopIdx) yStop = qy;

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
    HIT.np = np;
    HIT.clip = clip;
    HIT.yImg = yImg;
    HIT.yStop = yStop;
    return HIT;
}

/**
 * Height of a traced ray at axial position z, interpolated along its
 * polyline and extended along its first / last segment beyond the ends —
 * so the same call serves a focus inside the system, at the image plane, or
 * a virtual focus behind the lens.
 */
export function yAtZ(polys: Float32Array, base: number, np: number, z: number): number {
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

/** RMS of a fan's heights at z (rays that reached the image plane). */
function fanRmsAt(polys: Float32Array, polyLen: Uint8Array, polyClip: Int16Array, n: number, z: number): number {
    let sum2 = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
        if (polyClip[i] >= 0) continue;
        const y = yAtZ(polys, i * MAX_PTS * 2, polyLen[i], z);
        if (Number.isFinite(y)) { sum2 += y * y; cnt++; }
    }
    return cnt > 0 ? Math.sqrt(sum2 / cnt) : NaN;
}

/**
 * Pupil aiming for one field: launch heights (at z = 0) of RAYS rays whose
 * heights at the stop are p·stopHalf·fill for p ∈ [−1, 1], written to
 * `out[base..base+RAYS)`. Two reference rays seeded from the paraxial map
 * fix an affine y1(yStop); the map is exact to aberration level, and one
 * secant step puts the chief ray through the stop centre. If a reference
 * ray dies before the stop the paraxial map itself is used, so no field is
 * ever empty. Three traces per call.
 */
export function aimField(
    S: LensSurface[], optics: DesignOptics, slope: number, fill: number,
    out: Float32Array, base: number,
): void {
    const {zs, zImg, zStart, stopIdx, stopHalf, M, N} = optics;
    const yA = (-0.5 * stopHalf - N * slope) / M;
    const yB = (0.5 * stopHalf - N * slope) / M;
    const sA = traceRay(S, zs, zImg, zStart, yA, slope, 0, stopIdx, null, 0).yStop;
    const sB = traceRay(S, zs, zImg, zStart, yB, slope, 0, stopIdx, null, 0).yStop;
    let a: number;
    let b: number;
    if (Number.isFinite(sA) && Number.isFinite(sB) && Math.abs(sB - sA) > 1e-9) {
        b = (yB - yA) / (sB - sA);
        a = yA - b * sA;
    } else {
        b = 1 / M;
        a = -N * slope / M;
    }
    const sC = traceRay(S, zs, zImg, zStart, a, slope, 0, stopIdx, null, 0).yStop;
    if (Number.isFinite(sC)) a -= sC * b;
    const span = stopHalf * fill;
    for (let i = 0; i < RAYS; i++) {
        const p = (i / (RAYS - 1)) * 2 - 1;
        out[base + i] = a + b * p * span;
    }
}

/** Result of {@link fieldFocus}; one mutable record. */
export interface FieldFocus {
    /** z of the tangential best focus, NaN when the bundle has none. */
    z: number;
    /** Centroid height there. */
    y: number;
    /** RMS residual of the fan about that centroid, mm. */
    rms: number;
    /** Surviving rays used. */
    n: number;
}

export const FOCUS: FieldFocus = {z: NaN, y: NaN, rms: NaN, n: 0};

/**
 * Tangential best focus of one field's d-line fan, closed form: each
 * surviving ray's segment through `zRef` is y_i(z) = a_i + b_i·z, the
 * variance across rays is quadratic in z, and its minimum is
 * z* = −cov(a, b) / var(b). `zSeg` selects the segment: the image plane for
 * a focus past the lens (its exit segment, also extended backwards for a
 * virtual focus), the crossing itself for an internal one. Rejected (NaN)
 * when fewer than three rays survive, the exit is collimated, or z* lands
 * more than 0.35·zImg from the design's own focus `zAnchor` — a fan that
 * never comes together.
 */
export function fieldFocus(
    polys: Float32Array, polyLen: Uint8Array, polyClip: Int8Array,
    firstRay: number, zSeg: number, zAnchor: number, zImg: number,
): FieldFocus {
    let sa = 0, sb = 0, saa = 0, sab = 0, sbb = 0;
    let n = 0;
    for (let i = 0; i < RAYS; i++) {
        const ray = firstRay + i;
        const np = polyLen[ray];
        if (polyClip[ray] >= 0 || np < 2) continue;
        const base = ray * MAX_PTS * 2;
        let j = 1;
        while (j < np - 1 && polys[base + j * 2] < zSeg) j++;
        const z0 = polys[base + (j - 1) * 2], y0 = polys[base + (j - 1) * 2 + 1];
        const z1 = polys[base + j * 2], y1 = polys[base + j * 2 + 1];
        if (z1 === z0) continue;
        const b = (y1 - y0) / (z1 - z0);
        const a = y0 - b * z0;
        sa += a; sb += b; saa += a * a; sab += a * b; sbb += b * b;
        n++;
    }
    FOCUS.n = n;
    if (n < 3) { FOCUS.z = NaN; FOCUS.y = NaN; FOCUS.rms = NaN; return FOCUS; }
    const ma = sa / n, mb = sb / n;
    const varB = sbb / n - mb * mb;
    const cov = sab / n - ma * mb;
    if (varB < 1e-6) { FOCUS.z = NaN; FOCUS.y = NaN; FOCUS.rms = NaN; return FOCUS; }
    const z = -cov / varB;
    if (Math.abs(z - zAnchor) > 0.35 * zImg) { FOCUS.z = NaN; FOCUS.y = NaN; FOCUS.rms = NaN; return FOCUS; }
    const varA = saa / n - ma * ma;
    FOCUS.z = z;
    FOCUS.y = ma + mb * z;
    FOCUS.rms = Math.sqrt(Math.max(0, varA + 2 * cov * z + varB * z * z));
    return FOCUS;
}

/**
 * Normalise a prescription in place and derive its optics. Designs with a
 * published `efl` are scaled so the trace agrees with the label, and every
 * focusing design gets its image plane at the paraxial focus — typed image
 * distances are how a bench ends up showing a blur at "IMG". The marginal
 * height is found by bisection on the real trace so the fan fills the
 * working aperture with no vignetting on axis.
 */
export function prepareDesign(design: LensDesign): DesignOptics {
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
    let stopIdx = 0;
    for (let k = 0; k < S.length; k++) if (S[k].stop) stopIdx = k;
    let lo = 0;
    let hi = S[0].sd * 1.01;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (traceRay(S, zs, zImg, zStart, mid, 0, 0, stopIdx, null, 0).clip < 0) lo = mid;
        else hi = mid;
    }
    if (!Number.isFinite(efl)) { efl = Infinity; bfl = Infinity; }
    // A hair inside the bisected limit, so the rim ray survives the
    // Float32 launch table at full fill instead of dying at its own edge.
    const hMax = design.fno !== undefined && efl > 0
        ? Math.min(lo * 0.998, efl / (2 * design.fno))
        : lo * 0.998;
    const lastVertex = zs[S.length - 1];

    // Where does the on-axis fan at full aperture actually come together?
    // Scan the RMS spot along the bench: the minimum is the circle of least
    // confusion — ahead of paraxial focus for a lens with spherical
    // aberration, between the elements for a Keplerian pair. If the fan
    // never tightens (a negative lens) the exit rays' backward extensions
    // give the virtual focus instead.
    const fan = new Float32Array(FAN_RAYS * MAX_PTS * 2);
    const fanLen = new Uint8Array(FAN_RAYS);
    const fanClip = new Int16Array(FAN_RAYS);
    let launchRms = 0;
    for (let i = 0; i < FAN_RAYS; i++) {
        const y1 = ((i / (FAN_RAYS - 1)) * 2 - 1) * hMax;
        const hit = traceRay(S, zs, zImg, zStart, y1, 0, 0, stopIdx, fan, i * MAX_PTS * 2);
        fanLen[i] = hit.np;
        fanClip[i] = hit.clip;
        launchRms += y1 * y1;
    }
    launchRms = Math.sqrt(launchRms / FAN_RAYS);
    let focusZ = NaN;
    let focusRms = Infinity;
    const steps = 600;
    for (let k = 0; k <= steps; k++) {
        const z = (zImg * k) / steps;
        const rms = fanRmsAt(fan, fanLen, fanClip, FAN_RAYS, z);
        if (rms < focusRms) { focusRms = rms; focusZ = z; }
    }
    for (let k = -40; k <= 40; k++) {
        const z = focusZ + (k / 40) * (zImg / steps);
        const rms = fanRmsAt(fan, fanLen, fanClip, FAN_RAYS, z);
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
        for (let i = 0; i < FAN_RAYS; i++) {
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

    // The pupil, expressed at the stop: every field's bundle is aimed so
    // its rays cross the stop at p·stopHalf, which is exactly the on-axis
    // working aperture seen from there.
    const stopHalf = traceRay(S, zs, zImg, zStart, hMax, 0, 0, stopIdx, null, 0).yStop;
    const M = paraxialRay(S, 1, 0, stopIdx).yStop;
    const N = paraxialRay(S, 0, 1, stopIdx).yStop;
    // Paraxial chief ray (stop height 0) per unit slope, to the actual
    // image plane: the undistorted image height at a defocused plane is
    // not efl·tanθ, and the difference is several percent on a fast singlet.
    const chiefGain = paraxialRay(S, -N / M, 1, stopIdx).yImg;

    const optics: DesignOptics = {
        zs, efl, bfl, hMax, fno: efl / (2 * hMax), zImg, zStart, lastVertex,
        focusZ, focusRms, virtualFocusZ, stopIdx, stopHalf, M, N, chiefGain, yExtent: 0,
    };
    // Framing: the tallest launch or image height any bundle reaches at
    // max field, so the view never zooms with the music.
    const maxField = (design.maxFieldDeg * Math.PI) / 180;
    const launch = new Float32Array(RAYS);
    let yExtent = S[0].sd;
    for (const sign of [-1, 1]) {
        const slope = -Math.tan(sign * maxField);
        aimField(S, optics, slope, 1, launch, 0);
        for (let i = 0; i < RAYS; i += CHIEF) {
            yExtent = Math.max(yExtent, Math.abs(launch[i] + slope * zStart));
            const yImg = traceRay(S, zs, zImg, zStart, launch[i], slope, 0, stopIdx, null, 0).yImg;
            if (Number.isFinite(yImg)) yExtent = Math.max(yExtent, Math.abs(yImg));
        }
    }
    optics.yExtent = yExtent * 1.25;
    return optics;
}

export const DESIGN_OPTICS: DesignOptics[] = LENS_DESIGNS.map(prepareDesign);

/** Sag (axial depth) of a spherical surface at height y; 0 for planes. */
export function sagZ(r: number, y: number): number {
    if (r === 0 || Math.abs(r) > 1e6) return 0;
    const ay = Math.min(Math.abs(y), Math.abs(r));
    return r - Math.sign(r) * Math.sqrt(r * r - ay * ay);
}
