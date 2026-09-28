/**
 * Scope signal for the phase-plot modes (ASCII SCOPE, LISSAJOUS SCOPE).
 *
 * Both modes plot a waveform against a delayed copy of itself, so both die
 * the same way when the AnalyserNode stops being pulled (GitHub #80, macOS
 * WebKit): the time-domain buffer freezes — at silence (all zeros) or
 * mid-waveform — and a naive scope goes blank or restamps one
 * figure forever. This helper hands the modes one float signal (-1..1) and
 * says where it came from:
 *
 *   live      — the analyser's time-domain data is moving.
 *   synthetic — the analyser is dead (frozen or flat) while something should
 *               be sounding (a pattern is scheduled, or the FFT bands show
 *               energy). The signal is rebuilt from the schedule instead: one
 *               oscillator per track at its sounding pitch (instrument-family
 *               stand-ins for drums), amplitude from the track's onset
 *               envelope — so the figure still moves exactly on the notes.
 *   idle      — nothing to draw; the modes show their calm idle state.
 *
 * Frozen and flat are both judged over a short hold so a single duplicate
 * read or a rest between notes doesn't flip the source; going back to live
 * needs a short run of moving data too. Synthesis runs at the analyser's own
 * sample rate, so delay-in-samples geometry matches the live signal.
 */

import type {VizServices} from '../../types.js';
import {instrumentFamily, type InstrumentFamily, type VizTrack} from '../../tracks.js';
import {TAU, hash32, rand01} from '../../util.js';

/** Samples in the synthetic signal; live data is truncated to this. */
export const SIGNAL_CAPACITY = 1024;

export type ScopeSource = 'live' | 'synthetic' | 'idle';

/** Oscillators the synthetic signal sums — the first N tracks. */
const MAX_VOICES = 8;
/** Seconds the analyser must be frozen/flat before it counts as dead. */
const FROZEN_HOLD = 0.25;
const FLAT_HOLD = 0.3;
/** Seconds of moving data before a stalled scope trusts the analyser again. */
const RECOVER_HOLD = 0.1;
/** Sample range (max - min) at or below which a frame is "flat" (~2 LSB of 8-bit). */
const FLAT_RANGE = 0.016;

/** Stand-in pitch (Hz) and noise share for unpitched instrument families. */
const FAMILY_HZ: Record<InstrumentFamily, number> = {kick: 55, snare: 190, hat: 2400, perc: 330};
const FAMILY_NOISE: Record<InstrumentFamily, number> = {kick: 0, snare: 0.5, hat: 0.85, perc: 0.2};

function midiHz(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
}

/**
 * The note a track is sounding at bar `phase`: the hap covering it, else the
 * most recent one. NaN when unpitched or nothing has started yet.
 */
function soundingNote(track: VizTrack, phase: number): number {
    let latest = NaN;
    let latestBegin = -1;
    for (let e = 0; e < track.count; e++) {
        const begin = track.begins[e];
        if (begin > phase) continue;
        if (phase < track.ends[e]) return track.notes[e];
        if (begin > latestBegin) {
            latestBegin = begin;
            latest = track.notes[e];
        }
    }
    return latest;
}

export class ScopeSignal {
    /** The signal, -1..1; valid for `length` samples. */
    readonly data = new Float32Array(SIGNAL_CAPACITY);
    length = 0;
    source: ScopeSource = 'idle';
    /** Peak |sample| and RMS of this frame's signal. */
    peak = 0;
    rms = 0;
    /** Lowest pitched note sounding right now (MIDI), NaN if none. */
    bassNote = NaN;

    private checksum = -1;
    private frozenFor = 0;
    private flatFor = 0;
    private movingFor = 0;
    private stalled = false;
    private frame = 0;
    /** Sample rate the synthetic signal is generated at — the analyser's own. */
    private rate = 48000;
    private readonly phases = new Float64Array(MAX_VOICES);
    private readonly families = new WeakMap<VizTrack, InstrumentFamily>();

    /**
     * Call once per frame, after the mode's `TrackModel.sync`/`forEachOnset`
     * (so activity envelopes include this frame's onsets). `scheduled` is
     * whether a pattern is playing; `phase` is the synced bar phase.
     */
    update(dt: number, s: VizServices, tracks: readonly VizTrack[], phase: number, scheduled: boolean): void {
        if (s.sampleRate > 0) this.rate = s.sampleRate;
        this.frame++;
        this.bassNote = NaN;
        if (scheduled) {
            for (const track of tracks) {
                const note = soundingNote(track, phase);
                if (Number.isFinite(note) && !(note >= this.bassNote)) this.bassNote = note;
            }
        }

        const td = s.timeData;
        let dead = true;
        let flat = true;
        if (td && td.length > 0) {
            let sum = 0;
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = 0; i < td.length; i++) {
                const v = td[i];
                sum = (Math.imul(sum, 31) + Math.round(v * 32768)) | 0;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            const frozen = sum === this.checksum;
            this.checksum = sum;
            flat = hi - lo <= FLAT_RANGE;
            this.frozenFor = frozen ? this.frozenFor + dt : 0;
            this.flatFor = flat ? this.flatFor + dt : 0;
            dead = this.frozenFor > FROZEN_HOLD || this.flatFor > FLAT_HOLD;
        }

        if (!dead) {
            this.movingFor += dt;
            if (this.movingFor >= RECOVER_HOLD) this.stalled = false;
        } else {
            this.movingFor = 0;
            // A dead analyser only needs replacing when something should be
            // sounding; otherwise it's just silence.
            const bands = s.low + s.mid + s.high;
            this.stalled = scheduled || (Number.isFinite(bands) && bands > 0.15);
        }

        if (!dead && !this.stalled && td) {
            this.source = 'live';
            // A flat frame carries no waveform — at literal zeros it would
            // otherwise plot as a pinned corner dot until the hold trips.
            const n = flat ? 0 : Math.min(td.length, SIGNAL_CAPACITY);
            for (let i = 0; i < n; i++) this.data[i] = td[i];
            this.length = n;
        } else if (this.stalled) {
            this.source = 'synthetic';
            this.synthesize(dt, s, tracks, phase, scheduled);
        } else {
            this.source = 'idle';
            this.length = 0;
        }
        this.measure();
    }

    private synthesize(dt: number, s: VizServices, tracks: readonly VizTrack[], phase: number, scheduled: boolean): void {
        const data = this.data;
        data.fill(0);
        this.length = SIGNAL_CAPACITY;
        if (scheduled) {
            let v = 0;
            for (const track of tracks) {
                if (v >= MAX_VOICES) break;
                const amp = track.activity;
                const note = soundingNote(track, phase);
                let family = this.families.get(track);
                if (family === undefined) {
                    family = instrumentFamily(track.name);
                    this.families.set(track, family);
                }
                const pitched = Number.isFinite(note);
                const hz = pitched ? midiHz(note) : FAMILY_HZ[family];
                this.voice(v, hz, amp, pitched ? 0 : FAMILY_NOISE[family], dt, track.slot);
                v++;
            }
        } else {
            // No schedule, but the FFT says it's loud: one stand-in per band.
            this.voice(0, 55, Math.max(0, s.low), 0, dt, 0);
            this.voice(1, 440, Math.max(0, s.mid) * 0.7, 0.2, dt, 1);
            this.voice(2, 2400, Math.max(0, s.high) * 0.5, 0.85, dt, 2);
        }
    }

    /** Add one oscillator (plus deterministic noise) into the signal. */
    private voice(v: number, hz: number, amp: number, noise: number, dt: number, seed: number): void {
        const w = (TAU * hz) / this.rate;
        const ph = this.phases[v];
        // Phase keeps running in real time so the figure turns continuously
        // across frames instead of restarting at the same angle.
        this.phases[v] = (ph + TAU * hz * dt) % TAU;
        if (!(amp > 0.004)) return;
        const data = this.data;
        const tone = amp * (1 - noise);
        const hiss = amp * noise;
        const n = this.length;
        if (hiss > 0) {
            const key = hash32(seed, this.frame);
            for (let i = 0; i < n; i++) {
                data[i] += tone * Math.cos(ph + w * i) + hiss * (rand01(hash32(key, i)) * 2 - 1);
            }
        } else {
            for (let i = 0; i < n; i++) data[i] += tone * Math.cos(ph + w * i);
        }
    }

    private measure(): void {
        let peak = 0;
        let sumSq = 0;
        const n = this.length;
        for (let i = 0; i < n; i++) {
            const d = this.data[i];
            const a = d < 0 ? -d : d;
            if (a > peak) peak = a;
            sumSq += d * d;
        }
        this.peak = Number.isFinite(peak) ? peak : 0;
        const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
        this.rms = Number.isFinite(rms) ? rms : 0;
    }
}
