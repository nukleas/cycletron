/**
 * Preferences modal — backed by the Rust `get_user_settings` /
 * `set_user_settings` commands. Persists to `{app_data_dir}/settings.json`.
 *
 * Triggered by:
 *   - "Cycletron → Preferences…" menu (Cmd+,)
 *   - The "Change…" buttons from other modals (e.g. Library root in here)
 */

import {invoke} from './tauri.js';
import type {UserSettings, PadAssignment, LlmSettings} from './types/tauri-commands.js';
import {presetById, presetProfile, defaultLlmSettings, normalizeLlm} from './providers.js';
import {dismissibleModal} from './modal-utils.js';
import {setNotificationsEnabled} from './notifications.js';
import {metronome} from './metronome.js';
import {midiInput} from './midi-input.js';
import {midiPads, PAD_ACTIONS} from './midi-pads.js';
import {midiToNoteName} from './midi-capture.js';
import {midiMonitor} from './midi-monitor.js';

/** Subset of the `list_sounds` catalog the monitor instrument picker needs. */
interface SoundCatalog {
    synths: string[];
    wavetables: string[];
    gm_instruments: string[];
    user_sample_banks: string[];
}

const isTauri = !!(window as any).__TAURI__;

export class PreferencesModal {
    private root: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    // Form refs
    private provider: HTMLSelectElement | null = null;
    private apiKey: HTMLInputElement | null = null;
    private keyStatus: HTMLElement | null = null;
    private baseUrl: HTMLInputElement | null = null;
    private baseUrlField: HTMLElement | null = null;
    private providerNote: HTMLElement | null = null;
    private model: HTMLInputElement | null = null;
    private maxTokens: HTMLInputElement | null = null;
    /** In-memory LLM config (active provider + per-provider profiles). */
    private llm: LlmSettings = defaultLlmSettings();
    /** Which provider's fields the form currently shows. */
    private currentProviderId = 'anthropic';
    private defaultTempo: HTMLInputElement | null = null;
    private libraryRoot: HTMLElement | null = null;
    private autoCheck: HTMLInputElement | null = null;
    private notifications: HTMLInputElement | null = null;
    private metronomeVolume: HTMLInputElement | null = null;
    private audioOutput: HTMLSelectElement | null = null;
    private midiInputSelect: HTMLSelectElement | null = null;
    private midiCcGain: HTMLInputElement | null = null;
    private midiCcBpm: HTMLInputElement | null = null;
    private midiMonitorEnabled: HTMLInputElement | null = null;
    private midiMonitorInstrument: HTMLSelectElement | null = null;
    private midiMonitorGain: HTMLInputElement | null = null;
    private midiPadsContainer: HTMLElement | null = null;
    /** The most recently loaded settings — used to preserve fields the
     *  modal doesn't explicitly edit. */
    private loaded: UserSettings | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('prefsModal');
        if (!this.root) return;

        this.provider = document.getElementById('prefsProvider') as HTMLSelectElement;
        this.apiKey = document.getElementById('prefsApiKey') as HTMLInputElement;
        this.keyStatus = document.getElementById('prefsKeyStatus');
        this.baseUrl = document.getElementById('prefsBaseUrl') as HTMLInputElement;
        this.baseUrlField = document.getElementById('prefsBaseUrlField');
        this.providerNote = document.getElementById('prefsProviderNote');
        this.model = document.getElementById('prefsModel') as HTMLInputElement;
        this.maxTokens = document.getElementById('prefsMaxTokens') as HTMLInputElement;
        this.provider?.addEventListener('change', () => void this.onProviderChange());
        this.defaultTempo = document.getElementById('prefsDefaultTempo') as HTMLInputElement;
        this.libraryRoot = document.getElementById('prefsLibraryRoot');
        this.autoCheck = document.getElementById('prefsAutoCheck') as HTMLInputElement;
        this.notifications = document.getElementById('prefsNotifications') as HTMLInputElement;
        this.metronomeVolume = document.getElementById('prefsMetronomeVolume') as HTMLInputElement;
        this.audioOutput = document.getElementById('prefsAudioOutput') as HTMLSelectElement;
        this.midiInputSelect = document.getElementById('prefsMidiInput') as HTMLSelectElement;
        this.midiCcGain = document.getElementById('prefsMidiCcGain') as HTMLInputElement;
        this.midiCcBpm = document.getElementById('prefsMidiCcBpm') as HTMLInputElement;
        this.midiMonitorEnabled = document.getElementById('prefsMidiMonitorEnabled') as HTMLInputElement;
        this.midiMonitorInstrument = document.getElementById('prefsMidiMonitorInstrument') as HTMLSelectElement;
        this.midiMonitorGain = document.getElementById('prefsMidiMonitorGain') as HTMLInputElement;
        this.midiPadsContainer = document.getElementById('prefsMidiPads');
        // Refresh the instrument list when user sample banks change.
        document.addEventListener('sounds:changed', () => void this.populateMonitorInstruments());
        document.getElementById('prefsAudioRefresh')?.addEventListener('click', () => void this.refreshAudioDevices());
        document.getElementById('prefsMidiRefresh')?.addEventListener('click', () => void this.refreshMidiDevices());

        // Re-render the pad table after a successful "learn".
        midiPads.onLearned = () => this.renderPads();

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
        midiPads.cancelLearn();
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
            // AI: seed the in-memory provider map, select the active provider,
            // and paint its fields. Keys are write-only (kept in the keychain),
            // so the key input starts empty and a status line reports whether one
            // exists.
            this.llm = normalizeLlm(settings.llm);
            this.currentProviderId = this.llm.active;
            if (this.provider) this.provider.value = this.currentProviderId;
            this.applyProviderToForm(this.currentProviderId);
            await this.refreshKeyStatus(this.currentProviderId);
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
            if (this.midiMonitorEnabled) this.midiMonitorEnabled.checked = settings.midi_input?.monitor_enabled ?? false;
            await this.populateMonitorInstruments();
            if (this.midiMonitorInstrument) this.midiMonitorInstrument.value = settings.midi_input?.monitor_instrument ?? 'sawtooth';
            if (this.midiMonitorGain) this.midiMonitorGain.value = String(Math.round((settings.midi_input?.monitor_gain ?? 0.8) * 100));
            // Seed the live pad matcher from persisted settings, then render rows.
            midiPads.setAssignments(settings.midi_input?.pad_assignments ?? []);
            this.renderPads();

            await this.refreshAudioDevices();
            await this.refreshMidiDevices();
        } catch (e) {
            console.warn('[prefs] load failed:', e);
        }
    }

    /** Provider dropdown changed: stash the old provider's edits, show the new. */
    private async onProviderChange(): Promise<void> {
        const next = this.provider?.value ?? 'anthropic';
        if (next === this.currentProviderId) return;
        this.captureFormToProvider(this.currentProviderId);
        this.currentProviderId = next;
        this.llm.active = next;
        this.applyProviderToForm(next);
        if (this.apiKey) this.apiKey.value = '';
        await this.refreshKeyStatus(next);
    }

    /** Paint the model / base-URL / max-tokens fields for a provider, plus its
     *  placeholder, base-URL visibility, and note. */
    private applyProviderToForm(id: string): void {
        const preset = presetById(id);
        const prof = this.llm.providers[id] ?? presetProfile(id);
        if (this.model) this.model.value = prof.model ?? '';
        if (this.maxTokens) this.maxTokens.value = prof.max_tokens != null ? String(prof.max_tokens) : '';
        if (this.baseUrl) this.baseUrl.value = prof.base_url ?? '';
        if (this.baseUrlField) this.baseUrlField.hidden = !(preset?.showBaseUrl ?? prof.codec === 'openai');
        if (this.apiKey) this.apiKey.placeholder = preset?.keyPlaceholder ?? 'API key';
        if (this.model) this.model.placeholder = preset?.model || 'model id';
        if (this.providerNote) {
            const note = preset?.note ?? '';
            this.providerNote.textContent = note;
            this.providerNote.hidden = note.length === 0;
        }
    }

    /** Read the currently-shown fields back into a provider's in-memory profile. */
    private captureFormToProvider(id: string): void {
        const preset = presetById(id);
        const base = (this.baseUrl?.value ?? '').trim();
        const model = (this.model?.value ?? '').trim();
        const mt = parseInt(this.maxTokens?.value ?? '', 10);
        const prev = this.llm.providers[id] ?? presetProfile(id);
        this.llm.providers[id] = {
            codec: preset?.codec ?? prev.codec,
            base_url: (preset?.showBaseUrl ?? prev.codec === 'openai')
                ? (base.length > 0 ? base : null)
                : null,
            model: model.length > 0 ? model : prev.model,
            max_tokens: Number.isFinite(mt) ? mt : prev.max_tokens,
        };
    }

    /** Reflect whether a key is stored for this provider (never shows the key). */
    private async refreshKeyStatus(id: string): Promise<void> {
        if (!this.keyStatus) return;
        let has = false;
        try {
            has = await invoke<boolean>('has_provider_key', {provider: id});
        } catch { /* ignore */ }
        const required = presetById(id)?.keyRequired ?? true;
        this.keyStatus.textContent = has
            ? 'Key saved ✓'
            : (required ? 'No key set' : 'No key (optional)');
        this.keyStatus.classList.toggle('is-ok', has);
    }

    private collect(): UserSettings {
        const numOrNull = (el: HTMLInputElement | null): number | null => {
            if (!el) return null;
            const v = parseFloat(el.value);
            return Number.isFinite(v) ? v : null;
        };
        const baseMetronome = this.loaded?.metronome ?? {enabled: false, volume: 0.4};
        const baseMidi = this.loaded?.midi_input;
        const firstRunDone = this.loaded?.first_run_done ?? false;
        const volPct = numOrNull(this.metronomeVolume);
        const ccGain = numOrNull(this.midiCcGain);
        const ccBpm  = numOrNull(this.midiCcBpm);
        const midiDevice = this.midiInputSelect?.value ?? baseMidi?.device_id ?? null;
        const monitorGainPct = numOrNull(this.midiMonitorGain);
        // Fold the currently-shown fields back into the active provider's
        // profile, then ship the whole map. Keys are handled separately.
        this.captureFormToProvider(this.currentProviderId);
        this.llm.active = this.currentProviderId;
        return {
            llm: this.llm,
            // Legacy block, now always empty — keys live in the keychain.
            anthropic: {api_key: null, model: null, max_tokens: null},
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
                cc_gain: ccGain != null ? Math.max(0, Math.min(127, Math.round(ccGain))) : (baseMidi?.cc_gain ?? 7),
                cc_bpm:  ccBpm  != null ? Math.max(0, Math.min(127, Math.round(ccBpm)))  : (baseMidi?.cc_bpm ?? 74),
                monitor_enabled: !!this.midiMonitorEnabled?.checked,
                monitor_instrument: this.midiMonitorInstrument?.value || (baseMidi?.monitor_instrument ?? 'gm_piano'),
                monitor_gain: monitorGainPct != null ? Math.max(0, Math.min(1, monitorGainPct / 100)) : (baseMidi?.monitor_gain ?? 0.8),
                pad_assignments: midiPads.getAssignments(),
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
        try {
            const devices = await midiInput.listDevices();
            const prev = this.midiInputSelect.value || this.loaded?.midi_input?.device_id || '';
            this.midiInputSelect.innerHTML = '<option value="">All inputs</option>';
            for (const dev of devices) {
                const opt = document.createElement('option');
                opt.value = dev.id;
                opt.textContent = dev.name;
                this.midiInputSelect.appendChild(opt);
            }
            if (prev) this.midiInputSelect.value = prev;
            this.midiInputSelect.disabled = false;
        } catch (e) {
            console.warn('[prefs] list MIDI devices failed:', e);
            this.midiInputSelect.innerHTML = '<option value="">No MIDI devices</option>';
            this.midiInputSelect.disabled = true;
        }
    }

    /**
     * Fill the monitor instrument dropdown from the `list_sounds` catalog — the
     * single source of truth. Voices the monitor can't synth (wavetables, fm,
     * noise, user banks) are listed but disabled with a "(pattern only)" tag.
     * Refreshed on `sounds:changed` so user sample banks appear once loaded.
     */
    private async populateMonitorInstruments(): Promise<void> {
        const sel = this.midiMonitorInstrument;
        if (!sel) return;
        let cat: SoundCatalog;
        try {
            cat = await invoke<SoundCatalog>('list_sounds');
        } catch {
            return; // not under Tauri / engine not ready — leave whatever's there
        }
        const prev = sel.value || this.loaded?.midi_input?.monitor_instrument || 'sawtooth';
        const titleCase = (s: string) =>
            s.replace(/^(gm_|wt_)/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

        const addGroup = (label: string, names: string[]) => {
            if (names.length === 0) return;
            const group = document.createElement('optgroup');
            group.label = label;
            for (const name of names) {
                const opt = document.createElement('option');
                opt.value = name;
                const playable = midiMonitor.canPlay(name);
                opt.textContent = playable ? titleCase(name) : `${titleCase(name)} (pattern only)`;
                opt.disabled = !playable;
                group.appendChild(opt);
            }
            sel.appendChild(group);
        };

        sel.innerHTML = '';
        addGroup('Synths', cat.synths ?? []);
        addGroup('Wavetables', cat.wavetables ?? []);
        addGroup('General MIDI', cat.gm_instruments ?? []);
        addGroup('Your Samples', cat.user_sample_banks ?? []);

        // Preserve a previously-saved instrument that the catalog doesn't list
        // (e.g. an off-list GM the monitor can still play), so we don't reset it.
        if (prev && midiMonitor.canPlay(prev) && ![...sel.options].some((o) => o.value === prev)) {
            const opt = document.createElement('option');
            opt.value = prev;
            opt.textContent = titleCase(prev);
            sel.appendChild(opt);
        }

        // Restore prior selection if it's still a valid, enabled option.
        const match = [...sel.options].find((o) => o.value === prev && !o.disabled);
        sel.value = match ? prev : 'sawtooth';
    }

    /** Render one row per pad action with its current binding + Learn/Clear. */
    private renderPads(): void {
        const container = this.midiPadsContainer;
        if (!container) return;
        container.innerHTML = '';
        for (const action of PAD_ACTIONS) {
            const assignment = midiPads.assignmentFor(action.id);
            const row = document.createElement('div');
            row.className = 'prefs-pad-row';

            const label = document.createElement('span');
            label.className = 'prefs-pad-label';
            label.textContent = action.label;
            label.title = action.hint;

            const binding = document.createElement('span');
            binding.className = 'prefs-pad-binding';
            binding.textContent = assignment ? bindingLabel(assignment) : '—';

            const learn = document.createElement('button');
            learn.className = 'prefs-inline-btn';
            learn.type = 'button';
            learn.textContent = 'Learn';
            learn.addEventListener('click', () => {
                midiPads.startLearn(action.id);
                binding.textContent = 'Press a pad/key…';
            });

            const clear = document.createElement('button');
            clear.className = 'prefs-inline-btn';
            clear.type = 'button';
            clear.textContent = '✕';
            clear.title = 'Remove binding';
            clear.addEventListener('click', () => {
                midiPads.setAssignments(midiPads.getAssignments().filter((a) => a.action !== action.id));
                this.renderPads();
            });

            row.append(label, binding, learn, clear);
            container.appendChild(row);
        }
    }

    private async save(): Promise<void> {
        if (!isTauri) return;
        try {
            const next = this.collect();
            // Persist a newly-typed key into the keychain first, so the client
            // rebuild inside set_user_settings picks it up. Empty = leave as-is.
            const typedKey = (this.apiKey?.value ?? '').trim();
            if (typedKey.length > 0) {
                await invoke<void>('set_provider_key', {provider: this.currentProviderId, key: typedKey});
                if (this.apiKey) this.apiKey.value = '';
            }
            await invoke<void>('set_user_settings', {settings: next});
            await this.refreshKeyStatus(this.currentProviderId);
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
            await message(`Could not save preferences:\n${e}`, {title: 'Cycletron', kind: 'error'});
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

/** Human-readable label for a pad binding, e.g. "CC 12" or "C4". */
function bindingLabel(a: PadAssignment): string {
    return a.trigger.kind === 'cc'
        ? `CC ${a.trigger.value}`
        : midiToNoteName(a.trigger.value).toUpperCase();
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
