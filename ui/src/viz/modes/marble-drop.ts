/**
 * MARBLE DROP — Galton-board peg field played like a drum machine: kicks drop
 * big magenta marbles on the left, snares yellow in the center, hats small
 * cyan on the right, plus an 8th-note baseline while audio is active.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TAU, TransientDetector} from '../util.js';

interface Marble {
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    hue: number;
    /** Cooldown to avoid registering the same peg-collision frame-after-frame. */
    cooldown: number;
    /** Fades on exit so the marble doesn't pop out. */
    life: number;
}

interface Peg {
    x: number;
    y: number;
    radius: number;
    /** Recent-hit glow, fades each frame. */
    hit: number;
}

interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
    hue: number;
}

class MarbleDropMode implements VizMode {
    private marbles: Marble[] = [];
    private pegs: Peg[] = [];
    private particles: Spark[] = [];
    private lastBeatIndex = -1;
    private readonly transients = new TransientDetector(0.06, 0.05, 0.035);
    private width = 0;

    layout(s: VizServices): void {
        this.width = s.width;
        this.pegs.length = 0;
        if (s.width === 0 || s.height === 0) return;

        const w = s.width;
        const h = s.height;

        // Reserve a top spawn strip and a bottom exit strip
        const topMargin = 60;
        const bottomMargin = 40;
        const fieldH = h - topMargin - bottomMargin;
        if (fieldH < 80) return;

        // Row spacing scales with canvas — fewer rows on a small editor
        const rowSpacing = Math.max(34, Math.min(56, h / 12));
        const rows = Math.max(4, Math.floor(fieldH / rowSpacing));
        const colSpacing = Math.max(48, Math.min(72, w / 14));
        const cols = Math.max(5, Math.floor(w / colSpacing));
        const pegRadius = 3;

        for (let r = 0; r < rows; r++) {
            const y = topMargin + (r + 0.5) * (fieldH / rows);
            const offset = (r % 2) * (colSpacing * 0.5);
            for (let c = 0; c < cols; c++) {
                const x = offset + (c + 0.5) * colSpacing;
                if (x < 12 || x > w - 12) continue;
                this.pegs.push({ x, y, radius: pegRadius, hit: 0 });
            }
        }
    }

    private spawnMarble(xFrac: number, hue: number, radius: number = 4.5): void {
        const margin = 24;
        const x = margin + xFrac * (this.width - margin * 2);
        this.marbles.push({
            x,
            y: 12,
            vx: (Math.random() - 0.5) * 30,
            vy: 20 + Math.random() * 30,
            radius,
            hue,
            cooldown: 0,
            life: 1,
        });
    }

    update(dt: number, s: VizServices): void {
        if (this.pegs.length === 0) this.layout(s);
        this.width = s.width;
        const {low, mid, high} = s;

        // Gate baseline spawns on actual audio activity so silent intros stay
        // empty (the song's first ~8 cycles are pre-roll).
        const totalEnergy = low + mid + high;
        const isActive = totalEnergy > 0.18;

        if (isActive) {
            // Forced 8th-note baseline — dense enough that 16th-note drum
            // passages get visible support. Downbeats are accented.
            const beatIndex = Math.floor(s.cycle * 8);
            if (beatIndex !== this.lastBeatIndex) {
                const isDownbeat = ((beatIndex % 8) + 8) % 8 === 0; // first of bar
                this.lastBeatIndex = beatIndex;
                const xFrac = 0.40 + Math.random() * 0.20;
                this.spawnMarble(xFrac, s.theme.neonHue, isDownbeat ? 6.5 : 4.5);
            }
        } else {
            this.lastBeatIndex = -1; // reset so first beat after silence triggers
        }

        // Per-band transient lanes: kick left, snare center, hat right.
        const hits = this.transients.update(dt, low, mid, high);
        if (hits.kick) this.spawnMarble(0.04 + Math.random() * 0.14, s.theme.secondaryHue, 6);
        if (hits.snare) this.spawnMarble(0.22 + Math.random() * 0.18, s.theme.activeHue, 5);
        if (hits.hat) this.spawnMarble(0.78 + Math.random() * 0.18, s.theme.neonHue, 3.5);

        // ---- Physics ----
        const gravity = 320;
        const restitution = 0.58;
        const horizontalDamping = 0.98;
        const exitY = s.height - 20;

        for (let i = this.marbles.length - 1; i >= 0; i--) {
            const m = this.marbles[i];

            m.cooldown = Math.max(0, m.cooldown - dt);
            m.vy += gravity * dt;
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            m.vx *= horizontalDamping;

            // Wall bounce
            if (m.x < m.radius) {
                m.x = m.radius;
                m.vx = -m.vx * restitution;
            } else if (m.x > s.width - m.radius) {
                m.x = s.width - m.radius;
                m.vx = -m.vx * restitution;
            }

            // Peg collision — only check pegs near this marble's y
            if (m.cooldown <= 0) {
                for (let p = 0; p < this.pegs.length; p++) {
                    const peg = this.pegs[p];
                    if (Math.abs(peg.y - m.y) > 22) continue;

                    const dx = m.x - peg.x;
                    const dy = m.y - peg.y;
                    const r = m.radius + peg.radius;
                    const d2 = dx * dx + dy * dy;
                    if (d2 > r * r) continue;

                    const d = Math.sqrt(d2) || 0.0001;
                    const nx = dx / d;
                    const ny = dy / d;

                    // Push marble out of peg
                    m.x = peg.x + nx * r;
                    m.y = peg.y + ny * r;

                    // Reflect velocity around normal; add small horizontal jitter
                    // so two marbles hitting the same peg don't fall identically.
                    const vDotN = m.vx * nx + m.vy * ny;
                    m.vx = (m.vx - 2 * vDotN * nx) * restitution + (Math.random() - 0.5) * 30;
                    m.vy = (m.vy - 2 * vDotN * ny) * restitution;

                    peg.hit = 1;
                    m.cooldown = 0.04; // skip next ~2 frames of peg checks

                    // Small spark
                    this.particles.push({
                        x: peg.x,
                        y: peg.y,
                        vx: (Math.random() - 0.5) * 60,
                        vy: -Math.random() * 40,
                        life: 0.35,
                        size: 1.5,
                        hue: m.hue,
                    });
                    break;
                }
            }

            // Exit / fade
            if (m.y > exitY) m.life -= dt * 2.2;
            if (m.life <= 0 || m.y > s.height + 30) {
                this.marbles.splice(i, 1);
            }
        }

        // Cap total marbles to keep cost bounded.
        const MAX_MARBLES = 140;
        if (this.marbles.length > MAX_MARBLES) {
            this.marbles.splice(0, this.marbles.length - MAX_MARBLES);
        }

        // Peg hit-glow decay
        for (const peg of this.pegs) {
            peg.hit *= 0.88;
        }

        // Spark particle update
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += gravity * dt * 0.5;
            p.life -= dt * 2.5;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const {width: w, height: h} = s;
        const neonHue = s.theme.neonHue;

        // Static peg grid — translucent so the code stays readable behind
        for (const peg of this.pegs) {
            const hit = peg.hit;
            if (hit > 0.05) {
                ctx.fillStyle = `hsla(${neonHue}, 92%, 80%, ${hit * 0.35})`;
                ctx.beginPath();
                ctx.arc(peg.x, peg.y, peg.radius * 4 * (1 + hit), 0, TAU);
                ctx.fill();
            }
            ctx.fillStyle = `hsla(${neonHue}, 60%, 70%, ${0.18 + hit * 0.5})`;
            ctx.beginPath();
            ctx.arc(peg.x, peg.y, peg.radius, 0, TAU);
            ctx.fill();
        }

        // Floor line — a faint guide where marbles exit
        ctx.strokeStyle = `hsla(${neonHue}, 80%, 60%, 0.12)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h - 20);
        ctx.lineTo(w, h - 20);
        ctx.stroke();

        // Spark trails from peg hits
        for (const p of this.particles) {
            const a = Math.max(0.05, p.life);
            ctx.fillStyle = `hsla(${p.hue}, 95%, 78%, ${a * 0.55})`;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }

        // Marbles — motion trail + glow halo + bright core + glassy highlight
        for (const m of this.marbles) {
            const life = Math.min(1, m.life);
            const fadeOut = m.y > h - 60 ? life : 1;
            const haloAlpha = 0.18 * fadeOut;
            const coreAlpha = 0.78 * fadeOut;

            // Velocity-aligned trail — gives marbles a "drop streak" without
            // per-frame history tracking.
            const speed = Math.hypot(m.vx, m.vy);
            if (speed > 30) {
                const trailLen = Math.min(m.radius * 5, speed * 0.06);
                const nx = -m.vx / speed * trailLen;
                const ny = -m.vy / speed * trailLen;
                const grad = ctx.createLinearGradient(m.x, m.y, m.x + nx, m.y + ny);
                grad.addColorStop(0, `hsla(${m.hue}, 95%, 75%, ${0.55 * fadeOut})`);
                grad.addColorStop(1, `hsla(${m.hue}, 95%, 75%, 0)`);
                ctx.strokeStyle = grad;
                ctx.lineWidth = m.radius * 1.4;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(m.x, m.y);
                ctx.lineTo(m.x + nx, m.y + ny);
                ctx.stroke();
            }

            ctx.fillStyle = `hsla(${m.hue}, 95%, 70%, ${haloAlpha})`;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.radius * 3.5, 0, TAU);
            ctx.fill();

            ctx.fillStyle = `hsla(${m.hue}, 95%, 82%, ${coreAlpha})`;
            ctx.beginPath();
            ctx.arc(m.x, m.y, m.radius, 0, TAU);
            ctx.fill();

            // Highlight dot — gives the marble a glassy look
            ctx.fillStyle = `hsla(0, 0%, 100%, ${0.65 * fadeOut})`;
            ctx.beginPath();
            ctx.arc(m.x - m.radius * 0.35, m.y - m.radius * 0.35, m.radius * 0.32, 0, TAU);
            ctx.fill();
        }
    }
}

export const marbleDropDef: VizModeDef = {
    id: 'marble-drop',
    name: 'MARBLE DROP',
    create: () => new MarbleDropMode(),
};
