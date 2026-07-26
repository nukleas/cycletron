/**
 * Version History modal — lists `Snapshot`s saved by the backend on every
 * save, lets the user preview their contents and restore one into the
 * editor (the restored content is loaded via the editor's existing
 * `replaceCodeAndPlay`, so playback continues seamlessly).
 */

import {invoke} from './tauri.js';
import {fileManager} from './file-manager.js';
import {dismissibleModal} from './modal-utils.js';
import type {Snapshot} from './types/tauri-commands.js';

const isTauri = !!(window as any).__TAURI__;

class HistoryModal {
    private root: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private previewEl: HTMLPreElement | null = null;
    private restoreBtn: HTMLButtonElement | null = null;

    private snapshots: Snapshot[] = [];
    private activeIdx = -1;
    private currentPath: string | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('historyModal');
        if (!this.root) return;
        this.listEl = document.getElementById('historyList');
        this.previewEl = document.getElementById('historyPreview') as HTMLPreElement | null;
        this.restoreBtn = document.getElementById('historyRestore') as HTMLButtonElement | null;

        this.listEl?.addEventListener('click', (e) => {
            const row = (e.target as Element).closest('[data-idx]') as HTMLElement | null;
            if (!row) return;
            const idx = parseInt(row.dataset.idx ?? '-1', 10);
            void this.select(idx);
        });
        this.restoreBtn?.addEventListener('click', () => void this.restoreSelected());
        this.inited = true;
    }

    async open(): Promise<void> {
        this.init();
        if (!this.root) return;
        this.currentPath = fileManager.filePath;
        if (!this.currentPath) {
            await this.warn('Save this file first so snapshots can accumulate.');
            return;
        }
        if (!isTauri) return;

        try {
            this.snapshots = await invoke<Snapshot[]>('list_snapshots', {path: this.currentPath});
        } catch (e) {
            console.warn('[history] list_snapshots failed:', e);
            this.snapshots = [];
        }
        this.activeIdx = -1;
        if (this.previewEl) this.previewEl.textContent = '';
        if (this.restoreBtn) this.restoreBtn.disabled = true;
        this.renderList();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());

        // Auto-select the most recent so the modal is useful on a click.
        if (this.snapshots.length > 0) void this.select(0);
    }

    private close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private renderList(): void {
        if (!this.listEl) return;
        if (this.snapshots.length === 0) {
            this.listEl.innerHTML = '<div class="history-empty">No snapshots yet. Save the file to start a history.</div>';
            return;
        }
        this.listEl.innerHTML = this.snapshots.map((s, idx) => {
            const date = new Date(s.created_at_ms);
            return `
                <div class="history-row ${idx === this.activeIdx ? 'active' : ''}" data-idx="${idx}">
                    <span class="history-row-time">${formatDate(date)}</span>
                    <span class="history-row-size">${formatSize(s.size)}</span>
                </div>
            `;
        }).join('');
    }

    private async select(idx: number): Promise<void> {
        const snap = this.snapshots[idx];
        if (!snap || !this.currentPath) return;
        this.activeIdx = idx;
        this.renderList();
        if (this.restoreBtn) this.restoreBtn.disabled = false;
        try {
            const code = await invoke<string>('read_snapshot', {
                path: this.currentPath,
                snapshotId: snap.id,
            });
            if (this.previewEl) this.previewEl.textContent = code;
        } catch (e) {
            if (this.previewEl) this.previewEl.textContent = `Could not read snapshot: ${e}`;
        }
    }

    private async restoreSelected(): Promise<void> {
        const snap = this.snapshots[this.activeIdx];
        if (!snap || !this.currentPath) return;
        try {
            const code = await invoke<string>('read_snapshot', {
                path: this.currentPath,
                snapshotId: snap.id,
            });
            const app = window.strudelApp;
            if (app?.isInitialized) {
                await app.replaceCodeAndPlay(code);
            } else {
                app?.editor?.setCode(code);
            }
            // Restoring leaves the buffer dirty until the user saves; that
            // matches Cursor / VS Code behaviour for "Revert from snapshot".
            this.close();
        } catch (e) {
            console.error('[history] restore failed:', e);
            await this.warn(`Could not restore: ${e}`);
        }
    }

    private async warn(message: string): Promise<void> {
        if (!isTauri) { console.warn(message); return; }
        try {
            const {message: dialog} = await import('@tauri-apps/plugin-dialog');
            await dialog(message, {title: 'Cycletron'});
        } catch { /* ignore */ }
    }
}

function formatDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const historyModal = new HistoryModal();
(window as any).historyModal = historyModal;
