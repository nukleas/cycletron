/**
 * Log-frequency spectrum axis shared by FLAME GRAPH and WAVE TERRAIN. One
 * axis position (0..1) means the same frequency in both the FFT sampling and
 * the track markers, so a bass note's marker sits on the bass's hump.
 */

import type {VizTrack} from '../../tracks.js';
import {instrumentFamily} from '../../tracks.js';
import {clamp01} from '../../util.js';

const F_LO = 40;
const F_HI = 12000;
const LOG_SPAN = Math.log(F_HI / F_LO);

/** Axis position (0..1) of a frequency in Hz. */
export function freqAxis(hz: number): number {
    return clamp01(Math.log(hz / F_LO) / LOG_SPAN);
}

/**
 * Where a hap sounds on the axis: pitched haps at their note's fundamental,
 * drums at their family's characteristic band (kick thump, snare body/crack,
 * hat sizzle); unpitched non-drums in the upper mids.
 */
export function onsetAxis(track: VizTrack, e: number): number {
    const note = track.notes[e];
    if (Number.isFinite(note)) return freqAxis(440 * Math.pow(2, (note - 69) / 12));
    switch (instrumentFamily(track.name)) {
        case 'kick': return freqAxis(60);
        case 'snare': return freqAxis(1200);
        case 'hat': return freqAxis(8000);
        default: return freqAxis(2800);
    }
}

/**
 * Samples analyser bins onto `bands` log-spaced bands. The bin lookup is
 * precomputed per bin count: bands narrower than a bin interpolate between
 * neighbours (the bass is only a few bins wide at fftSize 1024), wider bands
 * take their loudest bin. The lookup is rebuilt whenever the bin count or the
 * analyser's sample rate changes.
 */
export class SpectrumSampler {
    private readonly lo: Int32Array;
    private readonly hi: Int32Array;
    private readonly frac: Float32Array;
    private binCount = 0;
    private sampleRate = 0;

    constructor(private readonly bands: number) {
        this.lo = new Int32Array(bands);
        this.hi = new Int32Array(bands);
        this.frac = new Float32Array(bands);
    }

    private prepare(binCount: number, sampleRate: number): void {
        this.binCount = binCount;
        this.sampleRate = sampleRate;
        const binHz = sampleRate / 2 / binCount;
        for (let i = 0; i < this.bands; i++) {
            const b0 = F_LO * Math.exp(LOG_SPAN * i / this.bands) / binHz;
            const b1 = F_LO * Math.exp(LOG_SPAN * (i + 1) / this.bands) / binHz;
            if (b1 - b0 < 1) {
                const c = Math.min(binCount - 1.001, (b0 + b1) * 0.5);
                this.lo[i] = Math.floor(c);
                this.hi[i] = -1;
                this.frac[i] = c - Math.floor(c);
            } else {
                this.lo[i] = Math.min(binCount - 1, Math.floor(b0));
                this.hi[i] = Math.min(binCount, Math.max(this.lo[i] + 1, Math.ceil(b1)));
            }
        }
    }

    /** Fill `out` (length `bands`) with 0..~1 levels, sensitivity applied. */
    sample(data: Uint8Array, sampleRate: number, sensitivity: number, out: Float32Array): void {
        if (data.length !== this.binCount || sampleRate !== this.sampleRate) this.prepare(data.length, sampleRate);
        const k = sensitivity / 255;
        for (let i = 0; i < this.bands; i++) {
            const lo = this.lo[i];
            const hi = this.hi[i];
            let v: number;
            if (hi < 0) {
                v = data[lo] + (data[lo + 1] - data[lo]) * this.frac[i];
            } else {
                v = 0;
                for (let b = lo; b < hi; b++) if (data[b] > v) v = data[b];
            }
            out[i] = v * k;
        }
    }
}
