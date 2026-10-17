/**
 * TANK FIELD scene geometry: a yawing pinhole camera, flat-shaded convex
 * solids, and BZFlag's low-LOD tank.
 *
 * World axes: +x right, +y up, +z ahead (the direction of travel). Every
 * solid is two rings of four vertices; the faces are both rings plus the four
 * quads between them. That one topology covers a hull profile extruded across
 * its width, a turret frustum, a tapering barrel, and an axis-aligned box.
 */

/** Tank vertex tables from BZFlag 2.4's low-LOD model (src/geometry/models/tank/low_*.cxx). */
type Ring = readonly [number, number, number][];

/** A profile in (x forward, z up), extruded across y. */
function extrudeProfile(profile: readonly [number, number][], y0: number, y1: number): number[] {
    const out: number[] = [];
    for (const y of [y0, y1]) for (const [x, z] of profile) out.push(x, y, z);
    return out;
}

function rings(a: Ring, b: Ring): number[] {
    return [...a.flat(), ...b.flat()];
}

const HULL: readonly [number, number][] = [[2.575, 1.111], [-2.835, 1.238], [-2.229, 0.2], [2.43, 0.2]];
const TREAD: readonly [number, number][] = [[2.73, 1.294], [-2.97, 1.41], [-2.229, 0], [2.597, 0]];
const TURRET: Ring = [[1.48, 0.516, 1.04], [1.58, 0.434, 1.79], [-1.37, 0.765, 2.05], [-0.456, 1.06, 1.04]];
const mirrorY = (r: Ring): Ring => r.map(([x, y, z]) => [x, -y, z] as [number, number, number]);

/**
 * Tank parts in draw order (treads, hull, turret, barrel), in tank space:
 * +x forward, +y left, +z up, origin on the ground under the hull.
 */
export const TANK_PARTS: readonly Float32Array[] = [
    extrudeProfile(TREAD, 1.4, 0.877),
    extrudeProfile(TREAD, -0.877, -1.4),
    extrudeProfile(HULL, 0.877, -0.877),
    rings(TURRET, mirrorY(TURRET)),
    rings(
        [[1.57, 0, 1.71], [1.57, 0.18, 1.53], [1.57, 0, 1.35], [1.57, -0.18, 1.53]],
        [[4.94, 0, 1.66], [4.94, 0.126, 1.535], [4.94, 0, 1.41], [4.94, -0.126, 1.535]],
    ),
].map((v) => new Float32Array(v));

/** Parts that take the team color; the barrel is a darker steel. */
export const TANK_PART_TONE = [0.55, 0.55, 1, 0.9, 0.42] as const;

/** Faces of the two-ring solid, each listed as vertex indices. */
const FACES: readonly (readonly number[])[] = [
    [0, 1, 2, 3], [7, 6, 5, 4],
    [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
];

/** Light from high behind the camera's right shoulder. */
const SUN = (() => {
    const v = [0.45, 0.8, -0.4];
    const l = Math.hypot(v[0], v[1], v[2]);
    return v.map((c) => c / l);
})();

export const NEAR = 1;

/** Yawing pinhole camera at the eye; positive yaw turns right. */
export class Camera {
    z = 0;
    y = 1.57;
    yaw = 0;
    f = 800;
    cx = 0;
    cy = 0;
    private cos = 1;
    private sin = 0;
    /** Scratch results of the last `toCamera` / `project`. */
    rx = 0;
    ry = 0;
    rz = 0;
    sx = 0;
    sy = 0;

    set(z: number, yaw: number, f: number, cx: number, cy: number): void {
        this.z = z;
        this.yaw = yaw;
        this.f = f;
        this.cx = cx;
        this.cy = cy;
        this.cos = Math.cos(yaw);
        this.sin = Math.sin(yaw);
    }

    /** World point → camera space (rx right, ry up, rz depth). */
    toCamera(x: number, y: number, z: number): void {
        const dz = z - this.z;
        this.rx = x * this.cos - dz * this.sin;
        this.rz = x * this.sin + dz * this.cos;
        this.ry = y - this.y;
    }

    /** World point → screen. False when behind the near plane. */
    project(x: number, y: number, z: number): boolean {
        this.toCamera(x, y, z);
        if (this.rz < NEAR) return false;
        this.sx = this.cx + this.rx * this.f / this.rz;
        this.sy = this.cy - this.ry * this.f / this.rz;
        return true;
    }

    /** Stroke a world segment, clipped to the near plane. */
    segment(ctx: CanvasRenderingContext2D, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
        this.toCamera(x0, y0, z0);
        let ax = this.rx, ay = this.ry, az = this.rz;
        this.toCamera(x1, y1, z1);
        let bx = this.rx, by = this.ry, bz = this.rz;
        if (az < NEAR && bz < NEAR) return;
        if (az < NEAR) {
            const t = (NEAR - az) / (bz - az);
            ax += (bx - ax) * t; ay += (by - ay) * t; az = NEAR;
        } else if (bz < NEAR) {
            const t = (NEAR - bz) / (az - bz);
            bx += (ax - bx) * t; by += (ay - by) * t; bz = NEAR;
        }
        ctx.moveTo(this.cx + ax * this.f / az, this.cy - ay * this.f / az);
        ctx.lineTo(this.cx + bx * this.f / bz, this.cy - by * this.f / bz);
    }
}

/** Fill for a face, given its lambert term (0..1) and its outward normal. */
export type FaceFill = (light: number, nx: number, ny: number, nz: number) => string | null;

const sx = new Float32Array(8);
const sy = new Float32Array(8);

/**
 * Draw a two-ring solid given in world space (24 floats), back faces culled.
 * Faces are oriented outward from the centroid, so the vertex tables need no
 * consistent winding. Skipped whole if any vertex is behind the near plane.
 */
export function drawSolid(ctx: CanvasRenderingContext2D, cam: Camera, v: Float32Array, fill: FaceFill, edge: string | null = null): void {
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < 8; i++) {
        if (!cam.project(v[i * 3], v[i * 3 + 1], v[i * 3 + 2])) return;
        sx[i] = cam.sx;
        sy[i] = cam.sy;
        gx += v[i * 3]; gy += v[i * 3 + 1]; gz += v[i * 3 + 2];
    }
    gx /= 8; gy /= 8; gz /= 8;
    for (const f of FACES) {
        const a = f[0] * 3, b = f[1] * 3, c = f[2] * 3, d = f[3] * 3;
        // Diagonals give a robust normal even for slightly non-planar quads.
        const ux = v[c] - v[a], uy = v[c + 1] - v[a + 1], uz = v[c + 2] - v[a + 2];
        const wx = v[d] - v[b], wy = v[d + 1] - v[b + 1], wz = v[d + 2] - v[b + 2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        nx /= len; ny /= len; nz /= len;
        const fx = (v[a] + v[b] + v[c] + v[d]) / 4;
        const fy = (v[a + 1] + v[b + 1] + v[c + 1] + v[d + 1]) / 4;
        const fz = (v[a + 2] + v[b + 2] + v[c + 2] + v[d + 2]) / 4;
        if (nx * (fx - gx) + ny * (fy - gy) + nz * (fz - gz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
        // Camera position is (0, cam.y, cam.z) in world space.
        if (nx * (0 - fx) + ny * (cam.y - fy) + nz * (cam.z - fz) <= 0) continue;
        const css = fill(Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]), nx, ny, nz);
        if (css === null) continue;
        ctx.beginPath();
        ctx.moveTo(sx[f[0]], sy[f[0]]);
        for (let k = 1; k < 4; k++) ctx.lineTo(sx[f[k]], sy[f[k]]);
        ctx.closePath();
        ctx.fillStyle = css;
        ctx.fill();
        if (edge) {
            ctx.strokeStyle = edge;
            ctx.stroke();
        }
    }
}

/** World-space vertices of tank part `part` at (px, pz) facing `heading` (0 = +z). */
export function placeTank(part: Float32Array, px: number, pz: number, heading: number, scale: number, out: Float32Array): void {
    const s = Math.sin(heading), c = Math.cos(heading);
    for (let i = 0; i < 8; i++) {
        const lx = part[i * 3] * scale, ly = part[i * 3 + 1] * scale, lz = part[i * 3 + 2] * scale;
        // Forward is (sin, cos) in (x, z); left of it is (−cos, sin).
        out[i * 3] = px + lx * s - ly * c;
        out[i * 3 + 1] = lz;
        out[i * 3 + 2] = pz + lx * c + ly * s;
    }
}

/** Axis-aligned box as a two-ring solid. */
export function boxSolid(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, out: Float32Array): void {
    const pts = [[x0, y0], [x0, y1], [x1, y1], [x1, y0]];
    for (let r = 0; r < 2; r++) {
        const z = r === 0 ? z0 : z1;
        for (let i = 0; i < 4; i++) {
            const o = (r * 4 + i) * 3;
            out[o] = pts[i][0]; out[o + 1] = pts[i][1]; out[o + 2] = z;
        }
    }
}

/**
 * Square pyramid centred on (x, z): four sides, painter-ordered and culled.
 * `fill` gets the side index: 0 front (−z), 1 right, 2 back, 3 left.
 */
export function drawPyramid(ctx: CanvasRenderingContext2D, cam: Camera, x: number, z: number, half: number, height: number,
    fill: (side: number) => string, edge: string | null): void {
    const corners = [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]];
    for (const [cx, cz] of corners) if (!cam.project(cx, 0, cz)) return;
    if (!cam.project(x, height, z)) return;
    const ax = cam.sx, ay = cam.sy;
    for (let side = 0; side < 4; side++) {
        const [x0, z0] = corners[side];
        const [x1, z1] = corners[(side + 1) % 4];
        // The side's outward normal is (mx·h, half², mz·h), with m the step
        // from the centre to the base edge's midpoint; divided through by h.
        const fx = (x0 + x1) / 2, fz = (z0 + z1) / 2;
        const mx = fx - x, mz = fz - z;
        if (mx * (0 - fx) + mz * (cam.z - fz) + (half * half / height) * cam.y <= 0) continue;
        cam.project(x0, 0, z0);
        const bx = cam.sx, by = cam.sy;
        cam.project(x1, 0, z1);
        ctx.beginPath();
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cam.sx, cam.sy); ctx.closePath();
        ctx.fillStyle = fill(side);
        ctx.fill();
        if (edge) {
            ctx.strokeStyle = edge;
            ctx.stroke();
        }
    }
}
