/**
 * Fullscreen Immersive Visualizations for Robostrudel
 *
 * Music-reactive canvas modes intended for large-screen / live-performance use.
 * Two flavors:
 *  - NeonCircuit: network of nodes + flowing traces. Node pulses lock to the
 *    pattern cycle; particles ride FFT energy.
 *  - MarbleCore: concentric rings rotating at integer multiples of the cycle
 *    ("clockwork" feel), with orbiting orbs and an FFT-driven core glow.
 *
 * Design notes:
 * - Motion is driven by the scheduler's cycle position (via `updateCycle`) so
 *   the viz visibly locks to musical time. FFT only modulates intensity, not
 *   timing.
 * - Palette is pulled from the app's CSS variables (--neon, --neon-secondary,
 *   --viz-hot, --viz-active) so it tracks any theme changes.
 * - Canvas 2D only — no extra runtime deps.
 */

export enum FullscreenVizMode {
    NeonCircuit = 0,
    MarbleCore = 1,
    MarbleDrop = 2,
}

const MODE_COUNT = 3;
const TAU = Math.PI * 2;

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
    hue: number;
}

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

interface Theme {
    bg: string;
    neon: string;          // primary cyan
    neonSecondary: string; // magenta
    active: string;        // yellow accent
    violet: string;
    /** Hue components parsed once, for cheap hsla() construction in the hot path. */
    neonHue: number;
    secondaryHue: number;
    activeHue: number;
}

export class FullscreenVisualizer {
    static readonly MODE_COUNT = MODE_COUNT;

    private readonly container: HTMLDivElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;

    private analyser: AnalyserNode | null = null;
    private freqData: Uint8Array | null = null;
    private timeData: Uint8Array | null = null;

    private mode: FullscreenVizMode = FullscreenVizMode.NeonCircuit;
    private sensitivity = 1.0;

    private width = 0;
    private height = 0;
    private dpr = 1;

    private running = false;
    private animationId: number | null = null;
    private lastFrame = 0;
    private currentCycle = 0;

    private particles: Particle[] = [];
    private nodes: Array<{ x: number; y: number; offset: number }> = [];
    private rings: Array<{ radius: number; cyclesPerRev: number; phaseOffset: number; hue: number }> = [];
    private orbs: Array<{ baseAngle: number; cyclesPerRev: number; radius: number; size: number; hue: number }> = [];

    // MarbleDrop state
    private marbles: Marble[] = [];
    private pegs: Peg[] = [];
    private lastBeatIndex = -1;
    private highTransientCooldown = 0;
    private midTransientCooldown = 0;
    private lowTransientCooldown = 0;
    private prevHighEnergy = 0;
    private prevMidEnergy = 0;
    private prevLowEnergy = 0;

    private scanlineOffset = 0;

    private theme: Theme = {
        bg: '#05060a',
        neon: '#47f6ff',
        neonSecondary: '#ff2bd6',
        active: '#f7ff5a',
        violet: '#9d7cff',
        neonHue: 185,
        secondaryHue: 315,
        activeHue: 55,
    };

    private lowEnergy = 0;
    private midEnergy = 0;
    private highEnergy = 0;

    private resizeObserver: ResizeObserver | null = null;
    private resizeRaf: number | null = null;

    constructor(container: HTMLDivElement) {
        this.container = container;

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block; width:100%; height:100%;';
        this.container.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d', { alpha: false })!;

        // Observe the container directly so the canvas re-measures when side
        // panels collapse/expand — not just on window resize. Coalesce via rAF
        // so a drag-resize doesn't reallocate the bitmap on every notification.
        this.resizeObserver = new ResizeObserver(() => {
            if (this.resizeRaf !== null) return;
            this.resizeRaf = requestAnimationFrame(() => {
                this.resizeRaf = null;
                this.handleResize();
            });
        });
        this.resizeObserver.observe(this.container);
        // NOTE: initial geometry seeding still happens in start() — the
        // container is `hidden` until then, so getBoundingClientRect() = 0×0.
    }

    setAnalyser(analyser: AnalyserNode): void {
        this.analyser = analyser;
        const binCount = analyser.frequencyBinCount;
        this.freqData = new Uint8Array(binCount);
        this.timeData = new Uint8Array(binCount);
    }

    /** Called from the app's cycle-update callback so motion locks to musical time. */
    updateCycle(cycle: number): void {
        this.currentCycle = cycle;
    }

    getMode(): FullscreenVizMode {
        return this.mode;
    }

    setMode(mode: FullscreenVizMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.resetModeState();
        this.initModeGeometry();
    }

    /** Rotate forward (+1) or backward (-1) through available modes. */
    cycleMode(delta: number): FullscreenVizMode {
        const next = (((this.mode + delta) % MODE_COUNT) + MODE_COUNT) % MODE_COUNT;
        this.setMode(next as FullscreenVizMode);
        return this.mode;
    }

    setSensitivity(value: number): void {
        this.sensitivity = Math.max(0.3, Math.min(2.5, value));
    }

    private resetModeState(): void {
        this.particles.length = 0;
        this.nodes.length = 0;
        this.rings.length = 0;
        this.orbs.length = 0;
        this.marbles.length = 0;
        this.pegs.length = 0;
        this.lastBeatIndex = -1;
        this.highTransientCooldown = 0;
        this.midTransientCooldown = 0;
        this.lowTransientCooldown = 0;
        this.prevHighEnergy = 0;
        this.prevMidEnergy = 0;
        this.prevLowEnergy = 0;
        this.scanlineOffset = 0;
    }

    private refreshTheme(): void {
        const style = getComputedStyle(document.documentElement);
        const css = (name: string, fallback: string): string =>
            style.getPropertyValue(name).trim() || fallback;

        this.theme = {
            bg: css('--bg', '#05060a'),
            neon: css('--neon', '#47f6ff'),
            neonSecondary: css('--neon-secondary', '#ff2bd6'),
            active: css('--viz-active', '#f7ff5a'),
            violet: css('--violet', '#9d7cff'),
            neonHue: hueOf(css('--neon', '#47f6ff'), 185),
            secondaryHue: hueOf(css('--neon-secondary', '#ff2bd6'), 315),
            activeHue: hueOf(css('--viz-active', '#f7ff5a'), 55),
        };
    }

    handleResize = (): void => {
        const rect = this.container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        this.dpr = window.devicePixelRatio || 1;

        this.canvas.width = Math.floor(rect.width * this.dpr);
        this.canvas.height = Math.floor(rect.height * this.dpr);

        this.width = rect.width;
        this.height = rect.height;

        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

        this.initModeGeometry();
    };

    private initModeGeometry(): void {
        if (this.width === 0 || this.height === 0) return;

        const cx = this.width / 2;
        const cy = this.height / 2;

        if (this.mode === FullscreenVizMode.NeonCircuit) {
            this.nodes.length = 0;
            const count = Math.min(32, Math.max(12, Math.floor(Math.max(this.width, this.height) / 36)));
            for (let i = 0; i < count; i++) {
                const angle = (i / count) * TAU;
                const r = Math.min(this.width, this.height) * (0.22 + (i % 5) * 0.035);
                this.nodes.push({
                    x: cx + Math.cos(angle) * r,
                    y: cy + Math.sin(angle) * r * 0.72,
                    offset: (i / count) * TAU * 0.5,
                });
            }
        } else {
            this.rings.length = 0;
            this.orbs.length = 0;

            // Integer-ratio rotation rates → "clockwork" feel
            const ringSpec: Array<{ radius: number; cyclesPerRev: number; hueShift: number }> = [
                { radius: 80,  cyclesPerRev: 4, hueShift: 0   },
                { radius: 132, cyclesPerRev: 2, hueShift: 28  },
                { radius: 184, cyclesPerRev: 1, hueShift: 58  },
                { radius: 236, cyclesPerRev: 0.5, hueShift: 92 },
                { radius: 288, cyclesPerRev: 0.25, hueShift: 130 },
            ];
            for (let i = 0; i < ringSpec.length; i++) {
                const s = ringSpec[i];
                this.rings.push({
                    radius: s.radius,
                    cyclesPerRev: s.cyclesPerRev,
                    phaseOffset: i * 0.4,
                    hue: this.theme.neonHue + s.hueShift,
                });
            }

            const orbSpecs = [1, 2, 3, 4, 6, 8];
            for (let i = 0; i < orbSpecs.length; i++) {
                this.orbs.push({
                    baseAngle: (i / orbSpecs.length) * TAU,
                    cyclesPerRev: orbSpecs[i],
                    radius: 100 + (i % 3) * 44,
                    size: 4.5 + (i % 3),
                    hue: this.theme.neonHue + (i % 5) * 18,
                });
            }
        }

        if (this.mode === FullscreenVizMode.MarbleDrop) {
            this.initPegField();
        }
    }

    /**
     * Lay out a Galton-board / pachinko peg field: staggered rows of pegs
     * across the canvas. Marbles spawn at the top, fall under gravity, bounce
     * off pegs left/right, and exit the bottom.
     */
    private initPegField(): void {
        this.pegs.length = 0;
        if (this.width === 0 || this.height === 0) return;

        const w = this.width;
        const h = this.height;

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

    start(): void {
        if (this.running) return;
        this.refreshTheme();
        // Container is now visible — safe to measure and seed geometry.
        this.handleResize();
        this.running = true;
        this.lastFrame = performance.now();
        this.animationId = requestAnimationFrame(this.draw);
    }

    stop(): void {
        this.running = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    private readonly draw = (now: number): void => {
        if (!this.running) return;

        const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
        this.lastFrame = now;

        this.updateAudioFeatures();
        this.updateSimulation(dt);
        this.render();

        this.animationId = requestAnimationFrame(this.draw);
    };

    private updateAudioFeatures(): void {
        if (!this.analyser || !this.freqData || !this.timeData) return;

        // Cast is required by current TS DOM lib (ArrayBufferLike constraint).
        this.analyser.getByteFrequencyData(this.freqData as Uint8Array<ArrayBuffer>);
        this.analyser.getByteTimeDomainData(this.timeData as Uint8Array<ArrayBuffer>);

        const len = this.freqData.length;
        const lowEnd = Math.floor(len * 0.08);
        const midEnd = Math.floor(len * 0.35);

        let low = 0, mid = 0, high = 0;
        for (let i = 0; i < lowEnd; i++) low += this.freqData[i];
        for (let i = lowEnd; i < midEnd; i++) mid += this.freqData[i];
        for (let i = midEnd; i < len; i++) high += this.freqData[i];

        const inv255 = 1 / 255;
        this.lowEnergy  = (low  / (lowEnd || 1)) * inv255 * this.sensitivity;
        this.midEnergy  = (mid  / ((midEnd - lowEnd) || 1)) * inv255 * this.sensitivity;
        this.highEnergy = (high / ((len - midEnd) || 1)) * inv255 * this.sensitivity;
    }

    private updateSimulation(dt: number): void {
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const high = this.highEnergy;
        const energy = (low * 0.6 + mid * 0.9 + high * 0.7) * 0.6;

        switch (this.mode) {
            case FullscreenVizMode.NeonCircuit:
                this.updateNeonCircuit(dt, low, mid, high, energy);
                break;
            case FullscreenVizMode.MarbleCore:
                this.updateMarbleCore(dt, low, energy);
                break;
            case FullscreenVizMode.MarbleDrop:
                this.updateMarbleDrop(dt, low, high);
                break;
        }

        this.scanlineOffset = (this.scanlineOffset + dt * 18) % 4;
    }

    private updateMarbleDrop(dt: number, low: number, high: number): void {
        if (this.pegs.length === 0) this.initPegField();
        const mid = this.midEnergy;

        // ---- Spawn marbles ----
        //
        // We split the canvas into three "drum-machine lanes":
        //   left  (kicks/bass)   → low band   → magenta, biggest marble
        //   mid   (snares/toms)  → mid band   → yellow, mid marble
        //   right (hats/cymbals) → high band  → cyan,    smallest marble
        //
        // Each lane has its OWN consistent column so the same drum sound always
        // drops in the same place — that's what makes the rhythm legible.

        // Gate baseline spawns on actual audio activity so silent intros stay
        // empty (the song's first ~8 cycles are pre-roll).
        const totalEnergy = low + mid + high;
        const isActive = totalEnergy > 0.18;

        if (isActive) {
            // Forced 8th-note baseline — denser than before so 16th-note
            // drum passages get visible support. Downbeats are accented.
            const beatIndex = Math.floor(this.currentCycle * 8);
            if (beatIndex !== this.lastBeatIndex) {
                const isDownbeat = ((beatIndex % 8) + 8) % 8 === 0; // first of bar
                this.lastBeatIndex = beatIndex;
                // Baseline drop in a slightly randomized mid column (won't fight
                // with the drum lanes that hit on transients).
                const xFrac = 0.40 + Math.random() * 0.20;
                this.spawnMarble(xFrac, this.theme.neonHue, isDownbeat ? 6.5 : 4.5);
            }
        } else {
            this.lastBeatIndex = -1; // reset so first beat after silence triggers
        }

        // ---- Transient detection per band ----
        // Cooldowns prevent retriggers on sustained energy; deltas catch onset.
        this.highTransientCooldown = Math.max(0, this.highTransientCooldown - dt);
        this.midTransientCooldown  = Math.max(0, this.midTransientCooldown  - dt);
        this.lowTransientCooldown  = Math.max(0, this.lowTransientCooldown  - dt);
        const highDelta = high - this.prevHighEnergy;
        const midDelta  = mid  - this.prevMidEnergy;
        const lowDelta  = low  - this.prevLowEnergy;

        // Kicks: leftmost columns, big magenta marbles, longer cooldown so
        // sustained bass doesn't carpet-bomb. Threshold low enough to catch
        // 16th-note kick patterns.
        if (lowDelta > 0.08 && low > 0.25 && this.lowTransientCooldown <= 0) {
            this.spawnMarble(0.04 + Math.random() * 0.14, this.theme.secondaryHue, 6);
            this.lowTransientCooldown = 0.06;
        }

        // Snares / mid-band transients: center-left columns, yellow.
        if (midDelta > 0.09 && mid > 0.28 && this.midTransientCooldown <= 0) {
            this.spawnMarble(0.22 + Math.random() * 0.18, this.theme.activeHue, 5);
            this.midTransientCooldown = 0.05;
        }

        // Hi-hats / cymbals: rightmost columns, smaller cyan marbles, shortest
        // cooldown so 16th-note hat patterns visibly cascade.
        if (highDelta > 0.06 && high > 0.20 && this.highTransientCooldown <= 0) {
            this.spawnMarble(0.78 + Math.random() * 0.18, this.theme.neonHue, 3.5);
            this.highTransientCooldown = 0.035;
        }

        this.prevHighEnergy = high;
        this.prevMidEnergy  = mid;
        this.prevLowEnergy  = low;

        // ---- Physics ----
        const gravity = 320;
        const restitution = 0.58;
        const horizontalDamping = 0.98;
        const exitY = this.height - 20;

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
            } else if (m.x > this.width - m.radius) {
                m.x = this.width - m.radius;
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
            if (m.life <= 0 || m.y > this.height + 30) {
                this.marbles.splice(i, 1);
            }
        }

        // Cap total marbles to keep cost bounded — raised from 80 so dense
        // 16th-note passages don't flush previous cascades prematurely.
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

    private updateNeonCircuit(dt: number, _low: number, mid: number, high: number, energy: number): void {
        const cx = this.width / 2;
        const cy = this.height / 2;

        // Particle spawn rate tracks mid+high (transients)
        const spawnRate = (0.6 + mid * 1.8) * dt * 4;
        if (Math.random() < spawnRate) {
            const angle = Math.random() * TAU;
            const speed = 18 + high * 42 + Math.random() * 12;
            this.particles.push({
                x: cx + Math.cos(angle) * (40 + Math.random() * 80),
                y: cy + Math.sin(angle) * (30 + Math.random() * 60),
                vx: Math.cos(angle + (Math.random() - 0.5) * 0.8) * speed,
                vy: Math.sin(angle + (Math.random() - 0.5) * 0.8) * speed,
                life: 0.6 + energy * 0.9 + Math.random() * 0.5,
                size: 1.2 + high * 1.8,
                hue: this.theme.neonHue + (high - _low) * 35,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.985;
            p.vy *= 0.985;
            p.life -= dt * (0.7 + _low * 0.6);
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private updateMarbleCore(dt: number, low: number, _energy: number): void {
        // Rings & orbs are positioned from `currentCycle` directly in render —
        // here we only spawn FFT-driven impact particles on strong low hits.
        if (low > 0.55 && Math.random() < low * dt * 9) {
            const angle = Math.random() * TAU;
            const r = 70 + Math.random() * 160;
            this.particles.push({
                x: this.width / 2 + Math.cos(angle) * r,
                y: this.height / 2 + Math.sin(angle) * r * 0.6,
                vx: Math.cos(angle) * (22 + low * 35),
                vy: Math.sin(angle) * (18 + low * 28),
                life: 0.45 + low * 0.5,
                size: 2.5 + low * 3,
                hue: this.theme.activeHue + low * 30,
            });
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.96;
            p.vy *= 0.96;
            p.life -= dt * 1.4;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    private render(): void {
        const { ctx, width, height } = this;

        ctx.fillStyle = this.theme.bg;
        ctx.fillRect(0, 0, width, height);

        this.drawScanlines(ctx, width, height);

        switch (this.mode) {
            case FullscreenVizMode.NeonCircuit:
                this.renderNeonCircuit(ctx, width, height);
                break;
            case FullscreenVizMode.MarbleCore:
                this.renderMarbleCore(ctx, width, height);
                break;
            case FullscreenVizMode.MarbleDrop:
                this.renderMarbleDrop(ctx, width, height);
                break;
        }

        this.drawVignette(ctx, width, height);
    }

    private renderMarbleDrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const neonHue = this.theme.neonHue;

        // Static peg grid — translucent so the code stays readable behind
        for (const peg of this.pegs) {
            const hit = peg.hit;
            // Glow on recent hit
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

            // Velocity-aligned trail — gives marbles a "drop streak" that
            // reads beautifully on video without per-frame history tracking.
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

    private drawScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        ctx.strokeStyle = `hsla(${this.theme.neonHue}, 92%, 70%, 0.035)`;
        ctx.lineWidth = 1;

        const step = 3.6;
        let y = (this.scanlineOffset % step) - step;

        ctx.beginPath();
        while (y < h) {
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            y += step;
        }
        ctx.stroke();
    }

    private drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const grad = ctx.createRadialGradient(
            w * 0.5, h * 0.5, Math.min(w, h) * 0.35,
            w * 0.5, h * 0.5, Math.max(w, h) * 0.72,
        );
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.65)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    private renderNeonCircuit(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const high = this.highEnergy;
        const neonHue = this.theme.neonHue;
        const secondaryHue = this.theme.secondaryHue;
        const cx = w / 2;
        const cy = h / 2;

        // Cycle = 1 bar. Pulse at quarter-note (4×) for "beat" feel; downbeat
        // (1×) for once-per-bar accents. beatEnv = sharp attack, slow decay.
        const beat = beatEnv(this.currentCycle * 4);
        const downbeat = beatEnv(this.currentCycle);
        const cyclePhase = this.currentCycle * TAU;

        // Connections behind nodes — alpha pulses with the quarter-beat
        const beatBoost = 0.28 + beat * 0.55;
        ctx.lineWidth = 0.8 + beat * 1.4;
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i];
                const b = this.nodes[j];
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 260 || dist < 18) continue;

                const alpha = Math.max(0.08, 0.55 - dist / 260) * (0.4 + mid * 0.9) * beatBoost;
                ctx.strokeStyle = `hsla(${neonHue}, 92%, 68%, ${alpha})`;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }
        }

        // Particles (data packets)
        ctx.fillStyle = this.theme.neon;
        for (const p of this.particles) {
            const alpha = Math.max(0.15, p.life / 1.4);
            ctx.globalAlpha = alpha;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }
        ctx.globalAlpha = 1;

        // Nodes — radius driven by quarter-beat (1.0 → 0 each beat), much
        // bigger swing than before. Position breathes outward on the beat too.
        const breathePx = 12 * beat;
        for (const node of this.nodes) {
            // Offset per-node so nodes don't pulse in unison — gives a ripple
            const localBeat = beatEnv(this.currentCycle * 4 + node.offset * 0.25);
            const r = 3.5 + localBeat * 8 + high * 3;

            // Outward breathe — push nodes radially on the beat
            const dx = node.x - cx;
            const dy = node.y - cy;
            const d = Math.hypot(dx, dy) || 1;
            const px = node.x + (dx / d) * breathePx * 0.6;
            const py = node.y + (dy / d) * breathePx * 0.6;

            // Glow halo — translucent so code stays readable behind it
            ctx.fillStyle = `hsla(${neonHue}, 92%, 68%, ${0.04 + localBeat * 0.22})`;
            ctx.beginPath();
            ctx.arc(px, py, r * 3.2, 0, TAU);
            ctx.fill();

            // Core — also translucent, fully present only on the beat
            ctx.fillStyle = `hsla(${neonHue}, 92%, 70%, ${0.35 + localBeat * 0.55})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, TAU);
            ctx.fill();
        }

        // Downbeat shockwave — expanding ring from center on every bar
        if (downbeat > 0.02) {
            const t = 1 - downbeat;
            const ringR = Math.min(w, h) * 0.05 + t * Math.min(w, h) * 0.55;
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 70%, ${downbeat * 0.45})`;
            ctx.lineWidth = 1 + downbeat * 2.4;
            ctx.beginPath();
            ctx.arc(cx, cy, ringR, 0, TAU);
            ctx.stroke();
        }

        // Horizontal data bus — alpha also tracks the beat
        if (low > 0.2 || beat > 0.4) {
            const busAlpha = (0.2 + low * 0.35) * (0.4 + beat * 0.8);
            ctx.strokeStyle = `hsla(${secondaryHue}, 92%, 65%, ${busAlpha})`;
            ctx.lineWidth = 1.5 + low * 1.2 + beat * 1.5;
            const y = h * (0.28 + Math.sin(cyclePhase * 0.5) * 0.12);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }

    private renderMarbleCore(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const cx = w / 2;
        const cy = h / 2;
        const low = this.lowEnergy;
        const mid = this.midEnergy;
        const cyclePhase = this.currentCycle * TAU;
        const beat = beatEnv(this.currentCycle * 4);
        const downbeat = beatEnv(this.currentCycle);

        // Sweeping "playhead" arm — one revolution per bar, very obvious
        // cycle-locked motion.
        const armAngle = cyclePhase;
        const armOuter = Math.min(w, h) * 0.45;
        const armGrad = ctx.createLinearGradient(
            cx, cy,
            cx + Math.cos(armAngle) * armOuter,
            cy + Math.sin(armAngle) * armOuter,
        );
        armGrad.addColorStop(0, `hsla(${this.theme.neonHue}, 92%, 70%, 0)`);
        armGrad.addColorStop(1, `hsla(${this.theme.neonHue}, 92%, 72%, 0.28)`);
        ctx.strokeStyle = armGrad;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(armAngle) * armOuter, cy + Math.sin(armAngle) * armOuter);
        ctx.stroke();

        // Rings — rotation locked to integer ratios of the cycle. Brightness
        // pumps with quarter-beat so the cycle lock reads at a glance.
        for (const ring of this.rings) {
            const ringPhase = cyclePhase * ring.cyclesPerRev + ring.phaseOffset;
            const r = ring.radius + Math.sin(ringPhase) * (4 + low * 7) + downbeat * 6;
            // Each ring brightens when its own phase wraps — those local accents
            // are what make integer ratios visible.
            const ringBeat = beatEnv(ringPhase / TAU);
            const alpha = 0.22 + ringBeat * 0.4 + beat * 0.1;

            ctx.strokeStyle = `hsla(${ring.hue}, 88%, 72%, ${alpha})`;
            ctx.lineWidth = 1.6 + ringBeat * 1.8;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, TAU);
            ctx.stroke();

            // Longer, brighter tick marks — much more obvious rotation
            const tickCount = 8;
            const tickLen = 10 + ringBeat * 6;
            ctx.strokeStyle = `hsla(${ring.hue}, 95%, 82%, ${alpha * 0.9})`;
            ctx.lineWidth = 1.4;
            for (let i = 0; i < tickCount; i++) {
                const a = ringPhase + (i / tickCount) * TAU;
                const x1 = cx + Math.cos(a) * (r - tickLen * 0.5);
                const y1 = cy + Math.sin(a) * (r - tickLen * 0.5);
                const x2 = cx + Math.cos(a) * (r + tickLen * 0.5);
                const y2 = cy + Math.sin(a) * (r + tickLen * 0.5);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }

        // Orbs — orbit at integer rates with a beat-driven size pulse
        for (const orb of this.orbs) {
            const angle = orb.baseAngle + cyclePhase * orb.cyclesPerRev;
            const orbBeat = beatEnv(angle / TAU);
            const x = cx + Math.cos(angle) * orb.radius;
            const y = cy + Math.sin(angle) * orb.radius * 0.58;
            const sizeBoost = 1 + orbBeat * 1.4;

            ctx.fillStyle = `hsla(${orb.hue}, 95%, 75%, ${0.10 + orbBeat * 0.28})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * 2.6 * sizeBoost, 0, TAU);
            ctx.fill();

            ctx.fillStyle = `hsla(${orb.hue}, 92%, 82%, ${0.45 + orbBeat * 0.4})`;
            ctx.beginPath();
            ctx.arc(x, y, orb.size * sizeBoost, 0, TAU);
            ctx.fill();
        }

        // Impact particles
        for (const p of this.particles) {
            const a = Math.max(0.1, p.life / 1.1);
            ctx.fillStyle = `hsla(${p.hue}, 90%, 78%, ${a})`;
            ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
        }

        // FFT-reactive core glow
        const coreSize = 18 + (low + mid) * 11;
        const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, coreSize * 1.8);
        grad.addColorStop(0, `hsla(${this.theme.secondaryHue}, 90%, 60%, ${0.35 + (low + mid) * 0.25})`);
        grad.addColorStop(1, `hsla(${this.theme.neonHue}, 92%, 60%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, coreSize * 1.9, 0, TAU);
        ctx.fill();
    }

    destroy(): void {
        this.stop();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.resizeRaf !== null) {
            cancelAnimationFrame(this.resizeRaf);
            this.resizeRaf = null;
        }
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.particles.length = 0;
        this.nodes.length = 0;
        this.rings.length = 0;
        this.orbs.length = 0;
        this.marbles.length = 0;
        this.pegs.length = 0;
    }
}

/**
 * Beat envelope — sharp attack, fast decay across one beat. Takes a phase
 * value (cycles, not radians); returns 0..1. Snappy "drum hit" feel: ~30%
 * of the beat duration carries most of the energy, then it's flat.
 */
function beatEnv(phase: number): number {
    const t = phase - Math.floor(phase); // 0..1 within current beat
    // (1 - t)^4 → 1.0 at beat onset, fades sharply; back near 0 by t≈0.5
    const decay = 1 - t;
    const d2 = decay * decay;
    return d2 * d2;
}

/**
 * Extract a hue (0..360) from a CSS color string. Supports `#rrggbb`, `#rgb`,
 * and `hsl(h, ...)`. Falls back to the provided default if parsing fails.
 */
function hueOf(color: string, fallback: number): number {
    const c = color.trim();
    if (!c) return fallback;

    // hsl() / hsla()
    const hslMatch = c.match(/^hsla?\(\s*([-\d.]+)/i);
    if (hslMatch) {
        const h = parseFloat(hslMatch[1]);
        return Number.isFinite(h) ? ((h % 360) + 360) % 360 : fallback;
    }

    // #rgb / #rrggbb
    let r = 0, g = 0, b = 0;
    if (/^#[0-9a-f]{3}$/i.test(c)) {
        r = parseInt(c[1] + c[1], 16);
        g = parseInt(c[2] + c[2], 16);
        b = parseInt(c[3] + c[3], 16);
    } else if (/^#[0-9a-f]{6}$/i.test(c)) {
        r = parseInt(c.slice(1, 3), 16);
        g = parseInt(c.slice(3, 5), 16);
        b = parseInt(c.slice(5, 7), 16);
    } else {
        return fallback;
    }

    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    if (d === 0) return fallback;

    let h: number;
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;

    h = h * 60;
    if (h < 0) h += 360;
    return h;
}
