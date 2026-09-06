/**
 * LENS BENCH — blueprint optical bench with a live ray trace. A real 2D
 * meridional trace (vector Snell through spherical surfaces) of classic
 * prescriptions, drawn as an optical-engineering blueprint. Five field
 * points are traced at once, each bundle aimed through the aperture stop
 * the way a bench does it, so what off-axis light really does — chief rays
 * crossing at the stop, rim rays vignetting, the tangential focus curving
 * off the image plane, distortion, lateral colour — is the picture. Pattern
 * haps ride the rays as light pulses; the FFT breathes the pupil, lights
 * the off-axis bundles, and splits the trace chromatically.
 */

import {currentBpm} from '../../bpm.js';
import {TrackModel} from '../tracks.js';
import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, TransientDetector, beatEnv, rgbOf} from '../util.js';
import {
    AXIS, CHIEF, DESIGN_OPTICS, FIELDS, FIELD_FRAC, LANES, LENS_DESIGNS, MAX_PTS, RAYS,
    aimField, fieldFocus, rayIndex, sagZ, traceRay, yAtZ,
} from './lens-bench/optics.js';

const MAX_PULSES = 64;
const DESIGN_BARS = 16;       // bars per prescription before rotating
const RAY_COUNT = LANES * FIELDS * RAYS;
/** Lane-0 (d line) rays: the ones pulses ride and the bench measures. */
const D_RAYS = FIELDS * RAYS;
/** Draw order: outer fields first, the axis last so it sits on top. */
const FIELD_ORDER = [0, 4, 1, 3, 2];
/** Fields shown in the ray-fan inset: axis, 0.6 and full field. */
const INSET_FIELDS = [AXIS, 3, 4];
const MONO = '"JetBrains Mono", ui-monospace, monospace';

interface Pulse {
    /** d-line ray index (field·RAYS + i) the pulse rides. */
    ray: number;
    /** Distance travelled along the ray in world millimetres. */
    s: number;
    speed: number;
    color: string;
    /** 1 while travelling; fades out after arrival. */
    life: number;
    arrived: boolean;
}

class LensBenchMode implements VizMode {
    private designIdx = 0;
    private split = 0;          // smoothed chromatic split, 0..1
    private lowSm = 0;          // smoothed bands — trace geometry inputs
    private midSm = 0;
    private scale = 0;          // world mm → css px; 0 = unfitted
    private ox = 0;             // screen x of world z = 0
    private cy = 0;             // screen y of the optical axis
    /** Ray polylines, (z, y) world-mm pairs, MAX_PTS stride per ray. */
    private readonly polys = new Float32Array(RAY_COUNT * MAX_PTS * 2);
    private readonly polyLen = new Uint8Array(RAY_COUNT);
    /** Surface index where the ray died (vignette/TIR/miss), -1 = reached image. */
    private readonly polyClip = new Int8Array(RAY_COUNT);
    /** Image-plane y per ray, NaN for dead rays — bloom, ticks, ray fans. */
    private readonly imageHits = new Float32Array(RAY_COUNT).fill(NaN);
    /** Pupil-aimed launch heights (at z = 0) per d-line ray. */
    private readonly launch = new Float32Array(D_RAYS);
    private readonly fieldSlope = new Float32Array(FIELDS);
    /** Per-field tangential focus: z, centroid y, RMS there (NaN = none). */
    private readonly fieldZ = new Float32Array(FIELDS).fill(NaN);
    private readonly fieldY = new Float32Array(FIELDS).fill(NaN);
    private readonly fieldRms = new Float32Array(FIELDS).fill(NaN);
    /** Chief-ray distortion per field, fraction (NaN on axis / screens). */
    private readonly fieldDist = new Float32Array(FIELDS).fill(NaN);
    private readonly fieldCss: string[] = new Array(FIELDS).fill('');
    private pulses: Pulse[] = [];
    private readonly bloom = new Float32Array(FIELDS);
    private readonly distances = new Float32Array(D_RAYS * MAX_PTS);
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
        const optics = DESIGN_OPTICS[this.designIdx];
        let sdMax = 0;
        for (const surf of design.surfaces) if (surf.sd > sdMax) sdMax = surf.sd;
        const zImg = optics.zImg;
        const zMin = Number.isFinite(optics.virtualFocusZ)
            ? Math.min(optics.zStart, optics.virtualFocusZ - 0.06 * zImg)
            : optics.zStart;
        const zMax = zImg * 1.04;
        // Tall enough for the widest field's bundle, fixed per design.
        const yMax = design.viewSemiDiameter ?? Math.max(sdMax * 1.3, optics.yExtent);
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
     * 2D meridional trace, re-run every frame: five fields × three lanes ×
     * eleven rays plus three aiming rays per field, ≤16 surfaces of
     * quadratic math each — trivially cheap, and it buys continuous field
     * and chromatic animation with zero cache invalidation. Each field's
     * bundle is a collimated beam at its field angle — the design's own
     * field points, not a music parameter — aimed at the stop, so all
     * fields sample the same pupil and the chief rays cross at its centre;
     * rays die on vignette, TIR, or a full miss — which off axis is the
     * real vignetting of the design.
     */
    private trace(): void {
        const design = LENS_DESIGNS[this.designIdx];
        const optics = DESIGN_OPTICS[this.designIdx];
        const S = design.surfaces;
        const {zs, zImg, zStart, stopIdx} = optics;
        // The pupil fills 70–100% with the low band, so the loudest state is
        // the lens wide open and nothing vignettes on axis.
        const fill = 0.7 + this.lowSm * 0.3;
        const maxField = (design.maxFieldDeg * Math.PI) / 180;
        const split = this.split;

        for (let f = 0; f < FIELDS; f++) {
            const slope = -Math.tan(FIELD_FRAC[f] * maxField);
            this.fieldSlope[f] = slope;
            aimField(S, optics, slope, fill, this.launch, f * RAYS);
            for (let w = 0; w < LANES; w++) {
                // Chromatic lanes only exist while the highs hold them open.
                // Their geometry is physical whenever drawn; `split` is opacity.
                const laneOn = w === 0 || split > 0.015;
                for (let i = 0; i < RAYS; i++) {
                    const idx = rayIndex(w, f, i);
                    if (!laneOn) {
                        this.polyLen[idx] = 0;
                        this.imageHits[idx] = NaN;
                        continue;
                    }
                    const hit = traceRay(
                        S, zs, zImg, zStart, this.launch[f * RAYS + i], slope, w, stopIdx,
                        this.polys, idx * MAX_PTS * 2);
                    this.polyLen[idx] = hit.np;
                    this.polyClip[idx] = hit.clip;
                    this.imageHits[idx] = hit.yImg;
                }
            }
        }

        // Where each field's fan is tightest: the tangential focus in closed
        // form, anchored on the design's own focus (internal for an afocal
        // pair, virtual behind a diverging lens). A fan with no focus of its
        // own is still read at the anchor so the marker follows the rays.
        const fz = Number.isFinite(optics.focusZ) ? optics.focusZ : optics.virtualFocusZ;
        if (Number.isFinite(fz)) {
            const internal = fz > zs[0] && fz < optics.lastVertex;
            const zSeg = internal ? fz : zImg;
            for (let f = 0; f < FIELDS; f++) {
                const foc = fieldFocus(this.polys, this.polyLen, this.polyClip, rayIndex(0, f, 0), zSeg, fz, zImg);
                if (Number.isFinite(foc.z)) {
                    this.fieldZ[f] = foc.z;
                    this.fieldY[f] = foc.y;
                    this.fieldRms[f] = foc.rms;
                    continue;
                }
                let sum = 0, sum2 = 0, n = 0;
                for (let i = 0; i < RAYS; i++) {
                    const idx = f * RAYS + i;
                    if (this.polyClip[idx] >= 0) continue;
                    const y = yAtZ(this.polys, idx * MAX_PTS * 2, this.polyLen[idx], fz);
                    if (!Number.isFinite(y)) continue;
                    sum += y; sum2 += y * y; n++;
                }
                this.fieldZ[f] = n > 0 ? fz : NaN;
                this.fieldY[f] = n > 0 ? sum / n : NaN;
                this.fieldRms[f] = n > 0 ? Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) : NaN;
            }
        } else {
            this.fieldZ.fill(NaN);
            this.fieldY.fill(NaN);
            this.fieldRms.fill(NaN);
        }

        // Distortion: the chief ray's landing against the paraxial chief
        // ray's, at the bench's actual image plane.
        for (let f = 0; f < FIELDS; f++) {
            const ideal = optics.chiefGain * this.fieldSlope[f];
            const yChief = this.imageHits[rayIndex(0, f, CHIEF)];
            this.fieldDist[f] = !design.screen && f !== AXIS && Number.isFinite(yChief) && Math.abs(ideal) > 1e-6
                ? (yChief - ideal) / ideal
                : NaN;
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

        // Prescription rotation.
        const want = Math.floor(Math.max(0, s.cycle) / DESIGN_BARS) % LENS_DESIGNS.length;
        if (want !== this.designIdx) {
            this.designIdx = want;
            this.pulses.length = 0;
            this.impactAge.fill(1);
            this.bloom.fill(0);
            this.titleFlash = 1;
            this.refit();
        }

        // Trace before spawning and advancing so lengths and clipping agree
        // with the geometry displayed this frame (including prescription changes).
        this.trace();
        for (let ray = 0; ray < D_RAYS; ray++) {
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

        // Pattern onsets → light pulses riding the d-line rays. Each track
        // rides its own field so instruments travel different bundles;
        // pitched notes map C1..C7 across the fan, unpitched haps hash to a
        // stable ray.
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        if (sync.pattern && sync.phase >= sync.prevPhase) {
            const cps = Math.max(0.05, currentBpm() / 240);
            for (const track of this.tracks.tracks) {
                const field = track.slot % FIELDS;
                for (let e = 0; e < track.count; e++) {
                    const begin = track.begins[e];
                    if (begin > sync.prevPhase && begin <= sync.phase) {
                        track.activity = Math.min(1, track.activity + 0.45);
                        const note = track.notes[e];
                        const i = Number.isFinite(note)
                            ? Math.round(((Math.min(96, Math.max(24, note)) - 24) / 72) * (RAYS - 1))
                            : (track.slot * 5 + Math.floor(begin * 16) * 3) % RAYS;
                        const durCycles = Math.min(1, Math.max(0.05, track.ends[e] - begin));
                        const durSec = Math.min(1.2, Math.max(0.12, durCycles / cps));
                        this.spawnPulse(field * RAYS + i, durSec, track.accentCss);
                    }
                }
            }
        }
        this.tracks.decay(dt);

        // FFT transients: kicks flood the on-axis marginal rays and chief;
        // snares fire the full-field chief rays through the stop centre;
        // hats fire one fast spark up the axis fan.
        const hits = this.transients.update(dt, low, mid, high);
        const axis = AXIS * RAYS;
        if (hits.kick) {
            this.spawnPulse(axis, 0.25, s.theme.neon);
            this.spawnPulse(axis + RAYS - 1, 0.25, s.theme.neon);
            this.spawnPulse(axis + CHIEF, 0.22, s.theme.active);
        }
        if (hits.snare) {
            this.spawnPulse(CHIEF, 0.2, s.theme.active);
            this.spawnPulse((FIELDS - 1) * RAYS + CHIEF, 0.2, s.theme.active);
        }
        if (hits.hat) {
            const upper = axis + CHIEF + 1 + Math.floor(Math.random() * CHIEF);
            this.spawnPulse(Math.min(axis + RAYS - 1, upper), 0.15, '#ffffff');
        }

        // Advance at constant world-space speed; arrivals at the image plane
        // feed their field's bloom (vignetted rays just die at the clip point).
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
                        const f = Math.floor(pulse.ray / RAYS);
                        this.bloom[f] = Math.min(1.2, this.bloom[f] + 0.35);
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
        const decay = Math.exp(-dt * 4);
        for (let f = 0; f < FIELDS; f++) this.bloom[f] *= decay;
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
        const optics = DESIGN_OPTICS[this.designIdx];
        const S = design.surfaces;
        const nS = S.length;
        const zs = optics.zs;
        const zImg = optics.zImg;
        const scale = this.scale;
        const ox = this.ox;
        const cy = this.cy;
        const sx = (z: number): number => ox + z * scale;
        const sy = (y: number): number => cy - y * scale;

        let sdMax = 0;
        for (let k = 0; k < nS; k++) if (S[k].sd > sdMax) sdMax = S[k].sd;
        let bloomMax = 0;
        for (let f = 0; f < FIELDS; f++) if (this.bloom[f] > bloomMax) bloomMax = this.bloom[f];

        const [br, bgc, bb] = theme.borderRgb;
        const [tr, tg, tb] = theme.textRgb;
        const neonRgb = rgbOf(theme.neon, [71, 246, 255]);
        const redRgb = rgbOf(theme.red, [255, 69, 108]);
        const violetRgb = rgbOf(theme.violet, [157, 124, 255]);
        const activeRgb = rgbOf(theme.active, [247, 255, 90]);
        // Field colour by |field|: the axis in the drafting text colour,
        // 0.6 field violet, full field the yellow accent. ± pairs are the
        // same field point and share a colour, as on a layout plot.
        const fieldRgb = (f: number): [number, number, number] => {
            const a = Math.abs(FIELD_FRAC[f]);
            return a < 0.01 ? theme.textRgb : a < 0.8 ? violetRgb : activeRgb;
        };
        for (let f = 0; f < FIELDS; f++) {
            const [r, g, b] = fieldRgb(f);
            this.fieldCss[f] = `rgb(${r}, ${g}, ${b})`;
        }

        // 1. Blueprint grid — world-mm pitch snapped through the transform.
        const pitch = 10 * scale < 7 ? 50 : 10;
        const zw0 = Math.ceil((0 - ox) / scale / pitch) * pitch;
        const zw1 = (w - ox) / scale;
        const yw1 = cy / scale;
        const yw0 = Math.ceil((cy - h) / scale / pitch) * pitch;
        const gMinor = `rgba(${br}, ${bgc}, ${bb}, ${(0.16 + beat * 0.08 + bloomMax * 0.10).toFixed(3)})`;
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
            const x = sx(zs[k]);
            ctx.moveTo(x, cy - 3);
            ctx.lineTo(x, cy + 3);
        }
        ctx.stroke();
        for (let k = 0; k < nS; k++) {
            ctx.fillText(String(k + 1), sx(zs[k]), cy + 12 + (k % 2) * 9);
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
            const zF = zs[k];
            const zB = zs[k + 1];
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

        // 4. Aperture-stop blades — hatched, brightening on the beat. The
        // chief rays of every field cross between them.
        for (let k = 0; k < nS; k++) {
            if (!S[k].stop) continue;
            const bx = sx(zs[k]);
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
            ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.5)`;
            ctx.font = `8px ${MONO}`;
            ctx.textAlign = 'center';
            ctx.fillText('STOP', bx, sy(-(sd + ext)) + 11);
        }

        // 5. Rays — one batched path per (lane, field); chromatic lanes
        // first, then the d line, outer fields first and the axis on top.
        const dAlpha = 0.18 + this.midSm * 0.16;
        // Off-axis bundles come up with the mids: quiet passages read as the
        // on-axis fan with faint field bundles, loud ones as the full plot.
        const offAlpha = dAlpha * (0.55 + this.midSm * 0.6);
        const cAlpha = this.split * (0.16 + this.split * 0.2);
        const laneCss = [
            `rgba(${tr}, ${tg}, ${tb}, ${dAlpha.toFixed(3)})`,
            `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, ${cAlpha.toFixed(3)})`,
            `rgba(${redRgb[0]}, ${redRgb[1]}, ${redRgb[2]}, ${cAlpha.toFixed(3)})`,
        ];
        ctx.lineWidth = 1;
        for (let lane = LANES - 1; lane >= 0; lane--) {
            for (const f of FIELD_ORDER) {
                if (lane === 0) {
                    const [r, g, b] = fieldRgb(f);
                    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${(f === AXIS ? dAlpha : offAlpha).toFixed(3)})`;
                } else {
                    ctx.strokeStyle = laneCss[lane];
                }
                ctx.beginPath();
                for (let i = 0; i < RAYS; i++) {
                    const idx = rayIndex(lane, f, i);
                    const np = this.polyLen[idx];
                    if (np < 2) continue;
                    const end = this.polyClip[idx] >= 0 ? np - 1 : np;
                    const base = idx * MAX_PTS * 2;
                    ctx.moveTo(sx(this.polys[base]), sy(this.polys[base + 1]));
                    for (let m = 1; m < end; m++) {
                        ctx.lineTo(sx(this.polys[base + m * 2]), sy(this.polys[base + m * 2 + 1]));
                    }
                }
                ctx.stroke();
            }
            // Dimmed final segments of vignetted/dead rays, all fields at once.
            ctx.strokeStyle = laneCss[lane];
            ctx.globalAlpha = 0.35;
            ctx.beginPath();
            for (let f = 0; f < FIELDS; f++) {
                for (let i = 0; i < RAYS; i++) {
                    const idx = rayIndex(lane, f, i);
                    const np = this.polyLen[idx];
                    if (np < 2 || this.polyClip[idx] < 0) continue;
                    const base = idx * MAX_PTS * 2;
                    ctx.moveTo(sx(this.polys[base + (np - 2) * 2]), sy(this.polys[base + (np - 2) * 2 + 1]));
                    ctx.lineTo(sx(this.polys[base + (np - 1) * 2]), sy(this.polys[base + (np - 1) * 2 + 1]));
                }
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // Principal rays: the on-axis marginal pair and chief in neon, every
        // off-axis field's chief ray in its colour — the bright silhouette,
        // crossing at the stop.
        const principal = (idx: number): void => {
            const np = this.polyLen[idx];
            if (np < 2) return;
            const end = this.polyClip[idx] >= 0 ? np - 1 : np;
            const base = idx * MAX_PTS * 2;
            for (let j = 0; j < end; j++) {
                const x = sx(this.polys[base + j * 2]);
                const y = sy(this.polys[base + j * 2 + 1]);
                if (j === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        };
        ctx.globalAlpha = 0.4 + this.lowSm * 0.25;
        ctx.lineWidth = 1.4;
        for (const f of FIELD_ORDER) {
            if (f === AXIS) continue;
            ctx.strokeStyle = this.fieldCss[f];
            ctx.beginPath();
            principal(rayIndex(0, f, CHIEF));
            ctx.stroke();
        }
        ctx.strokeStyle = theme.neon;
        ctx.beginPath();
        principal(rayIndex(0, AXIS, 0));
        principal(rayIndex(0, AXIS, CHIEF));
        principal(rayIndex(0, AXIS, RAYS - 1));
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

        // 7. Image plane, per-field focus markers, the tangential field
        // curve, distortion ticks, and the focal bloom sized by each field's
        // live RMS spot.
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
        ctx.textAlign = 'center';
        ctx.fillText(design.screen ? (design.screenLabel ?? 'SCREEN') : 'IMG', imgX, sy(planeHeight) - 4);

        if (design.screen) {
            // Show the actual spread at the observation plane, not an invented
            // bright focus at the centroid of a divergent or collimated bundle.
            ctx.strokeStyle = theme.neon;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            for (let i = 0; i < D_RAYS; i++) {
                if (!Number.isFinite(this.imageHits[i])) continue;
                const y = sy(this.imageHits[i]);
                ctx.moveTo(imgX - 3, y);
                ctx.lineTo(imgX + 3, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // Focus markers follow the trace: at the image plane for a focusing
        // design (placed at best focus), between the elements for an afocal
        // pair, and behind the lens — exit rays projected back as dashed
        // lines — for a diverging one. Off-axis fields land wherever their
        // own fan is tightest, which is the field curvature of the lens.
        const virtual = !Number.isFinite(optics.focusZ) && Number.isFinite(optics.virtualFocusZ);
        if (virtual) {
            ctx.save();
            ctx.setLineDash([3, 4]);
            ctx.strokeStyle = theme.neon;
            ctx.globalAlpha = 0.28;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let f = 0; f < FIELDS; f++) {
                const fz = this.fieldZ[f];
                if (!Number.isFinite(fz)) continue;
                for (let i = 0; i < RAYS; i += CHIEF) {
                    const idx = rayIndex(0, f, i);
                    const np = this.polyLen[idx];
                    if (this.polyClip[idx] >= 0 || np < 2) continue;
                    const base = idx * MAX_PTS * 2;
                    const y = yAtZ(this.polys, base, np, fz);
                    if (!Number.isFinite(y)) continue;
                    ctx.moveTo(sx(this.polys[base + (np - 2) * 2]), sy(this.polys[base + (np - 2) * 2 + 1]));
                    ctx.lineTo(sx(fz), sy(y));
                }
            }
            ctx.stroke();
            ctx.restore();
        }

        // Tangential field curve through the per-field foci: the sag off the
        // flat IMG line is field curvature, visible at last.
        let curvePts = 0;
        for (let f = 0; f < FIELDS; f++) if (Number.isFinite(this.fieldZ[f]) && Number.isFinite(this.fieldY[f])) curvePts++;
        if (curvePts >= 3) {
            ctx.save();
            ctx.setLineDash(virtual ? [3, 4] : [2, 3]);
            ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${(0.45 + this.midSm * 0.3).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;
            for (let f = 0; f < FIELDS; f++) {
                if (!Number.isFinite(this.fieldZ[f]) || !Number.isFinite(this.fieldY[f])) continue;
                const x = sx(this.fieldZ[f]);
                const y = sy(this.fieldY[f]);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        }

        // One unit gradient, positioned and sized per field by the transform.
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `rgba(${neonRgb[0]}, ${neonRgb[1]}, ${neonRgb[2]}, 0.6)`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        for (const f of FIELD_ORDER) {
            const fz = this.fieldZ[f];
            const fy = this.fieldY[f];
            if (!Number.isFinite(fz) || !Number.isFinite(fy)) continue;
            const fx = sx(fz);
            const focalY = sy(fy);
            const bloom = this.bloom[f];
            const rms = virtual ? 0 : this.fieldRms[f];
            const radius = 6 + rms * scale * 2 + bloom * 26;
            ctx.save();
            ctx.translate(fx, focalY);
            ctx.scale(radius, radius);
            ctx.fillStyle = grad;
            ctx.globalAlpha = (0.12 + bloom * 0.45) / 0.6;
            ctx.beginPath();
            ctx.arc(0, 0, 1, 0, TAU);
            ctx.fill();
            ctx.restore();
            // Local flare uses crisp strokes, keeping the beam's landing point
            // readable without a canvas-wide blur or compositing pass.
            const flare = 5 + Math.min(1, bloom) * 30;
            ctx.strokeStyle = f === AXIS ? theme.neon : this.fieldCss[f];
            ctx.globalAlpha = 0.2 + Math.min(1, bloom) * 0.45;
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
            ctx.arc(fx, focalY, 1.5 + Math.min(1, bloom) * 1.5, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 1;
            if (design.screen && f === AXIS) {
                ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, 0.6)`;
                ctx.font = `8px ${MONO}`;
                ctx.textAlign = 'center';
                ctx.fillText(virtual ? 'VIRTUAL FOCUS' : 'FOCUS', fx, focalY - flare - 6);
            }
        }

        // Distortion and lateral colour at IMG: a dim tick where the paraxial
        // chief ray would land, a bright one where this field's chief ray
        // does, and the F/C chief rays beside it while the highs split them.
        if (!design.screen) {
            ctx.lineWidth = 1;
            ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, 0.35)`;
            ctx.beginPath();
            for (let f = 0; f < FIELDS; f++) {
                if (f === AXIS) continue;
                const y = sy(optics.chiefGain * this.fieldSlope[f]);
                ctx.moveTo(imgX - 9, y);
                ctx.lineTo(imgX - 2, y);
            }
            ctx.stroke();
            for (let f = 0; f < FIELDS; f++) {
                if (f === AXIS) continue;
                const yC = this.imageHits[rayIndex(0, f, CHIEF)];
                if (!Number.isFinite(yC)) continue;
                ctx.strokeStyle = this.fieldCss[f];
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                ctx.moveTo(imgX + 2, sy(yC));
                ctx.lineTo(imgX + 9, sy(yC));
                ctx.stroke();
            }
            ctx.globalAlpha = Math.min(1, this.split * 1.5);
            for (let lane = 1; lane < LANES; lane++) {
                ctx.strokeStyle = laneCss[lane];
                ctx.beginPath();
                for (let f = 0; f < FIELDS; f++) {
                    if (f === AXIS) continue;
                    const yL = this.imageHits[rayIndex(lane, f, CHIEF)];
                    if (!Number.isFinite(yL)) continue;
                    ctx.moveTo(imgX + 10, sy(yL));
                    ctx.lineTo(imgX + 14, sy(yL));
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
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

        // 8. Glass callouts with leader lines, staggered on two rows. Each
        // glass is called out once per design: a train of identical
        // doublets (the riflescope) would otherwise pile labels on top of
        // each other.
        ctx.font = `10px ${MONO}`;
        ctx.textAlign = 'center';
        let runIdx = 0;
        for (let k = 0; k < nS - 1; k++) {
            if (S[k].nd <= 1 || !S[k].glass) continue;
            let seen = false;
            for (let j = 0; j < k; j++) if (S[j].glass === S[k].glass) { seen = true; break; }
            if (seen) continue;
            const runEnd = k + 1;
            const cxEl = (sx(zs[k]) + sx(zs[runEnd])) / 2;
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
        const fieldDeg = design.maxFieldDeg.toFixed(1);
        // Readouts come from the trace, not the label: an afocal pair reads
        // AFOCAL, a negative lens its (virtual) EFL, everything else EFL/BFL
        // and the working f-number of the fan at full aperture. FIELD is the
        // design's half-field; distortion and tangential field curvature
        // are read at that full field.
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
            ? `AFOCAL  MAG ${optics.magnification.toFixed(1)}×  ${focusText}`
            : design.screen
                ? `EFL ${optics.efl.toFixed(1)}  ${focusText}`
                : `EFL ${optics.efl.toFixed(1)}  BFL ${optics.bfl.toFixed(2)}  ${focusText}`;
        const fnoText = design.focusLabel ?? (optics.efl > 0 && Number.isFinite(optics.efl) ? `f/${optics.fno.toFixed(1)}` : '');
        const edge = FIELDS - 1;
        const tCurv = this.fieldZ[edge] - this.fieldZ[AXIS];
        const aberrText = !design.screen && Number.isFinite(this.fieldDist[edge]) && Number.isFinite(tCurv)
            ? `   DIST ${(this.fieldDist[edge] * 100).toFixed(2)}%   T-CURV ${tCurv.toFixed(2)}mm`
            : '';
        ctx.fillText(
            `${eflText}   ${fnoText}   FIELD ±${fieldDeg}°${aberrText}   λ-SPLIT ${this.split.toFixed(2)}`,
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

        // 10. Ray-fan inset — transverse aberration εy against pupil
        // coordinate for the axis, 0.6 and full field, one curve per lane.
        // Spherical reads as a cubic, coma as an S, lateral colour as the
        // F/C curves riding above and below the d line.
        if (w >= 560 && h >= 360) {
            this.drawRayFans(ctx, tbY, tbH, laneCss, `rgba(${tr}, ${tg}, ${tb}, 0.5)`, design.maxFieldDeg);
        }
    }

    private drawRayFans(
        ctx: CanvasRenderingContext2D, top: number, height: number,
        laneCss: string[], textCss: string, maxFieldDeg: number,
    ): void {
        const pw = 64;
        const ph = height - 12;
        const gap = 10;
        const x0 = 48;
        // Common scale across the three panels so the fields compare.
        let epsMax = 1e-4;
        for (const f of INSET_FIELDS) {
            const ref = this.imageHits[rayIndex(0, f, CHIEF)];
            if (!Number.isFinite(ref)) continue;
            for (let lane = 0; lane < LANES; lane++) {
                for (let i = 0; i < RAYS; i++) {
                    const y = this.imageHits[rayIndex(lane, f, i)];
                    if (Number.isFinite(y)) epsMax = Math.max(epsMax, Math.abs(y - ref));
                }
            }
        }
        for (let k = 0; k < INSET_FIELDS.length; k++) {
            const f = INSET_FIELDS[k];
            const px = x0 + k * (pw + gap);
            const mid = top + ph / 2;
            ctx.lineWidth = 1;
            ctx.strokeStyle = this.fieldCss[f];
            ctx.globalAlpha = 0.5;
            ctx.strokeRect(px, top, pw, ph);
            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.moveTo(px, mid);
            ctx.lineTo(px + pw, mid);
            ctx.stroke();
            ctx.globalAlpha = 1;
            const ref = this.imageHits[rayIndex(0, f, CHIEF)];
            if (Number.isFinite(ref)) {
                for (let lane = LANES - 1; lane >= 0; lane--) {
                    ctx.strokeStyle = lane === 0 ? this.fieldCss[f] : laneCss[lane];
                    ctx.globalAlpha = lane === 0 ? 0.9 : 1;
                    ctx.beginPath();
                    let started = false;
                    for (let i = 0; i < RAYS; i++) {
                        const y = this.imageHits[rayIndex(lane, f, i)];
                        if (!Number.isFinite(y)) { started = false; continue; }
                        const x = px + (i / (RAYS - 1)) * pw;
                        const yy = mid - ((y - ref) / epsMax) * (ph / 2 - 3);
                        if (!started) { ctx.moveTo(x, yy); started = true; }
                        else ctx.lineTo(x, yy);
                    }
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            }
            ctx.fillStyle = this.fieldCss[f];
            ctx.font = `8px ${MONO}`;
            ctx.textAlign = 'left';
            ctx.fillText(`${(Math.abs(FIELD_FRAC[f]) * maxFieldDeg).toFixed(1)}°`, px + 3, top + 9);
        }
        ctx.fillStyle = textCss;
        ctx.font = `8px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillText(`RAY FAN  εy ±${epsMax.toFixed(3)}mm  vs PUPIL`, x0, top + ph + 10);
    }
}

export const lensBenchDef: VizModeDef = {
    id: 'lens-bench',
    name: 'LENS BENCH',
    create: () => new LensBenchMode(),
};
