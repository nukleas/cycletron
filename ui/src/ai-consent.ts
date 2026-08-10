/**
 * AI consent dialog. AI is opt-in and off by default — this modal is the one
 * deliberate gesture that turns it on. On Enable it flips `ai_consent` in the
 * persisted UserSettings (which rebuilds the agent client Rust-side) and fires
 * `ai-consent:changed` so the AI panel wires itself live. Declining leaves AI
 * fully inert.
 */

import {invoke, isTauri} from './tauri.js';
import {dismissibleModal} from './modal-utils.js';
import {preferencesModal} from './preferences.js';
import type {UserSettings} from './types/tauri-commands.js';

class AiConsentModal {
    private root: HTMLElement | null = null;
    private cleanup: (() => void) | null = null;
    private inited = false;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('aiConsentModal');
        if (!this.root) return;
        document.getElementById('aiConsentEnable')?.addEventListener('click', () => void this.enable());
        this.inited = true;
    }

    open(): void {
        this.init();
        if (!this.root) return;
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async enable(): Promise<void> {
        if (!isTauri) return;
        try {
            const settings = await invoke<UserSettings>('get_user_settings');
            await invoke<void>('set_user_settings', {settings: {...settings, ai_consent: true}});
            document.dispatchEvent(new CustomEvent('ai-consent:changed'));
            this.close();

            // If the active provider has no key/session yet, send the user to
            // Preferences → AI to finish setup. Local/OAuth providers may need
            // nothing, so this is best-effort.
            const active = settings.llm?.active ?? 'anthropic';
            let hasKey = true;
            try {
                hasKey = await invoke<boolean>('has_provider_key', {provider: active});
            } catch {
                /* leave as-is */
            }
            if (!hasKey) {
                await preferencesModal.open();
            } else {
                (document.getElementById('aiInput') as HTMLInputElement | null)?.focus();
            }
        } catch (e) {
            console.warn('[ai-consent] enable failed', e);
        }
    }
}

export const aiConsent = new AiConsentModal();
