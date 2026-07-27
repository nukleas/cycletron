/**
 * About modal — shows app metadata fetched from the Rust `get_app_info`
 * command. Triggered by Help → About and the `ui:about` custom event.
 */

import {invoke} from './tauri.js';
import type {AppInfo} from './types/tauri-commands.js';
import {dismissibleModal} from './modal-utils.js';
import {openExternal} from './external-link.js';
import {helpModal} from './help-modal.js';

const isTauri = !!(window as any).__TAURI__;

export class AboutModal {
    private root: HTMLElement | null = null;
    private versionEl: HTMLElement | null = null;
    private identifierEl: HTMLElement | null = null;
    private tauriEl: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('aboutModal');
        if (!this.root) return;
        this.versionEl = document.getElementById('aboutVersion');
        this.identifierEl = document.getElementById('aboutIdentifier');
        this.tauriEl = document.getElementById('aboutTauri');

        document.getElementById('aboutGuideBtn')?.addEventListener('click', () => {
            this.close();
            helpModal.open('guide');
        });
        document.getElementById('aboutDialectBtn')?.addEventListener('click', () => {
            this.close();
            helpModal.open('dialect');
        });
        document.getElementById('aboutDocsBtn')?.addEventListener('click', () => {
            void openExternal('https://strudel.cc/learn/');
        });
        document.getElementById('aboutCheckUpdates')?.addEventListener('click', () => {
            this.close();
            document.dispatchEvent(new CustomEvent('updater:check'));
        });
        this.inited = true;
    }

    async open(): Promise<void> {
        this.init();
        if (!this.root) return;
        await this.populate();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async populate(): Promise<void> {
        if (!isTauri) {
            this.set(this.versionEl, 'dev');
            this.set(this.identifierEl, 'browser');
            this.set(this.tauriEl, '—');
            return;
        }
        try {
            const info = await invoke<AppInfo>('get_app_info');
            this.set(this.versionEl, info.version);
            this.set(this.identifierEl, info.identifier);
            this.set(this.tauriEl, info.tauri_version);
        } catch (e) {
            console.warn('[about] get_app_info failed:', e);
        }
    }

    private set(el: HTMLElement | null, text: string): void {
        if (el) el.textContent = text;
    }
}

export const aboutModal = new AboutModal();
(window as any).aboutModal = aboutModal;
