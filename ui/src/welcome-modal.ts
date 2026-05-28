/**
 * First-run onboarding. Loaded on every boot, but only opens itself when
 * `userSettings.first_run_done` is false. Walks the user through four
 * cards (intro shortcuts, API key, library root, success) and marks the
 * flag on Finish or any explicit dismiss.
 */

import {dismissibleModal} from './modal-utils.js';
import type {UserSettings} from './types/tauri-commands.js';

const isTauri = !!(window as any).__TAURI__;
const STEP_COUNT = 4;

class WelcomeModal {
    private root: HTMLElement | null = null;
    private steps: HTMLElement[] = [];
    private back: HTMLButtonElement | null = null;
    private next: HTMLButtonElement | null = null;
    private label: HTMLElement | null = null;
    private apiKeyInput: HTMLInputElement | null = null;
    private libraryRoot: HTMLElement | null = null;
    private cleanup: (() => void) | null = null;
    private idx = 0;
    private settings: UserSettings | null = null;

    init(): void {
        this.root = document.getElementById('welcomeModal');
        if (!this.root) return;
        this.steps = Array.from(this.root.querySelectorAll<HTMLElement>('.welcome-step'));
        this.back = document.getElementById('welcomeBack') as HTMLButtonElement | null;
        this.next = document.getElementById('welcomeNext') as HTMLButtonElement | null;
        this.label = document.getElementById('welcomeStepLabel');
        this.apiKeyInput = document.getElementById('welcomeApiKey') as HTMLInputElement | null;
        this.libraryRoot = document.getElementById('welcomeLibraryRoot');

        this.back?.addEventListener('click', () => this.go(-1));
        this.next?.addEventListener('click', () => void this.advance());
        document.getElementById('welcomeChangeLibrary')?.addEventListener('click', () => void this.changeLibrary());
    }

    /** Show the modal if this is a first run. Resolves either way. */
    async maybeOpen(): Promise<void> {
        if (!isTauri || !this.root) return;
        try {
            this.settings = await invoke<UserSettings>('get_user_settings');
        } catch {
            return;
        }
        if (this.settings.first_run_done) return;
        await this.openExplicit();
    }

    async openExplicit(): Promise<void> {
        if (!this.root) return;
        if (!this.settings && isTauri) {
            try { this.settings = await invoke<UserSettings>('get_user_settings'); } catch { /* ignore */ }
        }
        this.idx = 0;
        this.renderStep();
        try {
            const root = await invoke<string>('get_library_root');
            if (this.libraryRoot) this.libraryRoot.textContent = root || '—';
        } catch { /* ignore */ }
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => void this.finish(true));
    }

    private renderStep(): void {
        for (let i = 0; i < this.steps.length; i++) {
            this.steps[i].hidden = i !== this.idx;
        }
        if (this.label) this.label.textContent = `${this.idx + 1} / ${STEP_COUNT}`;
        if (this.back) this.back.disabled = this.idx === 0;
        if (this.next) this.next.textContent = this.idx === STEP_COUNT - 1 ? 'Finish' : 'Next';
    }

    private go(delta: number): void {
        this.idx = Math.max(0, Math.min(STEP_COUNT - 1, this.idx + delta));
        this.renderStep();
    }

    private async advance(): Promise<void> {
        if (this.idx === STEP_COUNT - 1) {
            await this.finish(false);
            return;
        }
        this.idx += 1;
        this.renderStep();
    }

    private async finish(dismissed: boolean): Promise<void> {
        const apiKey = this.apiKeyInput?.value.trim() || '';
        if (this.settings && isTauri) {
            try {
                const next: UserSettings = {
                    ...this.settings,
                    anthropic: {
                        ...this.settings.anthropic,
                        api_key: apiKey ? apiKey : this.settings.anthropic.api_key,
                    },
                    first_run_done: true,
                };
                await invoke<void>('set_user_settings', {settings: next});
                this.settings = next;
            } catch (e) {
                console.warn('[welcome] could not persist:', e);
            }
        }
        this.close();
        if (!dismissed) {
            // Subtle nudge: focus the AI input so the user has somewhere to go.
            (document.getElementById('aiInput') as HTMLInputElement | null)?.focus();
        }
    }

    private close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
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
        } catch (e) {
            console.warn('[welcome] set_library_root failed:', e);
        }
    }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}

export const welcomeModal = new WelcomeModal();
(window as any).welcomeModal = welcomeModal;
