/**
 * Samples manager — the one place for managing where sounds come from:
 *
 *   1. **Sample set** — the base sound world. A registry of manifest-backed
 *      sets (bundled Cycletron, downloadable strudel-rs, user-defined in
 *      sample-sets.json). The active set drives BOTH live playback and
 *      export; switching reloads the audio engine immediately.
 *   2. **Packs** — optional local packs under {library}/Packs/ that add
 *      banks on top of whatever set is active.
 *
 * Browsing what's playable stays in the Sounds sidebar panel; the command
 * palette's "Sample Set: …" entries are quick-switch shortcuts into the
 * same flows.
 */

import {invoke, isTauri, listen} from './tauri.js';
import {dismissibleModal} from './modal-utils.js';
import {escapeHtml} from './html.js';
import {notify} from './notifications.js';
import {errorDialog, openPathDialog} from './dialog.js';
import type {SampleSetStatus, SampleSetProgress, UserSettings} from './types/tauri-commands.js';

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

/** Switch the active sample set and reload the audio stack with it. */
export async function switchSampleSet(setId: string): Promise<void> {
    const settings = await invoke<UserSettings>('get_user_settings');
    if (settings.samples?.active === setId) return;
    settings.samples = {active: setId};
    await invoke<void>('set_user_settings', {settings});
    await window.strudelApp?.reloadSampleSet?.();
    document.dispatchEvent(new CustomEvent('sounds:changed'));
}

export class SamplesModal {
    private root: HTMLElement | null = null;
    private setListEl: HTMLElement | null = null;
    private setProgressEl: HTMLProgressElement | null = null;
    private packsListEl: HTMLElement | null = null;
    private packsEmptyEl: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('samplesModal');
        if (!this.root) return;
        this.setListEl = document.getElementById('samplesSetList');
        this.setProgressEl = document.getElementById('samplesSetProgress') as HTMLProgressElement;
        this.packsListEl = document.getElementById('packsList');
        this.packsEmptyEl = document.getElementById('packsEmpty');

        document.getElementById('packsOpenFolder')?.addEventListener('click', () => {
            void this.openFolder();
        });
        document.getElementById('packsReload')?.addEventListener('click', () => {
            void this.reloadEnabled();
        });
        document.getElementById('packsInstall')?.addEventListener('click', () => {
            void this.installFromFolder();
        });

        if (isTauri) {
            void listen<SampleSetProgress>('sample-set-progress', (event) => {
                const p = event.payload;
                if (this.setProgressEl) {
                    this.setProgressEl.hidden = false;
                    this.setProgressEl.max = p.total;
                    this.setProgressEl.value = p.done;
                }
                const status = document.getElementById(`samplesSetStatus-${p.set}`);
                if (status) status.textContent = `Downloading ${p.source}… ${p.done}/${p.total}`;
            });
        }
        this.inited = true;
    }

    async open(): Promise<void> {
        this.init();
        if (!this.root) return;
        await Promise.all([this.refreshSets(), this.refreshPacks()]);
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    // -- Sample sets ---------------------------------------------------------

    /** Render the sample-set registry as a radio list with per-set
     *  download/delete controls. A set is only selectable once it's on disk
     *  (the backend enforces the same rule in `set_user_settings`); picking
     *  a radio switches immediately and reloads the audio engine. */
    private async refreshSets(): Promise<void> {
        const container = this.setListEl;
        if (!isTauri || !container) return;
        let sets: SampleSetStatus[];
        let active = 'cycletron';
        try {
            const settings = await invoke<UserSettings>('get_user_settings');
            active = settings.samples?.active ?? 'cycletron';
            sets = await invoke<SampleSetStatus[]>('list_sample_sets');
        } catch (e) {
            console.warn('[samples] list_sample_sets failed:', e);
            return;
        }
        if (this.setProgressEl) this.setProgressEl.hidden = true;

        container.replaceChildren();
        for (const set of sets) {
            const row = document.createElement('div');
            row.className = 'prefs-row';

            const label = document.createElement('label');
            label.className = 'prefs-check';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'samplesSet';
            radio.value = set.id;
            radio.checked = set.id === active;
            radio.disabled = !set.ready;
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                void switchSampleSet(set.id)
                    .then(() => this.refreshSets())
                    .catch(async (e) => {
                        await errorDialog(`Could not switch sample set:\n${e}`);
                        await this.refreshSets();
                    });
            });
            const text = document.createElement('span');
            text.textContent = set.label;
            label.append(radio, text);

            const status = document.createElement('span');
            status.className = 'prefs-hint';
            status.id = `samplesSetStatus-${set.id}`;
            status.textContent = set.id === 'cycletron'
                ? 'built in'
                : set.ready
                    ? `downloaded (${(set.bytes / (1024 * 1024)).toFixed(0)} MB)`
                    : 'not downloaded';

            row.append(label, status);

            if (set.id !== 'cycletron') {
                if (!set.ready) {
                    const download = document.createElement('button');
                    download.className = 'prefs-inline-btn';
                    download.type = 'button';
                    download.textContent = 'Download';
                    download.addEventListener('click', () => void this.downloadSet(set.id, download));
                    row.append(download);
                } else {
                    const remove = document.createElement('button');
                    remove.className = 'prefs-inline-btn';
                    remove.type = 'button';
                    remove.textContent = 'Delete';
                    remove.addEventListener('click', () => void this.removeSet(set.id));
                    row.append(remove);
                }
            }
            container.appendChild(row);
            if (set.description) {
                const blurb = document.createElement('div');
                blurb.className = 'prefs-note samples-set-blurb';
                blurb.textContent = set.description;
                container.appendChild(blurb);
            }
        }
    }

    private async downloadSet(setId: string, button: HTMLButtonElement): Promise<void> {
        if (!isTauri) return;
        button.disabled = true;
        try {
            await invoke<SampleSetStatus[]>('download_sample_set', {setId});
        } catch (e: any) {
            await errorDialog(`Sample set download failed:\n${e}\n\nRun it again to resume — finished files are kept.`);
        } finally {
            await this.refreshSets();
        }
    }

    private async removeSet(setId: string): Promise<void> {
        if (!isTauri) return;
        try {
            await invoke<void>('remove_sample_set', {setId});
        } catch (e: any) {
            await errorDialog(`Could not delete the sample set:\n${e}`);
        }
        await this.refreshSets();
    }

    // -- Packs ---------------------------------------------------------------

    private async refreshPacks(): Promise<void> {
        if (!this.packsListEl || !this.packsEmptyEl) return;
        if (!isTauri) {
            this.packsListEl.innerHTML = '';
            this.packsEmptyEl.hidden = false;
            this.packsEmptyEl.textContent = 'Sample packs are only available in the desktop app.';
            return;
        }
        try {
            const packs = await invoke<PackSummary[]>('list_packs');
            if (!packs.length) {
                this.packsListEl.innerHTML = '';
                this.packsEmptyEl.hidden = false;
                this.packsEmptyEl.textContent =
                    'No packs installed. Use Install from Folder… or place a pack under Packs/ (see docs/SAMPLE_PACKS.md).';
                return;
            }
            this.packsEmptyEl.hidden = true;
            this.packsListEl.innerHTML = packs
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

            this.packsListEl.querySelectorAll<HTMLInputElement>('input[data-pack-id]').forEach((el) => {
                el.addEventListener('change', () => {
                    const id = el.dataset.packId;
                    if (!id) return;
                    void this.toggle(id, el.checked, el);
                });
            });
        } catch (e) {
            this.packsListEl.innerHTML = '';
            this.packsEmptyEl.hidden = false;
            this.packsEmptyEl.textContent = String(e);
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
                    console.warn('[samples] skipped core collisions:', result.skipped);
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
            await errorDialog(`Could not ${enable ? 'enable' : 'disable'} the pack:\n${e}`);
        }
    }

    private async openFolder(): Promise<void> {
        if (!isTauri) return;
        try {
            const dir = await invoke<string>('packs_dir');
            await invoke('reveal_in_os', {path: dir});
        } catch (e) {
            await errorDialog(`Could not open the Packs folder:\n${e}`);
        }
    }

    /** Copy a Strudel-style sample folder into Packs/ and enable it. */
    async installFromFolder(): Promise<void> {
        this.init();
        if (!isTauri) return;
        try {
            const dir = await openPathDialog({
                directory: true,
                title: 'Choose a sample folder to install as a pack',
            });
            if (!dir) return;

            void notify('Installing pack…', 'Copying samples into your library');
            const result = await invoke<{
                id: string;
                name: string;
                banks: string[];
                renamed: Array<{from: string; to: string}>;
                file_count: number;
                load: {banks: Array<{name: string; files: string[]}>; skipped: string[]} | null;
            }>('install_pack_from_folder', {
                path: dir,
                id: null,
                name: null,
                enable: true,
            });

            let loaded = 0;
            if (result.load?.banks?.length) {
                loaded = (await window.strudelApp?.loadPackBanks?.(result.load.banks)) ?? 0;
            }

            const renameNote = result.renamed?.length
                ? ` Renamed ${result.renamed.length} bank(s) that collide with the core kit.`
                : '';
            void notify(
                'Pack installed',
                `${result.id}: ${result.file_count} files, ${result.banks.length} banks, ${loaded} loaded.${renameNote}`,
            );
            await this.refreshPacks();
            document.dispatchEvent(new CustomEvent('sounds:changed'));
        } catch (e) {
            await errorDialog(`Install failed:\n${e}`);
        }
    }

    private async reloadEnabled(): Promise<void> {
        try {
            const n = await window.strudelApp?.loadEnabledPacks?.();
            void notify('Packs reloaded', `${n ?? 0} samples from enabled packs`);
            await this.refreshPacks();
            document.dispatchEvent(new CustomEvent('sounds:changed'));
        } catch (e) {
            await errorDialog(`Reload failed:\n${e}`);
        }
    }
}

export const samplesModal = new SamplesModal();
