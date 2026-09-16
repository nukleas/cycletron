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
import {packImport} from './pack-import.js';
import {openExternal} from './external-link.js';
import {FREE_SAMPLE_SOURCES} from './sample-sources.js';
import {errorDialog} from './dialog.js';
import type {SampleSetStatus, SampleSetProgress, UserSettings} from './types/tauri-commands.js';

interface PackBankSummary {
    name: string;
    files: string[];
}

interface PackSummary {
    id: string;
    name: string;
    version: string;
    spdx: string;
    description: string;
    tags: string[];
    banks: PackBankSummary[];
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
    private packsListEl: HTMLElement | null = null;
    private packsEmptyEl: HTMLElement | null = null;
    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('samplesModal');
        if (!this.root) return;
        this.setListEl = document.getElementById('samplesSetList');
        this.packsListEl = document.getElementById('packsList');
        this.packsEmptyEl = document.getElementById('packsEmpty');

        document.getElementById('packsOpenFolder')?.addEventListener('click', () => {
            void this.openFolder();
        });
        document.getElementById('packsImportFolder')?.addEventListener('click', () => {
            void packImport.openFolderPicker();
        });
        document.getElementById('packsImportZip')?.addEventListener('click', () => {
            void packImport.openZipPicker();
        });

        this.renderSources();

        if (isTauri) {
            void listen<SampleSetProgress>('sample-set-progress', (event) => {
                const p = event.payload;
                // Drive the downloading set's own bar: a single shared bar left
                // the user guessing which set it belonged to.
                const bar = document.getElementById(`samplesSetBar-${p.set}`);
                const fill = bar?.firstElementChild as HTMLElement | undefined;
                if (bar && fill) {
                    bar.hidden = false;
                    const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                    fill.style.width = `${pct}%`;
                }
                const status = document.getElementById(`samplesSetStatus-${p.set}`);
                if (status) status.textContent = `Downloading ${p.source}… ${p.done}/${p.total}`;
            });
        }
        this.inited = true;
    }

    /** Static link list — Cycletron points at these, it does not ship them. */
    private renderSources(): void {
        const el = document.getElementById('samplesSources');
        if (!el) return;
        el.innerHTML = FREE_SAMPLE_SOURCES.map((src) => `
            <li class="snd-source-card">
                <button type="button" class="snd-source-open" data-url="${escapeHtml(src.url)}">
                    ${escapeHtml(src.name)} &#8599;
                </button>
                <span class="snd-source-blurb">${escapeHtml(src.blurb)}</span>
                <span class="snd-source-license">${escapeHtml(src.license)}</span>
                <span class="snd-source-format">${escapeHtml(src.format)}</span>
            </li>`).join('');
        el.addEventListener('click', (e) => {
            const btn = (e.target as Element).closest('.snd-source-open') as HTMLElement | null;
            if (btn?.dataset.url) void openExternal(btn.dataset.url);
        });
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

    /**
     * Render the sample-set registry.
     *
     * The state of each set has to be unmissable: a set that is not on disk
     * cannot be activated (the backend enforces the same rule in
     * `set_user_settings`), and the previous rendering said so in dim grey next
     * to a silently-disabled radio — so a set that needed one click to fetch
     * read as a set that was simply empty. Each row now carries an explicit
     * state chip, and clicking the row does the obvious thing: activate it if
     * it is ready, download it if it is not.
     */
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
        container.replaceChildren();
        for (const set of sets) {
            container.appendChild(this.setCard(set, active));
        }
    }

    /** One set: state chip, action, description, and its own progress bar. */
    private setCard(set: SampleSetStatus, active: string): HTMLElement {
        const isActive = set.id === active;
        const bundled = set.id === 'cycletron';
        const ready = bundled || set.ready;
        const state = isActive ? 'active' : ready ? 'ready' : 'missing';

        const card = document.createElement('div');
        card.className = 'snd-set';
        card.dataset.state = state;

        const head = document.createElement('div');
        head.className = 'snd-set-head';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'samplesSet';
        radio.className = 'snd-set-radio';
        radio.value = set.id;
        radio.checked = isActive;
        radio.disabled = !ready;
        radio.tabIndex = -1;
        radio.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'snd-set-label';
        label.textContent = set.label;

        const chip = document.createElement('span');
        chip.className = 'snd-set-chip';
        chip.textContent = isActive
            ? 'active'
            : bundled
                ? 'built in'
                : set.ready
                    ? `downloaded · ${(set.bytes / (1024 * 1024)).toFixed(0)} MB`
                    : 'not downloaded';

        head.append(radio, label, chip);

        // The whole card is the control: click what you want and it either
        // activates or fetches. A disabled radio explains nothing on its own.
        const action = document.createElement('button');
        action.className = 'snd-set-action';
        action.type = 'button';
        if (bundled) {
            action.textContent = isActive ? 'In use' : 'Use';
            action.disabled = isActive;
        } else if (!set.ready) {
            action.textContent = `Download · ${set.sources.length} source${set.sources.length === 1 ? '' : 's'}`;
        } else {
            action.textContent = isActive ? 'In use' : 'Use';
            action.disabled = isActive;
        }
        head.append(action);
        card.append(head);

        if (set.description) {
            const desc = document.createElement('p');
            desc.className = 'snd-set-desc';
            desc.textContent = set.description;
            card.append(desc);
        }

        // Per-set progress, so "which one is downloading" is never a guess.
        const bar = document.createElement('div');
        bar.className = 'snd-progress';
        bar.id = `samplesSetBar-${set.id}`;
        bar.hidden = true;
        bar.innerHTML = '<div class="snd-progress-fill"></div>';
        const status = document.createElement('span');
        status.className = 'snd-set-status';
        status.id = `samplesSetStatus-${set.id}`;
        if (!ready) status.textContent = 'Download it to make it selectable.';
        card.append(bar, status);

        const activate = (): void => {
            if (isActive) return;
            void switchSampleSet(set.id)
                .then(() => this.refreshSets())
                .catch(async (e) => {
                    await errorDialog(`Could not switch sample set:\n${e}`);
                    await this.refreshSets();
                });
        };

        const onPick = (e: Event): void => {
            if ((e.target as Element).closest('.snd-set-remove')) return;
            if (ready) activate();
            else void this.downloadSet(set.id, action);
        };
        head.addEventListener('click', onPick);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(e);
            }
        });
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-pressed', String(isActive));

        if (!bundled && set.ready) {
            const remove = document.createElement('button');
            remove.className = 'prefs-inline-btn snd-set-remove';
            remove.type = 'button';
            remove.textContent = 'Delete';
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.removeSet(set.id);
            });
            head.append(remove);
        }

        return card;
    }

    private async downloadSet(setId: string, button: HTMLButtonElement): Promise<void> {
        if (!isTauri) return;
        button.disabled = true;
        button.textContent = 'Downloading…';
        const status = document.getElementById(`samplesSetStatus-${setId}`);
        if (status) status.textContent = 'Starting…';
        try {
            await invoke<SampleSetStatus[]>('download_sample_set', {setId});
            // A set is downloaded in order to be used; say it is ready to go
            // rather than leaving the user to work out what changed.
            void notify('Sample set ready', `${setId} is downloaded — select it to switch.`);
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
                    const samples = p.banks.reduce((n, b) => n + b.files.length, 0);
                    const names = p.banks.map((b) => escapeHtml(b.name)).join(', ');
                    const banks = p.banks.length
                        ? `${p.banks.length} banks · ${samples} samples — ${names}`
                        : '';
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

}

export const samplesModal = new SamplesModal();
