/**
 * Sample packs manager — list packs under {library}/Packs/, enable/disable,
 * open the folder in the OS file manager.
 */

import {invoke} from './tauri.js';
import {dismissibleModal} from './modal-utils.js';
import {escapeHtml} from './html.js';
import {notify} from './notifications.js';

const isTauri = !!(window as any).__TAURI__;

interface PackSummary {
    id: string;
    name: string;
    version: string;
    spdx: string;
    description: string;
    tags: string[];
    banks: string[];
    enabled: boolean;
    path: string;
}

export class PacksModal {
    private root: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private emptyEl: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('packsModal');
        if (!this.root) return;
        this.listEl = document.getElementById('packsList');
        this.emptyEl = document.getElementById('packsEmpty');

        document.getElementById('packsOpenFolder')?.addEventListener('click', () => {
            void this.openFolder();
        });
        document.getElementById('packsReload')?.addEventListener('click', () => {
            void this.reloadEnabled();
        });
        this.inited = true;
    }

    async open(): Promise<void> {
        this.init();
        if (!this.root) return;
        await this.refresh();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async refresh(): Promise<void> {
        if (!this.listEl || !this.emptyEl) return;
        if (!isTauri) {
            this.listEl.innerHTML = '';
            this.emptyEl.hidden = false;
            this.emptyEl.textContent = 'Sample packs are only available in the desktop app.';
            return;
        }
        try {
            const packs = await invoke<PackSummary[]>('list_packs');
            if (!packs.length) {
                this.listEl.innerHTML = '';
                this.emptyEl.hidden = false;
                this.emptyEl.textContent =
                    'No packs installed. Put a pack folder under Packs/ in your library (see docs/SAMPLE_PACKS.md).';
                return;
            }
            this.emptyEl.hidden = true;
            this.listEl.innerHTML = packs
                .map((p) => {
                    const banks = p.banks.map((b) => escapeHtml(b)).join(', ');
                    const checked = p.enabled ? 'checked' : '';
                    return `<label class="packs-row">
                        <input type="checkbox" data-pack-id="${escapeHtml(p.id)}" ${checked} />
                        <span class="packs-row-body">
                            <span class="packs-row-title">${escapeHtml(p.name)}
                                <span class="packs-row-meta">${escapeHtml(p.id)} · ${escapeHtml(p.spdx)} · v${escapeHtml(p.version)}</span>
                            </span>
                            <span class="packs-row-banks">${banks || '—'}</span>
                        </span>
                    </label>`;
                })
                .join('');

            this.listEl.querySelectorAll<HTMLInputElement>('input[data-pack-id]').forEach((el) => {
                el.addEventListener('change', () => {
                    const id = el.dataset.packId;
                    if (!id) return;
                    void this.toggle(id, el.checked, el);
                });
            });
        } catch (e) {
            this.listEl.innerHTML = '';
            this.emptyEl.hidden = false;
            this.emptyEl.textContent = String(e);
        }
    }

    private async toggle(id: string, enable: boolean, checkbox: HTMLInputElement): Promise<void> {
        try {
            if (enable) {
                const result = await invoke<{
                    id: string;
                    banks: Array<{name: string; files: string[]}>;
                    skipped: string[];
                }>('enable_pack', {id});
                const n = await window.strudelApp?.loadPackBanks?.(result.banks);
                if (result.skipped.length) {
                    console.warn('[packs] skipped core collisions:', result.skipped);
                }
                void notify('Pack enabled', `${id}: ${n ?? 0} samples`);
            } else {
                await invoke('disable_pack', {id});
                void notify(
                    'Pack disabled',
                    `${id} will not load on next launch. Restart to unload banks.`,
                );
            }
            document.dispatchEvent(new CustomEvent('sounds:changed'));
        } catch (e) {
            checkbox.checked = !enable;
            void notify('Pack error', String(e));
        }
    }

    private async openFolder(): Promise<void> {
        if (!isTauri) return;
        try {
            const dir = await invoke<string>('packs_dir');
            await invoke('reveal_in_os', {path: dir});
        } catch (e) {
            void notify('Could not open Packs folder', String(e));
        }
    }

    private async reloadEnabled(): Promise<void> {
        try {
            const n = await window.strudelApp?.loadEnabledPacks?.();
            void notify('Packs reloaded', `${n ?? 0} samples from enabled packs`);
            await this.refresh();
            document.dispatchEvent(new CustomEvent('sounds:changed'));
        } catch (e) {
            void notify('Reload failed', String(e));
        }
    }
}

export const packsModal = new PacksModal();
