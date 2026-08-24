/**
 * Simple metronome — scheduled via Web Audio, independent of the Strudel
 * cycle scheduler so it keeps perfect time even if the pattern stutters.
 *
 * Reads the BPM live from the slider every loop, so changing tempo is
 * reflected on the next click.
 */

import {currentBpm} from './bpm.js';

const LOOK_AHEAD_MS = 25;       // scheduler tick rate
const SCHEDULE_AHEAD = 0.1;     // seconds of look-ahead

/**
 * The click is a personal cue, not part of the performance, so it joins the
 * master bus *after* the capture tap — audible, and never in a recording.
 * Falls back to the destination if the bus isn't up yet.
 */
function cueOutput(ctx: AudioContext): AudioNode {
    return window.strudelApp?.audioManager?.getCueBus?.() ?? ctx.destination;
}

class Metronome {
    private enabled = false;
    private volume = 0.4;
    private timerId: number | null = null;
    private nextBeatTime = 0;
    private beatNumber = 0;
    private btn: HTMLButtonElement | null = null;

    init(): void {
        this.btn = document.getElementById('metronomeBtn') as HTMLButtonElement | null;
        this.btn?.addEventListener('click', () => this.toggle());
        this.updateUi();
    }

    setVolume(v: number): void {
        this.volume = Math.max(0, Math.min(1, v));
    }

    /** Restore persisted state. Called by boot once user settings load. */
    applyFromSettings(opts: {enabled: boolean; volume: number}): void {
        this.volume = opts.volume;
        if (opts.enabled !== this.enabled) {
            this.toggle();
        } else {
            this.updateUi();
        }
    }

    toggle(): void {
        this.enabled = !this.enabled;
        if (this.enabled) this.start();
        else this.stop();
        this.updateUi();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    private start(): void {
        const ctx = window.strudelApp?.audioManager?.getAudioContext?.();
        if (!ctx) {
            // Audio isn't initialised yet — try again on next interaction. We
            // mark enabled so the next play action will fire the metronome.
            return;
        }
        this.beatNumber = 0;
        this.nextBeatTime = ctx.currentTime + 0.05;
        this.scheduleLoop();
    }

    private stop(): void {
        if (this.timerId != null) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    private scheduleLoop = (): void => {
        const ctx = window.strudelApp?.audioManager?.getAudioContext?.();
        if (!ctx || !this.enabled) {
            this.stop();
            return;
        }
        const beatDuration = 60 / currentBpm();
        while (this.nextBeatTime < ctx.currentTime + SCHEDULE_AHEAD) {
            this.scheduleClick(ctx, this.nextBeatTime, this.beatNumber);
            this.nextBeatTime += beatDuration;
            this.beatNumber = (this.beatNumber + 1) % 4;
        }
        this.timerId = window.setTimeout(this.scheduleLoop, LOOK_AHEAD_MS);
    };

    private scheduleClick(ctx: AudioContext, when: number, beat: number): void {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        // Beat-one downbeat gets a higher pitch so the pulse is audible.
        osc.frequency.value = beat === 0 ? 1500 : 1000;
        osc.type = 'square';
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(this.volume, when + 0.001);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
        osc.connect(gain);
        gain.connect(cueOutput(ctx));
        osc.start(when);
        osc.stop(when + 0.06);
    }

    private updateUi(): void {
        if (!this.btn) return;
        this.btn.classList.toggle('is-on', this.enabled);
        this.btn.setAttribute('data-tooltip', this.enabled ? 'Metronome on' : 'Metronome off');
    }
}

export const metronome = new Metronome();
window.metronome = metronome;
