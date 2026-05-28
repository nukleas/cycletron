/**
 * Live MIDI input via the Web MIDI API.
 *
 * - Subscribes to either a specific input port id (from UserSettings) or
 *   every input if none is configured.
 * - Maps two configurable Control Change numbers:
 *     * `cc_gain` → master volume slider
 *     * `cc_bpm`  → BPM slider
 * - Flashes the `#midiInStatus` indicator on any incoming message.
 *
 * Note: the strudel engine itself doesn't ingest MIDI; this layer just
 * drives the running app's controls. Triggering patterns from MIDI is a
 * future feature (requires an event-injection API in the engine).
 */

import type {MidiInputSettings} from './types/tauri-commands.js';

type AnyMidi = any;

class MidiInput {
    private access: AnyMidi | null = null;
    private deviceId: string | null = null;
    private ccGain = 7;
    private ccBpm = 74;
    private boundPorts: AnyMidi[] = [];
    private flashTimer: number | null = null;

    async init(): Promise<void> {
        if (!('requestMIDIAccess' in navigator)) return;
        try {
            this.access = await (navigator as any).requestMIDIAccess({sysex: false});
        } catch (e) {
            console.info('[midi-input] permission denied or unavailable:', e);
            return;
        }
        this.access.addEventListener?.('statechange', () => this.bindPorts());
        this.bindPorts();
    }

    applyFromSettings(settings: MidiInputSettings): void {
        this.deviceId = settings.device_id ?? null;
        this.ccGain = settings.cc_gain ?? 7;
        this.ccBpm  = settings.cc_bpm  ?? 74;
        this.bindPorts();
    }

    private bindPorts(): void {
        if (!this.access) return;
        // Detach previous listeners so we don't double-handle messages.
        for (const port of this.boundPorts) {
            try { port.onmidimessage = null; } catch { /* ignore */ }
        }
        this.boundPorts = [];
        const inputs: AnyMidi[] = [...this.access.inputs.values()];
        const targets = this.deviceId
            ? inputs.filter((p) => p.id === this.deviceId)
            : inputs;
        for (const port of targets) {
            port.onmidimessage = (e: AnyMidi) => this.onMessage(e);
            this.boundPorts.push(port);
        }
    }

    private onMessage(e: AnyMidi): void {
        this.flash();
        const data: Uint8Array | number[] = e.data;
        if (!data || data.length < 2) return;
        const status = data[0] & 0xf0;
        // 0xB0 = Control Change.
        if (status === 0xb0 && data.length >= 3) {
            const ccNum = data[1];
            const value = data[2];
            if (ccNum === this.ccGain) this.applyGain(value);
            else if (ccNum === this.ccBpm) this.applyBpm(value);
        }
    }

    private applyGain(midiValue: number): void {
        const pct = Math.round((midiValue / 127) * 200); // slider goes 0–200
        const slider = document.getElementById('gainSlider') as HTMLInputElement | null;
        if (slider) {
            slider.value = String(pct);
            slider.dispatchEvent(new Event('input', {bubbles: true}));
        }
    }

    private applyBpm(midiValue: number): void {
        // Map 0..127 → 60..200 BPM, a comfortable range for live tweaking.
        const bpm = 60 + Math.round((midiValue / 127) * 140);
        window.strudelApp?.applyBpm?.(bpm);
    }

    private flash(): void {
        const el = document.getElementById('midiInStatus');
        if (!el) return;
        el.hidden = false;
        el.classList.add('flash');
        if (this.flashTimer != null) clearTimeout(this.flashTimer);
        this.flashTimer = window.setTimeout(() => {
            el.classList.remove('flash');
        }, 90);
    }
}

export const midiInput = new MidiInput();
(window as any).midiInput = midiInput;
