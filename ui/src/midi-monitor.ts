/**
 * Live MIDI monitor — plays the keyboard as it's played so you can hear what
 * you're doing.
 *
 * This is deliberately a SEPARATE Web Audio graph on the main thread, exactly
 * like `metronome.ts`. The strudel-rs WASM engine has no one-shot note API —
 * the running pattern is the only thing that feeds the worklet — so the
 * monitor never touches the scheduler and the playing pattern is unaffected.
 *
 * Two voice families:
 *   - **Synths** (`sine`, `sawtooth`, `square`, `triangle`, `supersaw`,
 *     `supersquare`): synthesized live with `OscillatorNode`s. No loading.
 *   - **GM soundfonts** (`gm_*`): key-zoned `AudioBuffer`s decoded via
 *     `SampleLoader.loadMonitorInstrument` (same path as `s("gm_*")`), retained
 *     here and played with `AudioBufferSourceNode`s.
 *
 * Both names match strudel's `s("…")` so the capture/commit output plays the
 * same instrument the monitor used.
 */

import type {MonitorZone} from '../sample-loader.js';

interface ActiveVoice {
    sources: AudioScheduledSourceNode[];
    gain: GainNode;
}

/** Built-in oscillator voices. `[oscType, detune-cents per stacked voice]`. */
const SYNTH_VOICES: Record<string, {type: OscillatorType; detune: number[]}> = {
    sine: {type: 'sine', detune: [0]},
    triangle: {type: 'triangle', detune: [0]},
    sawtooth: {type: 'sawtooth', detune: [0]},
    square: {type: 'square', detune: [0]},
    supersaw: {type: 'sawtooth', detune: [-19, -13, -7, 0, 7, 13, 19]},
    supersquare: {type: 'square', detune: [-12, -5, 0, 5, 12]},
};

/** Ordered list for the Preferences dropdown. */
export const SYNTH_VOICE_NAMES = Object.keys(SYNTH_VOICES);

const ATTACK = 0.006; // s — short ramp-in to avoid clicks

class MidiMonitor {
    private enabled = false;
    private gain = 0.8;
    private instrument = 'sawtooth';
    private zones: MonitorZone[] = [];
    /** Monotonic token so a slow load for a previous instrument can't clobber a newer one. */
    private loadToken = 0;
    private loading = false;
    private active = new Map<number, ActiveVoice>();

    isEnabled(): boolean {
        return this.enabled;
    }

    setGain(g: number): void {
        this.gain = Math.max(0, Math.min(1, g));
    }

    private isSynth(name: string): boolean {
        return name in SYNTH_VOICES;
    }

    /**
     * Whether the monitor can actually preview this instrument: the built-in
     * oscillator synths and GM soundfonts. Engine-only voices (fm, wavetables,
     * noise, user sample banks, …) return false — they're pattern-only.
     */
    canPlay(name: string): boolean {
        return this.isSynth(name) || name.startsWith('gm_');
    }

    /** Apply persisted monitor settings; loads the instrument if it's a soundfont. */
    applyFromSettings(opts: {enabled: boolean; instrument: string; gain: number}): void {
        this.gain = Math.max(0, Math.min(1, opts.gain));
        this.enabled = opts.enabled;
        const changed = opts.instrument !== this.instrument;
        this.instrument = opts.instrument;
        if (changed) this.zones = [];
        if (this.enabled && !this.isSynth(this.instrument) && this.zones.length === 0) {
            void this.loadInstrument(this.instrument);
        }
        if (!this.enabled) this.allNotesOff();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        if (enabled && !this.isSynth(this.instrument)) void this.loadInstrument(this.instrument);
        if (!enabled) this.allNotesOff();
    }

    setInstrument(bankName: string): void {
        if (bankName === this.instrument) return;
        this.instrument = bankName;
        this.zones = [];
        this.allNotesOff();
        if (this.enabled && !this.isSynth(bankName)) void this.loadInstrument(bankName);
    }

    private async loadInstrument(bankName: string): Promise<void> {
        const token = ++this.loadToken;
        const loader = window.strudelApp?.sampleLoader;
        // Audio not initialised yet (no Play yet) — `noteOn` retries lazily.
        if (!loader) return;
        this.loading = true;
        try {
            const zones = await loader.loadMonitorInstrument(bankName);
            if (token !== this.loadToken) return; // superseded
            this.zones = zones;
        } catch (e) {
            console.warn('[midi-monitor] instrument load failed:', e);
        } finally {
            if (token === this.loadToken) this.loading = false;
        }
    }

    noteOn(note: number, velocity: number): void {
        if (!this.enabled) return;
        const ctx = window.strudelApp?.audioManager?.getAudioContext?.();
        if (!ctx) return;

        // Retrigger: cut any voice already sounding for this note.
        this.stopVoice(note, true);
        const peak = (velocity / 127) * this.gain;

        if (this.isSynth(this.instrument)) {
            this.playSynth(ctx, note, peak);
            return;
        }

        // Soundfont path. Self-heal: load lazily once audio is finally up.
        if (this.zones.length === 0) {
            if (!this.loading) void this.loadInstrument(this.instrument);
            return;
        }
        this.playSoundfont(ctx, note, peak);
    }

    private playSynth(ctx: AudioContext, note: number, peak: number): void {
        const voice = SYNTH_VOICES[this.instrument];
        const freq = 440 * Math.pow(2, (note - 69) / 12);
        const now = ctx.currentTime;

        const gain = ctx.createGain();
        // Stacked oscillators sum, so scale down to stay clear of clipping.
        const headroom = voice.detune.length > 1 ? 0.7 / Math.sqrt(voice.detune.length) : 1;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(peak * headroom, now + ATTACK);
        gain.connect(ctx.destination);

        const sources: AudioScheduledSourceNode[] = [];
        for (const cents of voice.detune) {
            const osc = ctx.createOscillator();
            osc.type = voice.type;
            osc.frequency.value = freq;
            osc.detune.value = cents;
            osc.connect(gain);
            osc.start(now);
            sources.push(osc);
        }
        this.active.set(note, {sources, gain});
    }

    private playSoundfont(ctx: AudioContext, note: number, peak: number): void {
        const zone = this.pickZone(note);
        if (!zone) return;
        const now = ctx.currentTime;

        const src = ctx.createBufferSource();
        src.buffer = zone.audioBuffer;
        src.playbackRate.value = Math.pow(2, (note * 100 - zone.baseDetuneCents) / 1200);
        if (zone.loopStart !== 0xFFFF_FFFF && zone.loopEnd > zone.loopStart) {
            src.loop = true;
            src.loopStart = zone.loopStart / zone.audioBuffer.sampleRate;
            src.loopEnd = zone.loopEnd / zone.audioBuffer.sampleRate;
        }

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(peak, now + ATTACK);
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(now);
        src.onended = () => {
            try { gain.disconnect(); } catch { /* already gone */ }
        };
        this.active.set(note, {sources: [src], gain});
    }

    noteOff(note: number): void {
        this.stopVoice(note, false);
    }

    allNotesOff(): void {
        for (const note of [...this.active.keys()]) this.stopVoice(note, true);
    }

    /** Release a voice with a short fade (or near-instant cut on retrigger). */
    private stopVoice(note: number, immediate: boolean): void {
        const voice = this.active.get(note);
        if (!voice) return;
        this.active.delete(note);
        const ctx = window.strudelApp?.audioManager?.getAudioContext?.();
        const now = ctx?.currentTime ?? 0;
        const release = immediate ? 0.005 : 0.12;
        try {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
            voice.gain.gain.linearRampToValueAtTime(0.0001, now + release);
            for (const s of voice.sources) {
                try { s.stop(now + release + 0.02); } catch { /* already stopped */ }
            }
        } catch {
            for (const s of voice.sources) {
                try { s.stop(); } catch { /* already stopped */ }
            }
        }
    }

    /** Choose the zone whose key range contains `note`, else the nearest by recorded pitch. */
    private pickZone(note: number): MonitorZone | null {
        let best: MonitorZone | null = null;
        let bestDist = Infinity;
        for (const z of this.zones) {
            if (z.keyRangeLow <= z.keyRangeHigh && note >= z.keyRangeLow && note <= z.keyRangeHigh) {
                return z;
            }
            const d = Math.abs(z.midiNote - note);
            if (d < bestDist) {
                bestDist = d;
                best = z;
            }
        }
        return best;
    }
}

export const midiMonitor = new MidiMonitor();
(window as any).midiMonitor = midiMonitor;
