/**
 * About modal — shows app metadata fetched from the Rust `get_app_info`
 * command. Triggered by Help → About and the palette's "About Cycletron".
 */

import {invoke, isTauri} from './tauri.js';
import {checkForUpdates} from './updater.js';
import type {AppInfo} from './types/tauri-commands.js';
import {dismissibleModal} from './modal-utils.js';
import {openExternal} from './external-link.js';
import {helpModal} from './help-modal.js';


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
            void checkForUpdates(true);
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
            // Don't leave the fields blank — a visible "unknown" tells the user
            // the lookup failed rather than silently showing nothing.
            this.set(this.versionEl, 'unknown');
            this.set(this.identifierEl, 'unknown');
            this.set(this.tauriEl, 'unknown');
        }
    }

    private set(el: HTMLElement | null, text: string): void {
        if (el) el.textContent = text;
    }
}

export const aboutModal = new AboutModal();
window.aboutModal = aboutModal;
