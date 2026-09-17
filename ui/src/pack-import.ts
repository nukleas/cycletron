/**
 * Import review — see the banks before anything is copied.
 *
 * A flat hardware pack is a few hundred files named by type tag, and the
 * difference between a playable kit and a wall of junk bank names is a
 * heuristic. So the backend proposes and this pane lets you check: rename a
 * bank, drop one, reorder or remove a sample, and hear any of it first. The
 * staged files are real files on disk, so `read_audio_file` auditions them
 * exactly as it does an installed pack.
 *
 * Every close path routes through `close()` so the staging directory is always
 * cleaned up — Cancel, Escape, the backdrop and the × alike.
 */

import {invoke, isTauri} from './tauri.js';
import {dismissibleModal} from './modal-utils.js';
import {escapeHtml} from './html.js';
import {notify} from './notifications.js';
import {errorDialog, openPathDialog} from './dialog.js';
import {VirtualList, readRowHeight} from './virtual-list.js';
import {auditionSample, stopAudition} from './audition.js';

interface PreviewFile {
    path: string;
    label: string;
}
interface ProposedBank {
    name: string;
    rawName: string;
    collidesWithCore: boolean;
    files: PreviewFile[];
}
interface PackImportPreview {
    token: string;
    source: string;
    root: string;
    staged: boolean;
    suggestedId: string;
    suggestedName: string;
    strategy: 'leading-tag' | 'trailing-index' | 'single-bank';
    folderShaped: boolean;
    fileCount: number;
    bytes: number;
    overCap: boolean;
    warnings: string[];
    banks: ProposedBank[];
}

/** What each grouping outcome means, in the user's terms. */
const STRATEGY_NOTE: Record<PackImportPreview['strategy'], string> = {
    'leading-tag': 'Banks came from the type tag at the start of each filename.',
    'trailing-index': 'Banks came from filenames with a trailing index.',
    'single-bank': 'Filenames had no consistent prefix, so everything is one indexed bank. Rename or split it below.',
};

/** Editable working copy of a proposed bank. */
interface DraftBank {
    name: string;
    files: PreviewFile[];
    dropped: boolean;
    collides: boolean;
}

export class PackImport {
    private root: HTMLElement | null = null;
    private banksEl: HTMLElement | null = null;
    private filesEl: HTMLElement | null = null;
    private nameEl: HTMLInputElement | null = null;
    private idEl: HTMLInputElement | null = null;
    private statsEl: HTMLElement | null = null;
    private sourceEl: HTMLElement | null = null;
    private warnEl: HTMLElement | null = null;
    private summaryEl: HTMLElement | null = null;
    private commitEl: HTMLButtonElement | null = null;

    private bankList: VirtualList<DraftBank> | null = null;
    private fileList: VirtualList<PreviewFile> | null = null;
    private preview: PackImportPreview | null = null;
    private drafts: DraftBank[] = [];
    private selected = 0;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('packImportModal');
        if (!this.root) return;
        this.banksEl = document.getElementById('siBanks');
        this.filesEl = document.getElementById('siFiles');
        this.nameEl = document.getElementById('siName') as HTMLInputElement | null;
        this.idEl = document.getElementById('siId') as HTMLInputElement | null;
        this.statsEl = document.getElementById('siStats');
        this.sourceEl = document.getElementById('siSource');
        this.warnEl = document.getElementById('siWarnings');
        this.summaryEl = document.getElementById('siSummary');
        this.commitEl = document.getElementById('siCommit') as HTMLButtonElement | null;

        document.getElementById('siCancel')?.addEventListener('click', () => this.close());
        this.commitEl?.addEventListener('click', () => void this.commit());
        this.idEl?.addEventListener('input', () => void this.onIdChanged());
        this.banksEl?.addEventListener('click', (e) => this.onBankClick(e));
        this.banksEl?.addEventListener('input', (e) => this.onBankRename(e));
        this.filesEl?.addEventListener('click', (e) => this.onFileClick(e));
        document.addEventListener('density:changed', () => {
            const h = readRowHeight();
            this.bankList?.setRowHeight(h);
            this.fileList?.setRowHeight(h);
        });
        this.inited = true;
    }

    /** Pick a folder to import. */
    async openFolderPicker(): Promise<void> {
        const dir = await openPathDialog({directory: true, title: 'Choose a sample folder to import'});
        if (dir) await this.openFromPath(dir);
    }

    /** Pick a .zip to import. */
    async openZipPicker(): Promise<void> {
        const zip = await openPathDialog({
            directory: false,
            title: 'Choose a sample pack (.zip)',
            filters: [{name: 'Sample pack', extensions: ['zip']}],
        });
        if (zip) await this.openFromPath(zip);
    }

    /** Entry point for the picker and for a dropped file. */
    async openFromPath(source: string): Promise<void> {
        this.init();
        if (!this.root || !isTauri) return;
        try {
            void notify('Reading samples…', 'Working out the bank layout');
            const preview = await invoke<PackImportPreview>('preview_pack_import', {source, id: null});
            this.show(preview);
        } catch (e) {
            await errorDialog(`Could not read that pack:\n${e}`);
        }
    }

    private show(preview: PackImportPreview): void {
        if (!this.root) return;
        this.preview = preview;
        this.drafts = preview.banks.map((b) => ({
            name: b.name,
            files: b.files.slice(),
            dropped: false,
            collides: b.collidesWithCore,
        }));
        this.selected = 0;

        if (this.nameEl) this.nameEl.value = preview.suggestedName;
        if (this.idEl) this.idEl.value = preview.suggestedId;
        if (this.sourceEl) {
            const note = preview.folderShaped
                ? 'Looks like a Strudel sample folder — banks come from folder names.'
                : STRATEGY_NOTE[preview.strategy];
            this.sourceEl.textContent = `${preview.source} — ${note}`;
        }
        this.renderWarnings(preview.warnings);

        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());

        const rowHeight = readRowHeight();
        if (this.banksEl) {
            this.bankList ??= new VirtualList<DraftBank>({
                viewport: this.banksEl,
                rowHeight,
                renderRow: (b, i) => this.renderBank(b, i),
            });
        }
        if (this.filesEl) {
            this.fileList ??= new VirtualList<PreviewFile>({
                viewport: this.filesEl,
                rowHeight,
                renderRow: (f, i) => this.renderFile(f, i),
            });
        }
        this.refresh();
    }

    close(): void {
        if (!this.root) return;
        stopAudition();
        const token = this.preview?.token;
        const staged = this.preview?.staged;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
        this.preview = null;
        this.drafts = [];
        // Always clean the staging directory up — this is the only path that does.
        if (staged && token) void invoke('cancel_pack_import', {token}).catch(() => {});
    }

    private renderWarnings(warnings: string[]): void {
        if (!this.warnEl) return;
        this.warnEl.hidden = warnings.length === 0;
        this.warnEl.innerHTML = warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    }

    private kept(): DraftBank[] {
        return this.drafts.filter((d) => !d.dropped && d.files.length > 0);
    }

    private refresh(): void {
        this.bankList?.setItems(this.drafts);
        const sel = this.drafts[this.selected];
        this.fileList?.setItems(sel?.files ?? []);

        const kept = this.kept();
        const files = kept.reduce((n, b) => n + b.files.length, 0);
        if (this.statsEl && this.preview) {
            const mb = (this.preview.bytes / (1024 * 1024)).toFixed(0);
            this.statsEl.textContent = `${files} files · ${mb} MB`;
        }
        if (this.summaryEl) this.summaryEl.textContent = this.validationError() ?? `${kept.length} banks`;
        if (this.commitEl) this.commitEl.disabled = this.validationError() !== null;
    }

    /** The single reason Import is unavailable, or null. */
    private validationError(): string | null {
        const id = this.idEl?.value.trim() ?? '';
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return 'Pack id must be lowercase letters, digits, - or _';
        const kept = this.kept();
        if (!kept.length) return 'Every bank has been dropped';
        const names = new Set<string>();
        for (const b of kept) {
            if (!/^[a-z0-9][a-z0-9_]*$/.test(b.name)) return `Bank name “${b.name}” is not usable`;
            if (b.name.length > 31) return `Bank name “${b.name}” is longer than 31 characters`;
            if (names.has(b.name)) return `Two banks are both named “${b.name}”`;
            names.add(b.name);
        }
        if (this.preview?.overCap) return 'Over the import limit — drop some banks';
        return null;
    }

    /** Renaming the pack changes the collision suffixes, so re-ask the backend. */
    private async onIdChanged(): Promise<void> {
        this.refresh();
        const id = this.idEl?.value.trim() ?? '';
        const p = this.preview;
        if (!p || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) return;
        // Only banks the user has not renamed themselves should follow the id.
        try {
            const next = await invoke<PackImportPreview>('preview_pack_import', {
                source: p.staged ? p.root : p.source,
                id,
            });
            next.banks.forEach((b, i) => {
                const draft = this.drafts[i];
                if (draft && draft.name === p.banks[i]?.name) draft.name = b.name;
            });
            this.preview = {...p, suggestedId: id, banks: next.banks};
            this.refresh();
        } catch {
            /* keep the names we have; validation still guards the commit */
        }
    }

    private renderBank(bank: DraftBank, index: number): HTMLElement {
        const el = document.createElement('div');
        el.className = 'snd-row si-bank';
        el.setAttribute('role', 'option');
        el.setAttribute('aria-setsize', String(this.drafts.length));
        el.setAttribute('aria-posinset', String(index + 1));
        el.dataset.idx = String(index);
        if (index === this.selected) el.classList.add('is-selected');
        if (bank.dropped) el.classList.add('is-dropped');
        el.innerHTML =
            `<input class="si-bank-name" type="text" value="${escapeHtml(bank.name)}" maxlength="31" ` +
            `spellcheck="false" aria-label="Bank name">` +
            `<span class="snd-row-meta">${bank.files.length}</span>` +
            (bank.collides ? '<span class="snd-row-tag" data-flag="shadowed">renamed</span>' : '') +
            '<button class="snd-audition" type="button" data-play="1" data-tooltip="Audition">▶</button>' +
            `<button class="si-bank-drop" type="button" data-drop="1" ` +
            `data-tooltip="${bank.dropped ? 'Include this bank' : 'Exclude this bank'}">` +
            `${bank.dropped ? '+' : '×'}</button>`;
        return el;
    }

    private renderFile(file: PreviewFile, index: number): HTMLElement {
        const el = document.createElement('div');
        el.className = 'snd-row si-file';
        el.setAttribute('role', 'listitem');
        el.dataset.idx = String(index);
        el.innerHTML =
            `<span class="snd-row-caret">:${index}</span>` +
            `<span class="snd-row-name">${escapeHtml(file.label)}</span>` +
            '<button class="snd-audition" type="button" data-play="1" data-tooltip="Audition">▶</button>' +
            '<button class="si-file-up" type="button" data-up="1" data-tooltip="Move earlier">↑</button>' +
            '<button class="si-file-drop" type="button" data-drop="1" data-tooltip="Remove">×</button>';
        return el;
    }

    private onBankClick(e: MouseEvent): void {
        const row = (e.target as Element).closest('.si-bank') as HTMLElement | null;
        if (!row?.dataset.idx) return;
        const index = Number(row.dataset.idx);
        const bank = this.drafts[index];
        if (!bank) return;
        const target = e.target as Element;

        if (target.closest('[data-drop]')) {
            bank.dropped = !bank.dropped;
            this.refresh();
            return;
        }
        this.selected = index;
        if (target.closest('[data-play]') && bank.files[0]) {
            void auditionSample({kind: 'path', path: bank.files[0].path, label: bank.files[0].label})
                .catch(() => {});
        }
        this.refresh();
    }

    private onBankRename(e: Event): void {
        const input = e.target as HTMLInputElement;
        if (!input.classList.contains('si-bank-name')) return;
        const row = input.closest('.si-bank') as HTMLElement | null;
        const bank = this.drafts[Number(row?.dataset.idx)];
        if (!bank) return;
        bank.name = input.value.trim().toLowerCase();
        // Don't re-render: that would blur the field mid-edit.
        if (this.summaryEl) this.summaryEl.textContent = this.validationError() ?? `${this.kept().length} banks`;
        if (this.commitEl) this.commitEl.disabled = this.validationError() !== null;
    }

    private onFileClick(e: MouseEvent): void {
        const row = (e.target as Element).closest('.si-file') as HTMLElement | null;
        if (!row?.dataset.idx) return;
        const index = Number(row.dataset.idx);
        const bank = this.drafts[this.selected];
        const file = bank?.files[index];
        if (!bank || !file) return;
        const target = e.target as Element;

        if (target.closest('[data-drop]')) {
            bank.files.splice(index, 1);
            this.refresh();
            return;
        }
        if (target.closest('[data-up]')) {
            if (index > 0) {
                [bank.files[index - 1], bank.files[index]] = [bank.files[index], bank.files[index - 1]];
                this.refresh();
            }
            return;
        }
        void auditionSample({kind: 'path', path: file.path, label: file.label}).catch(() => {});
    }

    private async commit(): Promise<void> {
        const p = this.preview;
        if (!p || this.validationError()) return;
        const banks = this.kept().map((b) => ({name: b.name, files: b.files.map((f) => f.path)}));
        try {
            const result = await invoke<{
                id: string;
                banks: string[];
                renamed: Array<{from: string; to: string}>;
                file_count: number;
                load: {banks: Array<{name: string; files: string[]}>} | null;
            }>('commit_pack_import', {
                request: {
                    token: p.token,
                    source: p.source,
                    root: p.root,
                    id: this.idEl?.value.trim() ?? p.suggestedId,
                    name: this.nameEl?.value.trim() || null,
                    banks,
                    enable: true,
                },
            });
            // The staging directory is gone; don't ask for it to be cancelled.
            this.preview = {...p, staged: false};
            let loaded = 0;
            if (result.load?.banks?.length) {
                loaded = (await window.strudelApp?.loadPackBanks?.(result.load.banks)) ?? 0;
            }
            const renamed = result.renamed?.length
                ? ` Renamed ${result.renamed.length} bank(s) that collide with the core kit.`
                : '';
            void notify(
                'Pack imported',
                `${result.id}: ${result.banks.length} banks, ${result.file_count} files, ${loaded} loaded.${renamed}`,
            );
            this.close();
            document.dispatchEvent(new CustomEvent('sounds:changed'));
        } catch (e) {
            await errorDialog(`Import failed:\n${e}`);
        }
    }
}

export const packImport = new PackImport();
