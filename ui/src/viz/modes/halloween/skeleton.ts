/**
 * A stick-figure skeleton that dances. `skeletonPose` writes 14 joints into a
 * reused buffer from the beat clock and a few knobs; `drawSkeleton` strokes
 * the bones, `drawSilhouette` fills the same figure in one colour for a lit
 * window. Pure functions: no state, no allocation per frame.
 *
 * Joint space: x across, y up, the feet on y = 0 and the skull near y = -0.93,
 * so a figure is about one unit tall. `scale` is that unit in pixels.
 */

import {TAU, beatEnv} from '../../util.js';

export const JOINTS = 14;
export const SKULL = 0;
const NECK = 1;
const CHEST = 2;
const PELVIS = 3;
const SHOULDER_L = 4;
const SHOULDER_R = 5;
const ELBOW_L = 6;
const ELBOW_R = 7;
const HAND_L = 8;
const HAND_R = 9;
const KNEE_L = 10;
const KNEE_R = 11;
const FOOT_L = 12;
const FOOT_R = 13;

const SKULL_R = 0.075;
/** Bone pairs, as joint indices. */
const BONES: readonly [number, number][] = [
    [NECK, CHEST], [CHEST, PELVIS],
    [SHOULDER_L, SHOULDER_R],
    [SHOULDER_L, ELBOW_L], [ELBOW_L, HAND_L],
    [SHOULDER_R, ELBOW_R], [ELBOW_R, HAND_R],
    [PELVIS, KNEE_L], [KNEE_L, FOOT_L],
    [PELVIS, KNEE_R], [KNEE_R, FOOT_R],
];

export type Pose = Float32Array;

export function makePose(): Pose {
    return new Float32Array(JOINTS * 2);
}

function set(out: Pose, j: number, x: number, y: number): void {
    out[j * 2] = x;
    out[j * 2 + 1] = y;
}

/**
 * The figure at `beat` (fractional beats; the dance repeats every two).
 * `intensity` 0..1 scales the moves, `style` 0..3 picks one, `up` 0..1 sinks
 * the figure into the ground, `reach` 0..1 lifts the arms from hips to high.
 */
export function skeletonPose(out: Pose, beat: number, intensity: number, style: number, up: number, reach: number): void {
    const phase = beat - Math.floor(beat);
    const alt = (Math.floor(beat) & 1) === 0 ? 1 : -1;
    const env = beatEnv(phase);
    const sway = Math.sin(TAU * beat / 2);
    const k = intensity;
    const bounce = -0.035 * env * k;

    // Trunk.
    const lean = style === 0 ? 0.08 * sway * k : style === 1 ? 0.04 * sway * k : 0;
    const hipX = style === 1 ? 0.05 * sway * k : 0;
    set(out, PELVIS, hipX, -0.5 + bounce);
    set(out, CHEST, hipX + lean * 0.5, -0.7 + bounce);
    set(out, NECK, hipX + lean, -0.85 + bounce);
    const nod = style === 3 ? 0.05 * env * k : 0;
    set(out, SKULL, hipX + lean + (style === 3 ? 0.02 * sway * k : 0), -0.85 - SKULL_R - 0.015 + nod + bounce);
    const twist = style === 1 ? 0.04 * Math.sin(TAU * beat) * k : 0;
    set(out, SHOULDER_L, hipX + lean - 0.14 + twist, -0.82 + bounce);
    set(out, SHOULDER_R, hipX + lean + 0.14 - twist, -0.82 + bounce);

    // Arms: hands rest by the hips, rise toward overhead with `reach`,
    // and each style swings them differently.
    const restY = -0.46;
    const highY = -1.08;
    let lx: number, ly: number, rx: number, ry: number;
    switch (style) {
        case 0: { // arms up, waving side to side
            const w = 0.12 * sway * k;
            lx = -0.26 + w; ly = -1.02 - 0.05 * k;
            rx = 0.26 + w; ry = -1.02 - 0.05 * k;
            break;
        }
        case 1: { // shimmy: arms bent, hands out at chest height, pumping
            const p = 0.06 * Math.sin(TAU * beat * 2) * k;
            lx = -0.34; ly = -0.66 + p;
            rx = 0.34; ry = -0.66 - p;
            break;
        }
        case 2: { // kick-step: arms swing against the legs
            const sw = 0.2 * alt * k * (1 - phase * 0.4);
            lx = -0.18 + sw; ly = -0.6 - 0.1 * k;
            rx = 0.18 - sw; ry = -0.6 - 0.1 * k;
            break;
        }
        default: { // head-bob: arms hang, elbows bending on the beat
            lx = -0.2 - 0.04 * env * k; ly = restY - 0.12 * env * k;
            rx = 0.2 + 0.04 * env * k; ry = restY - 0.12 * env * k;
        }
    }
    // Reach lifts whatever the style left.
    ly = ly + (highY - ly) * reach * (style === 0 ? 0.2 : 1);
    ry = ry + (highY - ry) * reach * (style === 0 ? 0.2 : 1);
    lx += hipX + lean;
    rx += hipX + lean;
    set(out, HAND_L, lx, ly + bounce);
    set(out, HAND_R, rx, ry + bounce);
    // Elbows sit off the shoulder-hand line, outward.
    elbow(out, SHOULDER_L, HAND_L, ELBOW_L, -1);
    elbow(out, SHOULDER_R, HAND_R, ELBOW_R, 1);

    // Legs.
    const lift = style === 2 ? 0.16 * env * k : 0.04 * env * k;
    const stepL = alt > 0 ? lift : 0;
    const stepR = alt > 0 ? 0 : lift;
    set(out, KNEE_L, hipX - 0.08 - stepL * 0.6, -0.27 - stepL * 0.8 + bounce * 0.5);
    set(out, KNEE_R, hipX + 0.08 + stepR * 0.6, -0.27 - stepR * 0.8 + bounce * 0.5);
    set(out, FOOT_L, -0.1 - stepL * 0.4, -stepL * 1.2);
    set(out, FOOT_R, 0.1 + stepR * 0.4, -stepR * 1.2);

    // Sink: everything below the ground line is clamped to it.
    if (up < 1) {
        const drop = (1 - up) * 1.1;
        for (let j = 0; j < JOINTS; j++) {
            const y = out[j * 2 + 1] + drop;
            out[j * 2 + 1] = y > 0 ? 0 : y;
        }
    }
}

function elbow(out: Pose, a: number, b: number, e: number, side: number): void {
    const ax = out[a * 2], ay = out[a * 2 + 1];
    const bx = out[b * 2], by = out[b * 2 + 1];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    // The upper and lower arm are 0.2 each; bend to make up the slack.
    const slack = Math.max(0, 0.4 - len) * 0.5;
    const bend = Math.sqrt(Math.max(0.0004, 0.04 - (len / 2) * (len / 2))) * 0.9 + slack;
    set(out, e, mx + side * (-dy / len) * bend * side, my + side * (dx / len) * bend * side);
}

/** Strokes the bones and fills the skull. Joints at y = 0 are on the ground and bones lying on it are skipped. */
export function drawSkeleton(ctx: CanvasRenderingContext2D, pose: Pose, x: number, groundY: number, scale: number, bone: string, socket: string, eye: string | null): void {
    ctx.strokeStyle = bone;
    ctx.lineWidth = Math.max(1, 0.055 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of BONES) {
        const ay = pose[a * 2 + 1], by = pose[b * 2 + 1];
        if (ay >= 0 && by >= 0) continue;
        ctx.moveTo(x + pose[a * 2] * scale, groundY + ay * scale);
        ctx.lineTo(x + pose[b * 2] * scale, groundY + by * scale);
    }
    // Ribs across the spine.
    const nx = pose[NECK * 2], ny = pose[NECK * 2 + 1];
    const px = pose[PELVIS * 2], py = pose[PELVIS * 2 + 1];
    for (let i = 1; i <= 3; i++) {
        const t = 0.2 + i * 0.17;
        const cy = ny + (py - ny) * t;
        if (cy >= 0) continue;
        const cx = nx + (px - nx) * t;
        const hw = (0.11 - i * 0.015) * scale;
        ctx.moveTo(x + cx * scale - hw, groundY + cy * scale);
        ctx.lineTo(x + cx * scale + hw, groundY + cy * scale);
    }
    ctx.stroke();

    const sy = pose[SKULL * 2 + 1];
    if (sy >= 0) return;
    const sx = x + pose[SKULL * 2] * scale;
    const cy = groundY + sy * scale;
    const r = SKULL_R * scale;
    ctx.fillStyle = bone;
    ctx.beginPath();
    ctx.arc(sx, cy, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = socket;
    ctx.beginPath();
    ctx.arc(sx - r * 0.38, cy - r * 0.1, r * 0.26, 0, TAU);
    ctx.arc(sx + r * 0.38, cy - r * 0.1, r * 0.26, 0, TAU);
    ctx.fill();
    ctx.fillRect(sx - r * 0.3, cy + r * 0.45, r * 0.6, Math.max(1, r * 0.14));
    if (eye) {
        ctx.fillStyle = eye;
        ctx.beginPath();
        ctx.arc(sx - r * 0.38, cy - r * 0.1, r * 0.11, 0, TAU);
        ctx.arc(sx + r * 0.38, cy - r * 0.1, r * 0.11, 0, TAU);
        ctx.fill();
    }
}

/** The figure as one dark shape, for a dancer seen through a window. */
export function drawSilhouette(ctx: CanvasRenderingContext2D, pose: Pose, x: number, groundY: number, scale: number, fill: string): void {
    ctx.strokeStyle = fill;
    ctx.fillStyle = fill;
    ctx.lineWidth = Math.max(1.5, 0.11 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of BONES) {
        ctx.moveTo(x + pose[a * 2] * scale, groundY + pose[a * 2 + 1] * scale);
        ctx.lineTo(x + pose[b * 2] * scale, groundY + pose[b * 2 + 1] * scale);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + pose[SHOULDER_L * 2] * scale, groundY + pose[SHOULDER_L * 2 + 1] * scale);
    ctx.lineTo(x + pose[SHOULDER_R * 2] * scale, groundY + pose[SHOULDER_R * 2 + 1] * scale);
    ctx.lineTo(x + (pose[PELVIS * 2] + 0.09) * scale, groundY + pose[PELVIS * 2 + 1] * scale);
    ctx.lineTo(x + (pose[PELVIS * 2] - 0.09) * scale, groundY + pose[PELVIS * 2 + 1] * scale);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + pose[SKULL * 2] * scale, groundY + pose[SKULL * 2 + 1] * scale, SKULL_R * 1.1 * scale, 0, TAU);
    ctx.fill();
}
