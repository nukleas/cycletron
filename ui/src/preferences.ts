/**
 * Preferences modal — backed by the Rust `get_user_settings` /
 * `set_user_settings` commands. Persists to `{app_data_dir}/settings.json`.
 *
 * Triggered by:
 *   - "Cycletron → Preferences…" menu (Cmd+,)
 *   - The "Change…" buttons from other modals (e.g. Library root in here)
 */

import {invoke, isTauri} from './tauri.js';
import {errorDialog, openPathDialog} from './dialog.js';
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


export class PreferencesModal {
    private root: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    // Form refs
    private aiConsent: HTMLInputElement | null = null;
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
    private editorAssist: HTMLInputElement | null = null;
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

        this.aiConsent = document.getElementById('prefsAiConsent') as HTMLInputElement;
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
        this.editorAssist = document.getElementById('prefsEditorAssist') as HTMLInputElement;
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
        document.getElementById('prefsGrokSignIn')?.addEventListener('click', () => void this.grokOAuthSignIn());
        document.getElementById('prefsGrokImport')?.addEventListener('click', () => void this.grokOAuthImport());
        document.getElementById('prefsGrokSignOut')?.addEventListener('click', () => void this.grokOAuthSignOut());
        document.getElementById('prefsCodexSignIn')?.addEventListener('click', () => void this.codexOAuthSignIn());
        document.getElementById('prefsCodexImport')?.addEventListener('click', () => void this.codexOAuthImport());
        document.getElementById('prefsCodexSignOut')?.addEventListener('click', () => void this.codexOAuthSignOut());

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
            if (this.aiConsent) this.aiConsent.checked = !!settings.ai_consent;
            // AI: seed the in-memory provider map, select the active provider,
            // and paint its fields. Keys are write-only (secrets store),
            // so the key input starts empty and a status line reports whether one
            // exists.
            this.llm = normalizeLlm(settings.llm);
            this.currentProviderId = this.llm.active;
            if (this.provider) this.provider.value = this.currentProviderId;
            this.applyProviderToForm(this.currentProviderId);
            await this.refreshKeyStatus(this.currentProviderId);
            await this.refreshGrokOauthUi();
            await this.refreshCodexOauthUi();
            if (this.defaultTempo) {
                this.defaultTempo.value = settings.audio.default_tempo != null
                    ? String(settings.audio.default_tempo) : '';
            }
            if (this.libraryRoot) this.libraryRoot.textContent = libRoot || '—';
            if (this.autoCheck) this.autoCheck.checked = settings.updater.auto_check;
            if (this.notifications) this.notifications.checked = settings.notifications.enabled;
            if (this.editorAssist) this.editorAssist.checked = settings.editor?.assist_enabled ?? true;
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
        await this.refreshGrokOauthUi();
        await this.refreshCodexOauthUi();
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
        const grokPanel = document.getElementById('prefsGrokOauth');
        if (grokPanel) grokPanel.hidden = id !== 'grok';
        const codexPanel = document.getElementById('prefsCodexOauth');
        if (codexPanel) codexPanel.hidden = id !== 'codex';
        // Codex is subscription-only — hide the API key field noise a bit.
        if (this.apiKey) {
            const keyLabel = this.apiKey.closest('label');
            if (keyLabel) (keyLabel as HTMLElement).hidden = id === 'codex';
        }
    }

    private async refreshGrokOauthUi(): Promise<void> {
        const panel = document.getElementById('prefsGrokOauth');
        const statusEl = document.getElementById('prefsGrokOauthStatus');
        const signOut = document.getElementById('prefsGrokSignOut') as HTMLButtonElement | null;
        const importBtn = document.getElementById('prefsGrokImport') as HTMLButtonElement | null;
        if (!panel || this.currentProviderId !== 'grok') {
            if (panel) panel.hidden = true;
            return;
        }
        panel.hidden = false;
        try {
            const st = await invoke<{
                signed_in: boolean;
                email: string | null;
                expires_at: number | null;
                source: string | null;
                grok_build_available: boolean;
            }>('xai_oauth_status');
            if (statusEl) {
                if (st.signed_in) {
                    const who = st.email ? ` as ${st.email}` : '';
                    const src = st.source ? ` (${st.source})` : '';
                    statusEl.textContent = `Signed in with SuperGrok OAuth${who}${src}. Usage bills to your xAI subscription.`;
                    statusEl.classList.add('is-ok');
                } else if (st.grok_build_available) {
                    statusEl.textContent = 'Grok Build session found on this Mac — click “Import Grok Build session”, or sign in fresh.';
                    statusEl.classList.remove('is-ok');
                } else {
                    statusEl.textContent = 'Use your SuperGrok / SuperHeavy subscription via OAuth — no API key required. Or paste a console.x.ai API key above.';
                    statusEl.classList.remove('is-ok');
                }
            }
            if (signOut) signOut.hidden = !st.signed_in;
            if (importBtn) importBtn.hidden = !st.grok_build_available && st.signed_in;
        } catch (e) {
            if (statusEl) statusEl.textContent = `OAuth status unavailable: ${e}`;
        }
    }

    private async grokOAuthSignIn(): Promise<void> {
        const statusEl = document.getElementById('prefsGrokOauthStatus');
        try {
            if (statusEl) {
                statusEl.textContent = 'Starting xAI sign-in…';
                statusEl.classList.remove('is-ok');
            }
            const start = await invoke<{
                user_code: string;
                verification_uri: string;
                verification_uri_complete: string | null;
                expires_in: number;
                interval: number;
                device_code: string;
            }>('xai_oauth_start_login');
            if (statusEl) {
                statusEl.textContent = `Approve in browser (code ${start.user_code}). Waiting for xAI…`;
            }
            await invoke('xai_oauth_poll_login', {
                deviceCode: start.device_code,
                interval: start.interval,
                expiresIn: start.expires_in,
            });
            // Prefer Grok as active after successful OAuth.
            this.currentProviderId = 'grok';
            this.llm.active = 'grok';
            if (this.provider) this.provider.value = 'grok';
            this.applyProviderToForm('grok');
            await this.refreshKeyStatus('grok');
            await this.refreshGrokOauthUi();
            this.flash('Signed in with SuperGrok');
        } catch (e: any) {
            if (statusEl) statusEl.textContent = String(e);
            await errorDialog(`SuperGrok sign-in failed:\n${e}`);
        }
    }

    private async grokOAuthImport(): Promise<void> {
        const statusEl = document.getElementById('prefsGrokOauthStatus');
        try {
            await invoke('xai_oauth_import_grok_build');
            this.currentProviderId = 'grok';
            this.llm.active = 'grok';
            if (this.provider) this.provider.value = 'grok';
            this.applyProviderToForm('grok');
            await this.refreshKeyStatus('grok');
            await this.refreshGrokOauthUi();
            this.flash('Imported Grok Build session');
        } catch (e: any) {
            if (statusEl) statusEl.textContent = String(e);
            await errorDialog(`Import failed:\n${e}`);
        }
    }

    private async grokOAuthSignOut(): Promise<void> {
        try {
            await invoke('xai_oauth_logout');
            await this.refreshKeyStatus('grok');
            await this.refreshGrokOauthUi();
            this.flash('Signed out of SuperGrok OAuth');
        } catch (e: any) {
            await errorDialog(`Sign out failed:\n${e}`);
        }
    }

    private async refreshCodexOauthUi(): Promise<void> {
        const panel = document.getElementById('prefsCodexOauth');
        const statusEl = document.getElementById('prefsCodexOauthStatus');
        const signOut = document.getElementById('prefsCodexSignOut') as HTMLButtonElement | null;
        const importBtn = document.getElementById('prefsCodexImport') as HTMLButtonElement | null;
        if (!panel || this.currentProviderId !== 'codex') {
            if (panel) panel.hidden = true;
            return;
        }
        panel.hidden = false;
        try {
            const st = await invoke<{
                signed_in: boolean;
                email: string | null;
                account_id: string | null;
                source: string | null;
                codex_cli_available: boolean;
            }>('codex_oauth_status');
            if (statusEl) {
                if (st.signed_in) {
                    const who = st.email ? ` as ${st.email}` : '';
                    const src = st.source ? ` (${st.source})` : '';
                    statusEl.textContent = `Signed in with ChatGPT / Codex OAuth${who}${src}. Usage bills to your ChatGPT plan.`;
                    statusEl.classList.add('is-ok');
                } else if (st.codex_cli_available) {
                    statusEl.textContent = 'Codex CLI session found — click “Import Codex CLI session”, or sign in fresh.';
                    statusEl.classList.remove('is-ok');
                } else {
                    statusEl.textContent = 'Use your ChatGPT Plus/Pro/Codex plan via OAuth — same as `codex login`. No API key.';
                    statusEl.classList.remove('is-ok');
                }
            }
            if (signOut) signOut.hidden = !st.signed_in;
            if (importBtn) importBtn.hidden = !st.codex_cli_available && st.signed_in;
        } catch (e) {
            if (statusEl) statusEl.textContent = `OAuth status unavailable: ${e}`;
        }
    }

    private async codexOAuthSignIn(): Promise<void> {
        const statusEl = document.getElementById('prefsCodexOauthStatus');
        try {
            if (statusEl) {
                statusEl.textContent = 'Opening ChatGPT sign-in in your browser… (localhost:1455 callback)';
                statusEl.classList.remove('is-ok');
            }
            await invoke('codex_oauth_login');
            this.currentProviderId = 'codex';
            this.llm.active = 'codex';
            if (this.provider) this.provider.value = 'codex';
            this.applyProviderToForm('codex');
            await this.refreshKeyStatus('codex');
            await this.refreshCodexOauthUi();
            this.flash('Signed in with ChatGPT / Codex');
        } catch (e: any) {
            if (statusEl) statusEl.textContent = String(e);
            await errorDialog(`Codex sign-in failed:\n${e}`);
        }
    }

    private async codexOAuthImport(): Promise<void> {
        const statusEl = document.getElementById('prefsCodexOauthStatus');
        try {
            await invoke('codex_oauth_import_cli');
            this.currentProviderId = 'codex';
            this.llm.active = 'codex';
            if (this.provider) this.provider.value = 'codex';
            this.applyProviderToForm('codex');
            await this.refreshKeyStatus('codex');
            await this.refreshCodexOauthUi();
            this.flash('Imported Codex CLI session');
        } catch (e: any) {
            if (statusEl) statusEl.textContent = String(e);
            await errorDialog(`Import failed:\n${e}`);
        }
    }

    private async codexOAuthSignOut(): Promise<void> {
        try {
            await invoke('codex_oauth_logout');
            await this.refreshKeyStatus('codex');
            await this.refreshCodexOauthUi();
            this.flash('Signed out of Codex OAuth');
        } catch (e: any) {
            await errorDialog(`Sign out failed:\n${e}`);
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

    /** Reflect whether a key/OAuth session is stored for this provider (never shows secrets). */
    private async refreshKeyStatus(id: string): Promise<void> {
        if (!this.keyStatus) return;
        let has = false;
        try {
            has = await invoke<boolean>('has_provider_key', {provider: id});
        } catch { /* ignore */ }
        const required = presetById(id)?.keyRequired ?? true;
        let label = has
            ? 'Key saved ✓'
            : (required ? 'No key set' : 'No key (optional)');
        if (id === 'grok' && has) {
            try {
                const st = await invoke<{signed_in: boolean; email: string | null}>('xai_oauth_status');
                if (st.signed_in) {
                    label = st.email
                        ? `SuperGrok OAuth ✓ (${st.email})`
                        : 'SuperGrok OAuth ✓';
                }
            } catch { /* keep key label */ }
        }
        if (id === 'codex' && has) {
            try {
                const st = await invoke<{signed_in: boolean; email: string | null}>('codex_oauth_status');
                if (st.signed_in) {
                    label = st.email
                        ? `Codex OAuth ✓ (${st.email})`
                        : 'Codex OAuth ✓';
                }
            } catch { /* keep key label */ }
        }
        this.keyStatus.textContent = label;
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
            // Legacy block, now always empty — keys live in the secrets store.
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
            editor: {
                assist_enabled: this.editorAssist ? !!this.editorAssist.checked : (this.loaded?.editor?.assist_enabled ?? true),
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
            ai_consent: this.aiConsent ? !!this.aiConsent.checked : (this.loaded?.ai_consent ?? false),
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
            label.setAttribute('data-tooltip', action.hint);

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
            clear.setAttribute('data-tooltip', 'Remove binding');
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
            // Persist a newly-typed key into the secrets store first, so the client
            // rebuild inside set_user_settings picks it up. Empty = leave as-is.
            const typedKey = (this.apiKey?.value ?? '').trim();
            if (typedKey.length > 0) {
                await invoke<void>('set_provider_key', {provider: this.currentProviderId, key: typedKey});
                if (this.apiKey) this.apiKey.value = '';
            }
            await invoke<void>('set_user_settings', {settings: next});
            await this.refreshKeyStatus(this.currentProviderId);
            // Let the AI panel wire/unwire itself to match the consent flag.
            document.dispatchEvent(new CustomEvent('ai-consent:changed'));
            this.flash('Saved');
            // Reflect immediate-effect prefs in the running UI without a reload.
            const tempo = parseFloat(this.defaultTempo?.value ?? '');
            if (Number.isFinite(tempo)) {
                window.strudelApp?.applyBpm?.(tempo);
            }
            setNotificationsEnabled(next.notifications.enabled);
            window.strudelApp?.editor?.setAssistEnabled(next.editor.assist_enabled);
            metronome.setVolume(next.metronome.volume);
            midiInput.applyFromSettings(next.midi_input);
            await applyAudioSinkId(this.audioOutput?.value ?? '');
            this.close();
        } catch (e: any) {
            await errorDialog(`Could not save preferences:\n${e}`);
        }
    }

    private async changeLibrary(): Promise<void> {
        if (!isTauri) return;
        const path = await openPathDialog({directory: true});
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
window.preferencesModal = preferencesModal;

/**
 * Persist just the editor-assist flag to the Rust settings via a read-modify-
 * write, leaving every other preference untouched. Lets the command-palette /
 * menu toggle survive a restart without opening the modal. No-op outside Tauri.
 */
export async function persistEditorAssist(enabled: boolean): Promise<void> {
    if (!isTauri) return;
    try {
        const settings = await invoke<UserSettings>('get_user_settings');
        settings.editor = {assist_enabled: enabled};
        await invoke<void>('set_user_settings', {settings});
    } catch (e) {
        console.warn('[prefs] persist editor assist failed:', e);
    }
}
