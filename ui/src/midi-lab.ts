/**
 * MIDI Lab — modal UI for converting `.mid` files to Strudel with the
 * full set of `midi-to-strudel` knobs (drum bank, instrument mode, channel
 * filter, compaction, …) and live preview.
 *
 * Wired up:
 *   - File → Import MIDI… menu (replaces the silent dialog flow)
 *   - Editor panel header "MIDI" button
 *   - File Explorer toolbar MIDI button
 *   - Default drag-drop of `.mid` files
 *
 * The fast/silent path lives in `fileManager.importMidiPath(path)` and is
 * still reachable via Shift+drag-drop (see drag-drop.ts).
 */

import {invoke, isTauri} from './tauri.js';
import {escapeHtml} from './html.js';
import {dismissibleModal} from './modal-utils.js';
import {fileManager} from './file-manager.js';
import {errorDialog, openPathDialog} from './dialog.js';
import type {
    ImportMidiOptions,
    MidiImport,
    MidiMetadata,
    MidiTrackInfo,
} from './types/tauri-commands.js';


const MIDI_FILTER = {name: 'MIDI File', extensions: ['mid', 'midi']};

export class MidiLab {
    private root: HTMLElement | null = null;
    private trackListEl: HTMLElement | null = null;
    private previewEl: HTMLPreElement | null = null;
    private previewHint: HTMLElement | null = null;
    private fileNameEl: HTMLElement | null = null;
    private metaEl: HTMLElement | null = null;

    private currentPath: string | null = null;
    private meta: MidiMetadata | null = null;
    private excluded: Set<number> = new Set();

    private inited = false;
    private cleanup: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('midiLab');
        this.trackListEl = document.getElementById('midiLabTrackList');
        this.previewEl = document.getElementById('midiLabPreview') as HTMLPreElement | null;
        this.previewHint = document.getElementById('midiLabPreviewHint');
        this.fileNameEl = document.getElementById('midiLabFileName');
        this.metaEl = document.getElementById('midiLabMeta');
        if (!this.root) return;

        const $ = (id: string) => document.getElementById(id);
        // Backdrop click, the [data-dismiss] Close/Cancel buttons, and Esc are
        // all handled by dismissibleModal() (wired in show()).
        $('midiLabBrowse')?.addEventListener('click', () => void this.browse());
        $('midiLabPreviewBtn')?.addEventListener('click', () => void this.previewConversion());
        $('midiLabOpen')?.addEventListener('click', () => void this.openInEditor());
        $('midiLabSave')?.addEventListener('click', () => void this.saveToLibrary());

        const autoRes = $('midiLabAutoRes') as HTMLInputElement | null;
        const notesPerBar = $('midiLabNotesPerBar') as HTMLInputElement | null;
        autoRes?.addEventListener('change', () => {
            if (notesPerBar) notesPerBar.disabled = !!autoRes.checked;
        });

        this.inited = true;
        this.updateButtonState();
    }

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    async openEmpty(): Promise<void> {
        this.init();
        this.reset();
        this.show();
    }

    async openWithFile(path: string): Promise<void> {
        this.init();
        this.reset();
        this.show();
        await this.loadFile(path);
    }

    // ------------------------------------------------------------------
    // Open/close
    // ------------------------------------------------------------------

    private show(): void {
        if (!this.root) return;
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    private close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private reset(): void {
        this.currentPath = null;
        this.meta = null;
        this.excluded.clear();
        if (this.fileNameEl) this.fileNameEl.textContent = 'no file';
        if (this.metaEl) this.metaEl.textContent = '';
        if (this.trackListEl) {
            this.trackListEl.innerHTML = '<div class="midi-lab-track-empty">Select a .mid file to inspect tracks.</div>';
        }
        if (this.previewEl) this.previewEl.textContent = '';
        if (this.previewHint) {
            this.previewHint.innerHTML = 'Click <em>Preview</em> to generate.';
        }
        this.updateButtonState();
    }

    // ------------------------------------------------------------------
    // File pick / load
    // ------------------------------------------------------------------

    private async browse(): Promise<void> {
        if (!isTauri) return;
        const path = await openPathDialog({
            directory: false,
            filters: [MIDI_FILTER],
        });
        if (!path) return;
        await this.loadFile(path);
    }

    private async loadFile(path: string): Promise<void> {
        this.currentPath = path;
        if (this.fileNameEl) this.fileNameEl.textContent = basename(path);
        if (this.metaEl) this.metaEl.textContent = 'inspecting…';
        if (this.trackListEl) {
            this.trackListEl.innerHTML = '<div class="midi-lab-track-empty">Inspecting…</div>';
        }
        try {
            const meta = await invoke<MidiMetadata>('inspect_midi', {path});
            this.meta = meta;
            this.excluded.clear();
            this.renderMeta();
            this.renderTracks();
            this.updateButtonState();
        } catch (e: any) {
            this.meta = null;
            if (this.metaEl) this.metaEl.textContent = 'inspect failed';
            if (this.trackListEl) {
                this.trackListEl.innerHTML = `<div class="midi-lab-track-empty">Could not inspect:<br>${escapeHtml(String(e))}</div>`;
            }
            this.updateButtonState();
        }
    }

    private renderMeta(): void {
        if (!this.metaEl || !this.meta) return;
        const bpm = Math.round(this.meta.bpm);
        const tracks = this.meta.tracks.length;
        this.metaEl.textContent = `bpm ${bpm} · tracks ${tracks}`;
    }

    private renderTracks(): void {
        if (!this.trackListEl || !this.meta) return;
        if (this.meta.tracks.length === 0) {
            this.trackListEl.innerHTML = '<div class="midi-lab-track-empty">No tracks detected.</div>';
            return;
        }
        this.trackListEl.innerHTML = '';
        for (const track of this.meta.tracks) {
            this.trackListEl.appendChild(this.makeTrackRow(track));
        }
    }

    private makeTrackRow(track: MidiTrackInfo): HTMLElement {
        const row = document.createElement('label');
        row.className = 'midi-lab-track-row';
        if (track.is_drum) row.classList.add('is-drum');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = track.channel === null || !this.excluded.has(track.channel);
        cb.addEventListener('change', () => {
            if (track.channel === null) return;
            if (cb.checked) this.excluded.delete(track.channel);
            else this.excluded.add(track.channel);
            row.classList.toggle('disabled', !cb.checked);
        });
        row.appendChild(cb);

        const channel = document.createElement('span');
        channel.className = 'midi-lab-track-channel';
        channel.textContent = track.channel === null ? '—' : String(track.channel);
        row.appendChild(channel);

        const name = document.createElement('span');
        name.className = 'midi-lab-track-name';
        const label = track.name?.trim() ||
            (track.is_drum ? 'drum kit' : track.program != null ? `program ${track.program}` : 'track');
        name.textContent = label;
        if (track.is_drum) {
            const drum = document.createElement('span');
            drum.className = 'midi-lab-track-drum';
            drum.textContent = ' ★';
            name.appendChild(drum);
        }
        row.appendChild(name);

        const count = document.createElement('span');
        count.className = 'midi-lab-track-count';
        count.textContent = `${track.note_count}n`;
        row.appendChild(count);

        return row;
    }

    // ------------------------------------------------------------------
    // Conversion actions
    // ------------------------------------------------------------------

    private currentOptions(): ImportMidiOptions {
        const sel = (id: string) => (document.getElementById(id) as HTMLSelectElement | null)?.value;
        const chk = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked;
        const num = (id: string) => {
            const el = document.getElementById(id) as HTMLInputElement | null;
            if (!el) return undefined;
            const v = parseInt(el.value, 10);
            return Number.isFinite(v) ? v : undefined;
        };
        const opts: ImportMidiOptions = {
            drumBank: (sel('midiLabDrumBank') as ImportMidiOptions['drumBank']) ?? undefined,
            instrumentMode: (sel('midiLabInstrument') as ImportMidiOptions['instrumentMode']) ?? undefined,
            autoResolution: chk('midiLabAutoRes'),
            notesPerBar: num('midiLabNotesPerBar'),
            barLimit: num('midiLabBarLimit'),
            compact: chk('midiLabCompact'),
            compose: chk('midiLabCompose'),
            sectionNaming: (sel('midiLabSectionNaming') as ImportMidiOptions['sectionNaming']) ?? undefined,
            detectDrumNames: chk('midiLabDetectDrums'),
        };
        // Build included channels from the meta + excluded set.
        if (this.meta && this.excluded.size > 0) {
            opts.includedChannels = this.meta.tracks
                .map(t => t.channel)
                .filter((c): c is number => c !== null && !this.excluded.has(c));
            // Deduplicate.
            opts.includedChannels = [...new Set(opts.includedChannels)];
        }
        return opts;
    }

    private async previewConversion(): Promise<void> {
        if (!this.currentPath) return;
        if (this.previewHint) this.previewHint.textContent = 'Converting…';
        try {
            const result = await invoke<MidiImport>('import_midi', {
                path: this.currentPath,
                options: this.currentOptions(),
            });
            if (this.previewEl) this.previewEl.textContent = result.code;
            if (this.previewHint) {
                this.previewHint.textContent = `${Math.round(result.bpm)} bpm · ${result.code.split('\n').length} lines`;
            }
        } catch (e: any) {
            if (this.previewEl) this.previewEl.textContent = '';
            if (this.previewHint) {
                this.previewHint.textContent = `Conversion failed: ${e}`;
            }
        }
    }

    private async openInEditor(): Promise<void> {
        if (!this.currentPath) return;
        // Use the existing file-manager pathway so dirty/BPM/autoplay land
        // exactly as they do for the silent path.
        await fileManager.importMidiPath(this.currentPath, this.currentOptions());
        this.close();
    }

    private async saveToLibrary(): Promise<void> {
        if (!this.currentPath) return;
        const fileName = deriveFileName(this.currentPath);
        try {
            const writtenPath = await invoke<string>('save_midi_to_library', {
                path: this.currentPath,
                options: this.currentOptions(),
                fileName,
            });
            await fileManager.openPath(writtenPath);
            this.close();
        } catch (e: any) {
            await errorDialog(`Could not save:\n${e}`);
        }
    }

    private updateButtonState(): void {
        const ready = !!this.currentPath;
        for (const id of ['midiLabPreviewBtn', 'midiLabOpen', 'midiLabSave']) {
            const btn = document.getElementById(id) as HTMLButtonElement | null;
            if (btn) btn.disabled = !ready;
        }
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function deriveFileName(path: string): string {
    const stem = basename(path).replace(/\.(mid|midi)$/i, '');
    return `${stem}.strudel`;
}

export const midiLab = new MidiLab();
window.midiLab = midiLab;
