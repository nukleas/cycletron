/**
 * LISSAJOUS SCOPE — the waveform plotted against a delayed copy of itself
 * (x[i], x[i + delay]), phosphor-trailed by the host's fading background.
 *
 *   signal        → ScopeSignal: the analyser's waveform while it moves; when
 *                   it stalls but a pattern plays, a waveform rebuilt from
 *                   the scheduled pitches and onset envelopes.
 *   delay         → a quarter period of the lowest sounding scheduled note,
 *                   so the bass draws a circle and the harmony above it
 *                   braids around that; with nothing pitched, a fixed table
 *                   stepped on each beat, aligned to the bar.
 *   ghost trace   → on every delay change the previous figure lingers in the
 *                   secondary colour and fades.
 *   brightness    → scheduled onsets (FFT transients with no pattern).
 *   scale         → auto-gain follower, fast attack / slow release.
 *   idle          → a slowly precessing 3:2 reference figure at low alpha, so
 *                   silence is never a centre dot.
 */

import type {VizMode, VizModeDef, VizServices} from '../types.js';
import {TrackModel} from '../tracks.js';
import {TAU, TransientDetector, alphaRamp, drawLabel, follow, rampAt, rgbOf} from '../util.js';
import {ScopeSignal} from './scope/signal.js';

/** Delays (samples) per beat when nothing pitched plays; odd bars use row 2. */
const DELAYS = [24, 64, 128, 48, 32, 96, 160, 56] as const;
/** Note-locked delays fold up an octave until they fit this many samples. */
const MAX_LOCK_DELAY = 128;
const MIN_DELAY = 4;
/** Figure radius as a fraction of min(w, h). */
const RADIUS = 0.42;
/** Point budget per trace, independent of analyser size. */
const MAX_POINTS = 600;
const IDLE_POINTS = 180;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

class LissajousMode implements VizMode {
    private readonly tracks = new TrackModel();
    private readonly signal = new ScopeSignal();
    private readonly transients = new TransientDetector(0.12, 0.1, 0.08);

    private radius = 0;
    private lineWidth = 1.25;
    private ghostWidth = 1;
    private labelSize = 10;
    private neonRamp: string[] = [];
    private secondaryRamp: string[] = [];
    private labelColor = '';

    private offset: number = DELAYS[0];
    private prevOffset: number = DELAYS[0];
    /** 1 on a delay change, decays — the previous figure's ghost. */
    private ghost = 0;
    private gain = 0.3;
    private flash = 0;
    private beamOn = false;
    /** 0 = the signal figure, 1 = the idle reference figure. */
    private idleMix = 1;
    private idleT = 0;
    private lockNote = NaN;
    private lockLabel = '';

    private readonly onOnset = (): void => {
        this.flash = 1;
    };

    layout(s: VizServices): void {
        if (!(s.width > 0 && s.height > 0)) return;
        const m = Math.min(s.width, s.height);
        const u = m / 720;
        this.radius = m * RADIUS;
        this.lineWidth = Math.min(2.5, Math.max(1, 1.25 * u));
        this.ghostWidth = Math.max(0.75, this.lineWidth * 0.6);
        this.labelSize = Math.max(9, Math.min(11, 10 * u));
        const t = s.theme;
        this.neonRamp = alphaRamp(rgbOf(t.neon, [71, 246, 255]), 32);
        this.secondaryRamp = alphaRamp(rgbOf(t.neonSecondary, [255, 43, 214]), 32);
        this.labelColor = rampAt(alphaRamp(t.textRgb, 16), 0.45);
    }

    update(dt: number, s: VizServices): void {
        const sync = this.tracks.sync(s.patternSource, s.cycle, s.theme);
        this.tracks.forEachOnset(sync, this.onOnset);
        this.tracks.decay(dt);
        const scheduled = sync.pattern !== null;
        if (!scheduled) {
            const hits = this.transients.update(dt, s.low, s.mid, s.high);
            if (hits.kick || hits.snare) this.flash = 1;
            else if (hits.hat) this.flash = Math.max(this.flash, 0.5);
        }
        this.flash *= Math.exp(-dt * 6);

        const sig = this.signal;
        sig.update(dt, s, this.tracks.tracks, sync.phase, scheduled);
        const gate = 0.02 / Math.max(0.3, s.sensitivity);
        this.beamOn = sig.source !== 'idle' && sig.rms >= gate;
        if (this.beamOn) this.gain = follow(this.gain, Math.max(0.05, sig.peak), dt, 30, 0.8);
        this.idleMix = follow(this.idleMix, this.beamOn ? 0 : 1, dt, 3, 5);
        this.idleT = (this.idleT + dt * 0.35) % (TAU * 64);

        let next: number;
        const bass = sig.bassNote;
        if (Number.isFinite(bass)) {
            let q = s.sampleRate / (440 * Math.pow(2, (bass - 69) / 12)) / 4;
            while (q > MAX_LOCK_DELAY) q /= 2;
            next = Math.max(MIN_DELAY, Math.round(q));
            if (bass !== this.lockNote) {
                this.lockNote = bass;
                const n = Math.round(bass);
                this.lockLabel = `LOCK ${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
            }
        } else {
            const beat = Math.floor(s.cycle * 4);
            const beatInBar = ((beat % 4) + 4) % 4;
            next = DELAYS[(Math.floor(s.cycle) & 1) * 4 + beatInBar];
            this.lockNote = NaN;
        }
        if (next !== this.offset) {
            this.prevOffset = this.offset;
            this.offset = next;
            this.ghost = 1;
        }
        this.ghost *= Math.exp(-dt * 5);
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const r = this.radius;
        if (!(r > 0)) return;
        const cx = s.width / 2;
        const cy = s.height / 2;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const idle = this.idleMix;
        if (idle > 0.01) {
            // Reference 3:2 figure, slowly precessing.
            const ri = r * 0.7;
            ctx.strokeStyle = rampAt(this.neonRamp, 0.22 * idle);
            ctx.lineWidth = this.ghostWidth;
            ctx.beginPath();
            for (let k = 0; k <= IDLE_POINTS; k++) {
                const t = (k / IDLE_POINTS) * TAU;
                const x = cx + Math.sin(3 * t + this.idleT) * ri;
                const y = cy + Math.sin(2 * t) * ri;
                if (k === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        const live = 1 - idle;
        if (live > 0.01) {
            const norm = r / this.gain;
            if (this.ghost > 0.02) {
                ctx.strokeStyle = rampAt(this.secondaryRamp, 0.4 * this.ghost * live);
                ctx.lineWidth = this.ghostWidth;
                this.trace(ctx, cx, cy, norm, r, this.prevOffset);
            }
            ctx.strokeStyle = rampAt(this.neonRamp, (0.55 + this.flash * 0.35) * live);
            ctx.lineWidth = this.lineWidth;
            this.trace(ctx, cx, cy, norm, r, this.offset);
        }

        const synthetic = this.signal.source === 'synthetic';
        if (s.width >= 240 && (synthetic || Number.isFinite(this.lockNote))) {
            const pad = Math.max(10, Math.min(s.width, s.height) * 0.025);
            let y = s.height - pad;
            if (synthetic) {
                drawLabel(ctx, 'FROM SCHEDULE', pad, y, this.labelColor, this.labelSize);
                y -= this.labelSize * 1.6;
            }
            if (Number.isFinite(this.lockNote)) {
                drawLabel(ctx, this.lockLabel, pad, y, this.labelColor, this.labelSize);
            }
        }
        ctx.restore();
    }

    /** Stroke one (x[i], x[i + off]) figure; values clamp just past the rim. */
    private trace(ctx: CanvasRenderingContext2D, cx: number, cy: number, norm: number, r: number, off: number): void {
        const sig = this.signal;
        const data = sig.data;
        const usable = sig.length - off;
        if (usable < 8) return;
        const lim = r * 1.1;
        const step = Math.max(1, Math.ceil(usable / MAX_POINTS));
        ctx.beginPath();
        for (let i = 0; i < usable; i += step) {
            const x = cx + Math.max(-lim, Math.min(lim, data[i] * norm));
            const y = cy + Math.max(-lim, Math.min(lim, data[i + off] * norm));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
}

export const lissajousDef: VizModeDef = {
    id: 'lissajous',
    name: 'LISSAJOUS SCOPE',
    trailFade: 0.16,
    create: () => new LissajousMode(),
};
