/**
 * Live MIDI input hub.
 *
 * MIDI now arrives from the native `midir` backend (see
 * `src-tauri/src/midi_input.rs`) as `midi-input` Tauri events — the Web MIDI
 * API is no longer used. This module:
 *
 *   - starts/stops listening and lists devices via the Tauri commands,
 *   - keeps the two configurable CC → master-gain / BPM mappings,
 *   - flashes the `#midiInStatus` indicator on any message, and
 *   - fans every note/CC out to the pad matcher, the live monitor, and the
 *     capture buffer (pads consume their trigger so it isn't also monitored).
 */

import type {MidiInputSettings, MidiDeviceInfo} from './types/tauri-commands.js';
import {midiMonitor} from './midi-monitor.js';
import {midiCapture} from './midi-capture.js';
import {midiPads} from './midi-pads.js';

/** Mirror of the Rust `MidiInputEvent` payload. */
export interface NativeMidiEvent {
    event_type: 'note_on' | 'note_off' | 'cc';
    note: number;
    velocity: number;
    channel: number;
    device_name: string;
    timestamp: number;
}

type TauriCore = {invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>};
type TauriEvent = {listen: (event: string, cb: (e: {payload: unknown}) => void) => Promise<() => void>};

class MidiInput {
    private deviceId: string | null = null;
    private ccGain = 7;
    private ccBpm = 74;
    private listening = false;
    private subscribed = false;
    private flashTimer: number | null = null;
    /** Signature of the device set we last connected to, for hot-plug detection. */
    private lastDeviceSig = '';

    private get core(): TauriCore | null {
        return (window as any).__TAURI__?.core ?? null;
    }
    private get events(): TauriEvent | null {
        return (window as any).__TAURI__?.event ?? null;
    }

    /** Subscribe to the backend event stream (once). */
    async init(): Promise<void> {
        if (this.subscribed) return;
        const events = this.events;
        if (!events) return; // not running under Tauri
        this.subscribed = true;
        await events.listen('midi-input', (e) => this.handleEvent(e.payload as NativeMidiEvent));
        // Hot-plug: midir has no device-change callback, so re-scan whenever the
        // window regains focus. If the device set changed (e.g. a keyboard was
        // just plugged in), reconnect so it starts flowing without a restart.
        window.addEventListener('focus', () => void this.rescanIfChanged());
    }

    /** Re-list devices and restart listening only if the device set changed. */
    private async rescanIfChanged(): Promise<void> {
        if (!this.core) return;
        const devices = await this.listDevices();
        const sig = devices.map((d) => d.id).sort().join('|');
        if (sig !== this.lastDeviceSig) {
            console.info('[midi-input] device set changed → reconnecting');
            await this.startListening();
        }
    }

    isListening(): boolean {
        return this.listening;
    }

    /** List available input devices (for the Preferences picker). */
    async listDevices(): Promise<MidiDeviceInfo[]> {
        try {
            return (await this.core?.invoke<MidiDeviceInfo[]>('list_midi_input_devices')) ?? [];
        } catch (e) {
            console.info('[midi-input] list devices failed:', e);
            return [];
        }
    }

    applyFromSettings(settings: MidiInputSettings): void {
        this.deviceId = settings.device_id ?? null;
        this.ccGain = settings.cc_gain ?? 7;
        this.ccBpm = settings.cc_bpm ?? 74;
        midiMonitor.applyFromSettings({
            enabled: settings.monitor_enabled ?? false,
            instrument: settings.monitor_instrument ?? 'gm_piano',
            gain: settings.monitor_gain ?? 0.8,
        });
        midiPads.applyFromSettings({
            pad_assignments: settings.pad_assignments ?? [],
            monitor_instrument: settings.monitor_instrument ?? 'gm_piano',
        });
        // (Re)start listening on the selected device.
        void this.startListening();
    }

    async startListening(): Promise<void> {
        if (!this.core) return;
        try {
            await this.core.invoke('start_midi_input_listening', {deviceId: this.deviceId});
            this.listening = true;
        } catch (e) {
            // Common, benign case: no MIDI devices plugged in.
            this.listening = false;
            console.info('[midi-input] start listening:', e);
        }
        // Snapshot the current device set so focus-rescan can detect changes.
        try {
            const devices = await this.listDevices();
            this.lastDeviceSig = devices.map((d) => d.id).sort().join('|');
        } catch { /* ignore */ }
    }

    async stopListening(): Promise<void> {
        if (!this.core) return;
        try {
            await this.core.invoke('stop_midi_input_listening');
        } catch { /* ignore */ }
        this.listening = false;
    }

    private handleEvent(evt: NativeMidiEvent): void {
        if (!evt || typeof evt.event_type !== 'string') return;
        this.flash();

        // Pads first: a learned/bound trigger is consumed and not monitored.
        if (midiPads.handle(evt)) return;

        // CC → gain / BPM (only for CCs not bound to a pad).
        if (evt.event_type === 'cc') {
            if (evt.note === this.ccGain) this.applyGain(evt.velocity);
            else if (evt.note === this.ccBpm) this.applyBpm(evt.velocity);
            return;
        }

        // Live monitor + capture.
        if (evt.event_type === 'note_on') {
            midiMonitor.noteOn(evt.note, evt.velocity);
            midiCapture.noteOn(evt.note, evt.velocity, evt.timestamp);
        } else if (evt.event_type === 'note_off') {
            midiMonitor.noteOff(evt.note);
            midiCapture.noteOff(evt.note, evt.timestamp);
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
