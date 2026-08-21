/**
 * File lifecycle for Cycletron: New / Open / Save / Save As / Recents / Export.
 *
 * Sits between the native dialog plugin and the Tauri file commands.
 * The editor is the authoritative buffer — we pull code from it on save
 * and push code into it on open.
 */

import {invoke, isTauri} from './tauri.js';
import {notify} from './notifications.js';
import {addTask, removeTask} from './dock-badge.js';
import {confirmDialog, errorDialog, infoDialog, openPathDialog, saveFileDialog} from './dialog.js';
import {basename} from './paths.js';
import {currentBpm} from './bpm.js';
import type {
    FileDoc,
    CurrentFile,
    MidiImport,
    ImportMidiOptions,
    ExportAudioResult,
    ExportMidiResult,
} from './types/tauri-commands.js';

const STRUDEL_FILTER = {
    name: 'Strudel Pattern',
    extensions: ['strudel', 'js'],
};

const MIDI_FILTER = {
    name: 'MIDI File',
    extensions: ['mid', 'midi'],
};

const AUDIO_FILTER = {
    name: 'Audio',
    extensions: ['wav', 'mp3'],
};

/** Default export length when the user leaves the bars field alone. */
const DEFAULT_EXPORT_BARS = 16;
const DEFAULT_MIDI_CYCLES = 16;

export class FileManager {
    private currentPath: string | null = null;
    private currentName: string = 'untitled';
    private lastSavedCode: string = '';
    private dirty = false;

    async init(): Promise<void> {
        if (!isTauri) return;
        // Ask backend for current state (may be restored from autosave).
        try {
            const code = this.getEditorCode();
            const info = await invoke<CurrentFile>('get_current_file', {code});
            this.applyCurrentFile(info);
        } catch (e) {
            console.warn('[file-manager] get_current_file failed:', e);
        }
    }

    /** Snapshot the editor at the moment of last save (called after open/save). */
    markSaved(code: string): void {
        this.lastSavedCode = code;
        this.dirty = false;
        this.emitChanged();
    }

    /** Called on every editor change. */
    onEditorChange(code: string): void {
        const dirty = code !== this.lastSavedCode;
        if (dirty !== this.dirty) {
            this.dirty = dirty;
            this.emitChanged();
        }
    }

    get isDirty(): boolean {
        return this.dirty;
    }

    get fileName(): string {
        return this.currentName;
    }

    get filePath(): string | null {
        return this.currentPath;
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    async newFile(): Promise<void> {
        if (!(await this.confirmDiscardIfDirty())) return;
        try {
            await invoke('new_file');
        } catch (e) {
            console.warn('new_file:', e);
        }
        this.setEditorCode('');
        this.currentPath = null;
        this.currentName = 'untitled';
        this.lastSavedCode = '';
        this.dirty = false;
        this.emitChanged();
    }

    async openFile(): Promise<void> {
        if (!isTauri) return;
        const path = await openPathDialog({
            directory: false,
            filters: [STRUDEL_FILTER],
        });
        if (!path) return;
        await this.openPath(path);
    }

    /**
     * Open a file into the editor. Guards unsaved changes with a confirm —
     * every entry point (dialog, tree, drag-drop, recents, Finder) funnels
     * through here, so none can silently discard work. `force` skips the
     * guard for flows that already confirmed (external-change reload).
     */
    async openPath(path: string, opts?: {force?: boolean}): Promise<void> {
        if (!opts?.force && !(await this.confirmDiscardIfDirty())) return;
        try {
            const doc = await invoke<FileDoc>('open_file', {path});
            this.setEditorCode(doc.code);
            this.currentPath = doc.path;
            this.currentName = basename(doc.path);
            this.lastSavedCode = doc.code;
            this.dirty = false;
            if (doc.frontmatter?.bpm) {
                window.strudelApp?.applyBpm?.(doc.frontmatter.bpm);
            }
            this.emitChanged();
        } catch (e: any) {
            console.error('[file-manager] open failed:', e);
            await errorDialog(`Could not open file:\n${e}`);
        }
    }

    async saveCurrent(): Promise<boolean> {
        if (!isTauri) return false;
        if (!this.currentPath) {
            return this.saveAs();
        }
        return this.writeTo(this.currentPath);
    }

    async saveAs(): Promise<boolean> {
        if (!isTauri) return false;
        const picked = await saveFileDialog({
            defaultPath: this.currentPath ?? `${this.currentName}.strudel`,
            filters: [STRUDEL_FILTER],
        });
        if (!picked) return false;
        return this.writeTo(picked);
    }

    private async writeTo(path: string): Promise<boolean> {
        const code = this.getEditorCode();
        const bpm = currentBpm();
        try {
            if (path === this.currentPath) {
                await invoke<string>('save_current', {code, bpm});
            } else {
                await invoke<string>('save_as', {path, code, bpm});
            }
            this.currentPath = path;
            this.currentName = basename(path);
            this.lastSavedCode = code;
            this.dirty = false;
            this.emitChanged();
            return true;
        } catch (e: any) {
            console.error('[file-manager] save failed:', e);
            await errorDialog(`Could not save:\n${e}`);
            return false;
        }
    }

    /**
     * Convert a `.mid` file and replace the editor buffer with the result.
     * Guards unsaved changes here (the choke point) so drag-drop and the
     * MIDI Lab's "Open in Editor" can't silently discard work.
     */
    async importMidiPath(path: string, options?: ImportMidiOptions): Promise<void> {
        if (!(await this.confirmDiscardIfDirty())) return;
        try {
            const result = await invoke<MidiImport>('import_midi', {path, options});
            const app = window.strudelApp;
            if (app?.isInitialized) {
                await app.replaceCodeAndPlay(result.code);
            } else {
                app?.editor?.setCode(result.code);
            }
            if (result.bpm > 0) app?.applyBpm?.(result.bpm);

            // The imported code is an unsaved buffer — no backing file yet.
            this.currentPath = null;
            this.currentName = basename(path).replace(/\.(mid|midi)$/i, '.strudel') + ' (imported)';
            this.lastSavedCode = '';
            this.dirty = true;
            this.emitChanged();
        } catch (e: any) {
            console.error('[file-manager] import midi failed:', e);
            await errorDialog(`Could not import MIDI:\n${e}`);
        }
    }

    async getRecents(): Promise<string[]> {
        if (!isTauri) return [];
        try {
            return await invoke<string[]>('get_recents');
        } catch {
            return [];
        }
    }

    /**
     * Offline-render the current editor code to WAV and/or MP3 via
     * strudel-rs OfflineRenderer. Optional multi-track stem split.
     */
    async exportAudio(): Promise<void> {
        if (!isTauri) return;
        const code = this.getEditorCode();
        if (!code.trim()) {
            await errorDialog('Editor is empty — nothing to export.');
            return;
        }

        const bpm = currentBpm();
        const opts = await promptExportAudioOptions(bpm, code);
        if (!opts) return;

        const ext = opts.format === 'mp3' ? 'mp3' : 'wav';
        const path = await saveFileDialog({
            defaultPath: `${this.exportBaseName()}.${ext}`,
            filters: [AUDIO_FILTER],
        });
        if (!path) return;

        addTask('exporting');
        try {
            const result = await invoke<ExportAudioResult>('export_audio', {
                code,
                path,
                durationSecs: opts.durationSecs,
                bpm,
                gain: 0.7,
                format: opts.format,
                stems: opts.stems,
            });
            const secs = result.duration_secs.toFixed(1);
            const primary = result.paths[0] ?? path;
            const stemNote =
                result.stem_paths.length > 0
                    ? ` · ${result.stem_paths.length} stem files`
                    : '';
            void notify(
                'Export complete',
                `${basename(primary)} · ${secs}s${stemNote}`,
            );
            const lines = [
                `Saved ${secs}s at ${result.bpm.toFixed(0)} BPM.`,
                ...result.paths.map((p) => `• ${p}`),
            ];
            if (result.stem_paths.length > 0) {
                lines.push('', 'Stems:');
                for (const p of result.stem_paths.slice(0, 12)) {
                    lines.push(`• ${p}`);
                }
                if (result.stem_paths.length > 12) {
                    lines.push(`… and ${result.stem_paths.length - 12} more`);
                }
            }
            if (result.notes.length > 0) {
                lines.push('', ...result.notes);
            }
            if (result.clipped_samples > 0) {
                lines.push(
                    '',
                    `Note: ${result.clipped_samples} samples clipped (master was hot).`,
                );
            }
            await infoDialog(lines.join('\n'), 'Export Audio');
        } catch (e: any) {
            console.error('[file-manager] export audio failed:', e);
            await errorDialog(`Could not export audio:\n${e}`);
        } finally {
            removeTask('exporting');
        }
    }

    /**
     * Export the current pattern as a Standard MIDI File (notes + drums).
     */
    async exportMidi(): Promise<void> {
        if (!isTauri) return;
        const code = this.getEditorCode();
        if (!code.trim()) {
            await errorDialog('Editor is empty — nothing to export.');
            return;
        }

        const bpm = currentBpm();
        const opts = await promptExportMidiOptions(bpm, code);
        if (!opts) return;

        const path = await saveFileDialog({
            defaultPath: `${this.exportBaseName()}.mid`,
            filters: [MIDI_FILTER],
        });
        if (!path) return;

        addTask('exporting');
        try {
            const result = await invoke<ExportMidiResult>('export_midi', {
                code,
                path,
                cycles: opts.cycles,
                bpm,
            });
            void notify(
                'MIDI export complete',
                `${basename(result.path)} · ${result.note_count} notes · ${result.cycles} cycles`,
            );
            await infoDialog(
                `Saved ${result.note_count} notes over ${result.cycles} cycles at ${result.bpm.toFixed(0)} BPM.\n${result.path}`,
                'Export MIDI',
            );
        } catch (e: any) {
            console.error('[file-manager] export midi failed:', e);
            await errorDialog(`Could not export MIDI:\n${e}`);
        } finally {
            removeTask('exporting');
        }
    }

    private exportBaseName(): string {
        return this.currentName
            .replace(/\s*\(imported\)\s*$/i, '')
            .replace(/\.(strudel|js|mid|midi|wav|mp3)$/i, '')
            || 'untitled';
    }

    // ------------------------------------------------------------------
    // Restore from autosave
    // ------------------------------------------------------------------

    /** Called on startup — replays the last-saved open file into the editor. */
    applyCurrentFile(info: CurrentFile): void {
        this.currentPath = info.path;
        this.currentName = info.name ?? 'untitled';
        this.dirty = info.dirty;
        this.lastSavedCode = info.dirty ? '' : this.getEditorCode();
        this.emitChanged();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private async confirmDiscardIfDirty(): Promise<boolean> {
        if (!this.dirty) return true;
        if (!isTauri) return true;
        return confirmDialog(
            `"${this.currentName}" has unsaved changes. Discard them?`,
            {kind: 'warning'},
        );
    }

    private getEditorCode(): string {
        return window.strudelApp?.editor?.getCode?.() ?? '';
    }

    private setEditorCode(code: string): void {
        const app = window.strudelApp;
        if (!app?.editor) return;
        // Use replaceCodeAndPlay if audio is live, otherwise just set text.
        if (app.isInitialized && code.trim().length > 0) {
            void app.replaceCodeAndPlay(code);
        } else {
            app.editor.setCode(code);
        }
    }

    private emitChanged(): void {
        document.dispatchEvent(new CustomEvent('file:changed', {
            detail: {
                path: this.currentPath,
                name: this.currentName,
                dirty: this.dirty,
            },
        }));
    }
}

interface ExportAudioOptions {
    durationSecs: number;
    bars: number;
    format: 'wav' | 'mp3' | 'both';
    stems: boolean;
}

interface ExportMidiOptions {
    cycles: number;
}

/** Detected one-playthrough length of a pattern for offline export. Both
 * fields null when no clean length can be calculated. */
interface DetectedLength {
    /** Length in cycles (= bars, 1 cycle = 1 bar at the usual 4/4 mapping). */
    bars: number | null;
    /** Duration in seconds when tempo is known from the code. */
    seconds: number | null;
    /** How length was derived (for the auto-label). */
    kind: 'pickrestart' | 'loop' | 'content_end' | null;
}

/** `mm:ss` from seconds. */
function fmtMinSec(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ask the backend for the pattern's natural export length. Prefers the
 * dedicated long-form detector (MIDI dumps, pickRestart forms); falls back to
 * short-window arrangement analysis. Never throws. */
async function detectLength(code: string): Promise<DetectedLength> {
    try {
        const len = await invoke<{
            cycles: number;
            seconds: number | null;
            kind: 'pick_restart' | 'loop' | 'content_end';
        } | null>('detect_pattern_length', {code, maxCycles: 1024});
        if (len && len.cycles > 0) {
            const kind =
                len.kind === 'pick_restart' ? 'pickrestart'
                : len.kind === 'content_end' ? 'content_end'
                : 'loop';
            return {bars: len.cycles, seconds: len.seconds ?? null, kind};
        }
    } catch (e) {
        console.warn('[file-manager] detect_pattern_length failed:', e);
    }
    // Fallback: short arrangement scan (agent loop-period estimator).
    try {
        const a = await invoke<{
            period_cycles: number | null;
            total_seconds: number | null;
            repeats: boolean;
        }>('analyze_arrangement', {code, maxCycles: 128});
        if (a.repeats && a.period_cycles && a.period_cycles > 0) {
            return {bars: a.period_cycles, seconds: a.total_seconds ?? null, kind: 'loop'};
        }
    } catch (e) {
        console.warn('[file-manager] length detection failed:', e);
    }
    return {bars: null, seconds: null, kind: null};
}

/** Per-caller configuration for the shared export-options modal. */
interface ExportPromptConfig<T> {
    title: string;
    helpHtml: string;
    /** Label for the length field, e.g. 'Bars' or 'Cycles'. */
    fieldLabel: string;
    /** Unit word in the auto/custom radio labels, e.g. 'bars' or 'cycles'. */
    unit: string;
    defaultLength: number;
    parseLength: (raw: string) => number;
    /** Text under the fields; re-rendered whenever the chosen length changes. */
    metaText: (length: number) => string;
    extraFieldsHtml?: string;
    readExtras: (root: HTMLElement) => T;
}

const MAX_EXPORT_LENGTH = 1024;

/**
 * Shared modal skeleton for both export flows: auto/custom length radio
 * (custom field enabled only in custom mode), Escape cancels — swallowing
 * the key so the editor doesn't see it — Enter confirms, and clicking the
 * backdrop dismisses.
 */
async function promptExportOptions<T>(
    bpm: number,
    code: string,
    cfg: ExportPromptConfig<T>,
): Promise<{length: number; extras: T} | null> {
    const detected = await detectLength(code);
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'picker-overlay';
        const autoAvail = detected.bars != null;
        const autoLength = detected.bars ?? cfg.defaultLength;
        const autoSecs = detected.seconds ?? (autoLength * 4 * 60) / bpm;
        const kindHint =
            detected.kind === 'pickrestart' ? 'form'
            : detected.kind === 'content_end' ? 'to end'
            : detected.kind === 'loop' ? 'loop'
            : '';
        const autoLabel = autoAvail
            ? `Full ${kindHint || 'length'} — ${autoLength} ${cfg.unit} ≈ ${fmtMinSec(autoSecs)}`
            : 'Full length (could not detect)';
        overlay.innerHTML = `
            <div class="picker-modal export-modal">
                <div class="picker-header">
                    <span class="picker-title">${cfg.title}</span>
                    <button class="picker-close" type="button" aria-label="Close">&times;</button>
                </div>
                <p class="export-modal-help">${cfg.helpHtml}</p>
                <div class="export-modal-field export-length-modes">
                    <span>Length</span>
                    <div class="export-length-choices">
                        <label><input type="radio" name="lenMode" value="auto" ${autoAvail ? 'checked' : 'disabled'}> ${autoLabel}</label>
                        <label><input type="radio" name="lenMode" value="custom" ${autoAvail ? '' : 'checked'}> Custom ${cfg.unit}</label>
                    </div>
                </div>
                <label class="export-modal-field">
                    <span>${cfg.fieldLabel}</span>
                    <input id="exportLength" type="number" min="1" max="${MAX_EXPORT_LENGTH}" step="1" value="${autoAvail ? autoLength : cfg.defaultLength}" ${autoAvail ? 'disabled' : ''}>
                </label>
                ${cfg.extraFieldsHtml ?? ''}
                <p class="export-modal-meta" id="exportMeta"></p>
                <div class="export-modal-actions">
                    <button type="button" class="export-cancel">Cancel</button>
                    <button type="button" class="export-confirm primary">Export…</button>
                </div>
            </div>
        `;

        const lengthInput = () => overlay.querySelector<HTMLInputElement>('#exportLength')!;
        const meta = () => overlay.querySelector<HTMLElement>('#exportMeta')!;
        const isAuto = () =>
            overlay.querySelector<HTMLInputElement>('input[name="lenMode"][value="auto"]')?.checked ?? false;
        const chosenLength = () =>
            isAuto()
                ? autoLength
                : Math.max(1, Math.min(MAX_EXPORT_LENGTH, cfg.parseLength(lengthInput().value) || cfg.defaultLength));

        const updateMeta = () => {
            meta().textContent = cfg.metaText(chosenLength());
        };

        const onModeChange = () => {
            const auto = isAuto();
            lengthInput().disabled = auto;
            if (auto) lengthInput().value = String(autoLength);
            else lengthInput().focus();
            updateMeta();
        };

        const close = (value: {length: number; extras: T} | null) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        };

        const confirm = () => {
            close({length: chosenLength(), extras: cfg.readExtras(overlay)});
        };

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(null);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                confirm();
            }
        };

        overlay.addEventListener('click', (e) => {
            const t = e.target as HTMLElement;
            if (t === overlay || t.classList.contains('picker-close') || t.classList.contains('export-cancel')) {
                close(null);
            } else if (t.classList.contains('export-confirm')) {
                confirm();
            }
        });
        lengthInput().addEventListener('input', updateMeta);
        overlay.querySelectorAll<HTMLInputElement>('input[name="lenMode"]').forEach((r) =>
            r.addEventListener('change', onModeChange),
        );
        updateMeta();
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => {
            // Focus the length field only when it's the active choice.
            if (!lengthInput().disabled) {
                lengthInput().focus();
                lengthInput().select();
            }
        });
    });
}

/**
 * Modal: length (auto full-loop or custom bars) + format (WAV/MP3/both) + stems.
 * Seconds derived from BPM (4 beats/bar, matching the live recorder). The auto
 * length reuses the loop-period estimator (`analyze_arrangement`).
 */
async function promptExportAudioOptions(
    bpm: number,
    code: string,
): Promise<ExportAudioOptions | null> {
    const result = await promptExportOptions(bpm, code, {
        title: 'Export Audio',
        helpHtml: `
            Offline bake via the Rust DSP engine (faster than realtime).
            MP3 needs <code>ffmpeg</code> on PATH. Stems split
            <code>$:</code> tracks or a top-level <code>stack(...)</code>.
        `,
        fieldLabel: 'Bars',
        unit: 'bars',
        defaultLength: DEFAULT_EXPORT_BARS,
        parseLength: parseFloat,
        metaText: (bars) => `≈ ${((bars * 4 * 60) / bpm).toFixed(1)}s at ${Math.round(bpm)} BPM`,
        extraFieldsHtml: `
            <label class="export-modal-field">
                <span>Format</span>
                <select id="exportFormat">
                    <option value="wav" selected>WAV</option>
                    <option value="mp3">MP3 (320k)</option>
                    <option value="both">WAV + MP3</option>
                </select>
            </label>
            <label class="export-modal-check">
                <input id="exportStems" type="checkbox">
                <span>Also export stems (multi-track / stack layers)</span>
            </label>
        `,
        readExtras: (root) => ({
            format: (root.querySelector<HTMLSelectElement>('#exportFormat')!.value || 'wav') as ExportAudioOptions['format'],
            stems: root.querySelector<HTMLInputElement>('#exportStems')!.checked,
        }),
    });
    if (!result) return null;
    const bars = result.length;
    return {durationSecs: (bars * 4 * 60) / bpm, bars, ...result.extras};
}

async function promptExportMidiOptions(
    bpm: number,
    code: string,
): Promise<ExportMidiOptions | null> {
    const result = await promptExportOptions(bpm, code, {
        title: 'Export MIDI',
        helpHtml: `
            Convert the pattern to a Standard MIDI File (notes + GM drums).
            Tempo: ${Math.round(bpm)} BPM (overridden by setcpm/setbpm in code).
        `,
        fieldLabel: 'Cycles',
        unit: 'cycles',
        defaultLength: DEFAULT_MIDI_CYCLES,
        parseLength: (raw) => parseInt(raw, 10),
        metaText: () => '1 cycle ≈ 1 bar (4 beats) at current tempo',
        readExtras: () => null,
    });
    return result ? {cycles: result.length} : null;
}

// Singleton — the app expects one instance.
export const fileManager = new FileManager();
window.fileManager = fileManager;
