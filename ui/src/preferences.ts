/**
 * Preferences modal — backed by the Rust `get_user_settings` /
 * `set_user_settings` commands. Persists to `{app_data_dir}/settings.json`.
 *
 * Triggered by:
 *   - "Robostrudel → Preferences…" menu (Cmd+,)
 *   - The "Change…" buttons from other modals (e.g. Library root in here)
 */

import type {UserSettings} from './types/tauri-commands.js';
import {dismissibleModal} from './modal-utils.js';
import {setNotificationsEnabled} from './notifications.js';
import {metronome} from './metronome.js';
import {midiInput} from './midi-input.js';

const isTauri = !!(window as any).__TAURI__;

export class PreferencesModal {
    private root: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    // Form refs
    private apiKey: HTMLInputElement | null = null;
    private model: HTMLInputElement | null = null;
    private maxTokens: HTMLInputElement | null = null;
    private defaultTempo: HTMLInputElement | null = null;
    private libraryRoot: HTMLElement | null = null;
    private autoCheck: HTMLInputElement | null = null;
    private notifications: HTMLInputElement | null = null;
    private metronomeVolume: HTMLInputElement | null = null;
    private audioOutput: HTMLSelectElement | null = null;
    private midiInputSelect: HTMLSelectElement | null = null;
    private midiCcGain: HTMLInputElement | null = null;
    private midiCcBpm: HTMLInputElement | null = null;
    /** The most recently loaded settings — used to preserve fields the
     *  modal doesn't explicitly edit. */
    private loaded: UserSettings | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('prefsModal');
        if (!this.root) return;

        this.apiKey = document.getElementById('prefsApiKey') as HTMLInputElement;
        this.model = document.getElementById('prefsModel') as HTMLInputElement;
        this.maxTokens = document.getElementById('prefsMaxTokens') as HTMLInputElement;
        this.defaultTempo = document.getElementById('prefsDefaultTempo') as HTMLInputElement;
        this.libraryRoot = document.getElementById('prefsLibraryRoot');
        this.autoCheck = document.getElementById('prefsAutoCheck') as HTMLInputElement;
        this.notifications = document.getElementById('prefsNotifications') as HTMLInputElement;
        this.metronomeVolume = document.getElementById('prefsMetronomeVolume') as HTMLInputElement;
        this.audioOutput = document.getElementById('prefsAudioOutput') as HTMLSelectElement;
        this.midiInputSelect = document.getElementById('prefsMidiInput') as HTMLSelectElement;
        this.midiCcGain = document.getElementById('prefsMidiCcGain') as HTMLInputElement;
        this.midiCcBpm = document.getElementById('prefsMidiCcBpm') as HTMLInputElement;
        document.getElementById('prefsAudioRefresh')?.addEventListener('click', () => void this.refreshAudioDevices());
        document.getElementById('prefsMidiRefresh')?.addEventListener('click', () => void this.refreshMidiDevices());

        document.getElementById('prefsSave')?.addEventListener('click', () => void this.save());
        document.getElementById('prefsChangeLibrary')?.addEventListener('click', () => void this.changeLibrary());

        this.inited = true;
    }

    async open(): Promise<void> {
        this.init();
        if (!this.root) return;
        await this.load();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
        this.apiKey?.focus();
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async load(): Promise<void> {
        if (!isTauri) return;
        try {
            const [settings, libRoot] = await Promise.all([
                invoke<UserSettings>('get_user_settings'),
                invoke<string>('get_library_root').catch(() => ''),
            ]);
            this.loaded = settings;
            if (this.apiKey) this.apiKey.value = settings.anthropic.api_key ?? '';
            if (this.model) this.model.value = settings.anthropic.model ?? '';
            if (this.maxTokens) {
                this.maxTokens.value = settings.anthropic.max_tokens != null
                    ? String(settings.anthropic.max_tokens) : '';
            }
            if (this.defaultTempo) {
                this.defaultTempo.value = settings.audio.default_tempo != null
                    ? String(settings.audio.default_tempo) : '';
            }
            if (this.libraryRoot) this.libraryRoot.textContent = libRoot || '—';
            if (this.autoCheck) this.autoCheck.checked = settings.updater.auto_check;
            if (this.notifications) this.notifications.checked = settings.notifications.enabled;
            if (this.metronomeVolume) {
                this.metronomeVolume.value = String(Math.round((settings.metronome?.volume ?? 0.4) * 100));
            }
            if (this.midiCcGain) this.midiCcGain.value = String(settings.midi_input?.cc_gain ?? 7);
            if (this.midiCcBpm)  this.midiCcBpm.value  = String(settings.midi_input?.cc_bpm  ?? 74);

            await this.refreshAudioDevices();
            await this.refreshMidiDevices();
        } catch (e) {
            console.warn('[prefs] load failed:', e);
        }
    }

    private collect(): UserSettings {
        const trimOrNull = (v: string | undefined): string | null => {
            const s = (v ?? '').trim();
            return s.length === 0 ? null : s;
        };
        const numOrNull = (el: HTMLInputElement | null): number | null => {
            if (!el) return null;
            const v = parseFloat(el.value);
            return Number.isFinite(v) ? v : null;
        };
        const baseMetronome = this.loaded?.metronome ?? {enabled: false, volume: 0.4};
        const baseMidi = this.loaded?.midi_input ?? {device_id: null, cc_gain: 7, cc_bpm: 74};
        const firstRunDone = this.loaded?.first_run_done ?? false;
        const volPct = numOrNull(this.metronomeVolume);
        const ccGain = numOrNull(this.midiCcGain);
        const ccBpm  = numOrNull(this.midiCcBpm);
        const midiDevice = this.midiInputSelect?.value ?? baseMidi.device_id ?? null;
        return {
            anthropic: {
                api_key: trimOrNull(this.apiKey?.value),
                model: trimOrNull(this.model?.value),
                max_tokens: numOrNull(this.maxTokens),
            },
            audio: {
                default_tempo: numOrNull(this.defaultTempo),
            },
            updater: {
                auto_check: !!this.autoCheck?.checked,
            },
            notifications: {
                enabled: !!this.notifications?.checked,
            },
            metronome: {
                enabled: baseMetronome.enabled,
                volume: volPct != null ? Math.max(0, Math.min(1, volPct / 100)) : baseMetronome.volume,
            },
            midi_input: {
                device_id: midiDevice && midiDevice.length > 0 ? midiDevice : null,
                cc_gain: ccGain != null ? Math.max(0, Math.min(127, Math.round(ccGain))) : baseMidi.cc_gain,
                cc_bpm:  ccBpm  != null ? Math.max(0, Math.min(127, Math.round(ccBpm)))  : baseMidi.cc_bpm,
            },
            first_run_done: firstRunDone,
        };
    }

    private async refreshAudioDevices(): Promise<void> {
        if (!this.audioOutput) return;
        try {
            // Ask for media permissions implicitly via getUserMedia so device
            // labels populate. We immediately stop the dummy track.
            try {
                const dummy = await navigator.mediaDevices.getUserMedia({audio: true});
                dummy.getTracks().forEach((t) => t.stop());
            } catch { /* permission denied — labels may be empty */ }
            const devices = await navigator.mediaDevices.enumerateDevices();
            const outputs = devices.filter((d) => d.kind === 'audiooutput');
            const prevValue = this.audioOutput.value;
            this.audioOutput.innerHTML = '<option value="">System default</option>';
            for (const d of outputs) {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Output ${d.deviceId.slice(0, 6)}`;
                this.audioOutput.appendChild(opt);
            }
            if (prevValue) this.audioOutput.value = prevValue;
        } catch (e) {
            console.warn('[prefs] enumerate audio devices failed:', e);
        }
    }

    private async refreshMidiDevices(): Promise<void> {
        if (!this.midiInputSelect) return;
        if (!('requestMIDIAccess' in navigator)) {
            this.midiInputSelect.innerHTML = '<option value="">Web MIDI not supported</option>';
            this.midiInputSelect.disabled = true;
            return;
        }
        try {
            const access = await (navigator as any).requestMIDIAccess({sysex: false});
            const inputs: any[] = [...access.inputs.values()];
            const prev = this.midiInputSelect.value || this.loaded?.midi_input?.device_id || '';
            this.midiInputSelect.innerHTML = '<option value="">All inputs</option>';
            for (const port of inputs) {
                const opt = document.createElement('option');
                opt.value = port.id;
                opt.textContent = port.name ?? port.id;
                this.midiInputSelect.appendChild(opt);
            }
            if (prev) this.midiInputSelect.value = prev;
            this.midiInputSelect.disabled = false;
        } catch (e) {
            console.warn('[prefs] requestMIDIAccess failed:', e);
            this.midiInputSelect.innerHTML = '<option value="">Permission denied</option>';
            this.midiInputSelect.disabled = true;
        }
    }

    private async save(): Promise<void> {
        if (!isTauri) return;
        try {
            const next = this.collect();
            await invoke<void>('set_user_settings', {settings: next});
            this.flash('Saved');
            // Reflect immediate-effect prefs in the running UI without a reload.
            const tempo = parseFloat(this.defaultTempo?.value ?? '');
            if (Number.isFinite(tempo)) {
                window.strudelApp?.applyBpm?.(tempo);
            }
            setNotificationsEnabled(next.notifications.enabled);
            metronome.setVolume(next.metronome.volume);
            midiInput.applyFromSettings(next.midi_input);
            await applyAudioSinkId(this.audioOutput?.value ?? '');
            this.close();
        } catch (e: any) {
            const {message} = await import('@tauri-apps/plugin-dialog');
            await message(`Could not save preferences:\n${e}`, {title: 'Robostrudel', kind: 'error'});
        }
    }

    private async changeLibrary(): Promise<void> {
        if (!isTauri) return;
        const {open} = await import('@tauri-apps/plugin-dialog');
        const picked = await open({directory: true, multiple: false});
        const path = typeof picked === 'string' ? picked : null;
        if (!path) return;
        try {
            await invoke('set_library_root', {path});
            if (this.libraryRoot) this.libraryRoot.textContent = path;
        } catch (e: any) {
            console.warn('[prefs] set_library_root failed:', e);
        }
    }

    private flash(text: string): void {
        const btn = document.getElementById('prefsSave') as HTMLButtonElement | null;
        if (!btn) return;
        const prev = btn.textContent;
        btn.textContent = text;
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = prev ?? 'Save';
            btn.disabled = false;
        }, 700);
    }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}

async function applyAudioSinkId(deviceId: string): Promise<void> {
    const ctx = window.strudelApp?.audioManager?.getAudioContext?.() as
        (AudioContext & {setSinkId?: (id: string) => Promise<void>}) | null | undefined;
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    try {
        await ctx.setSinkId(deviceId);
    } catch (e) {
        console.warn('[prefs] setSinkId failed:', e);
    }
}

export const preferencesModal = new PreferencesModal();
(window as any).preferencesModal = preferencesModal;
