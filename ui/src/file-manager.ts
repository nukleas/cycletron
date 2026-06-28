/**
 * File lifecycle for robostrudel: New / Open / Save / Save As / Recents.
 *
 * Sits between the native dialog plugin and the Tauri file commands.
 * The editor is the authoritative buffer — we pull code from it on save
 * and push code into it on open.
 */

import {invoke} from './tauri.js';
import type {FileDoc, CurrentFile, MidiImport, ImportMidiOptions} from './types/tauri-commands.js';

const isTauri = !!(window as any).__TAURI__;

type Dialog = {
    open: (opts?: any) => Promise<any>;
    save: (opts?: any) => Promise<string | null>;
    ask: (msg: string, opts?: any) => Promise<boolean>;
    message: (msg: string, opts?: any) => Promise<void>;
};

const STRUDEL_FILTER = {
    name: 'Strudel Pattern',
    extensions: ['strudel', 'js'],
};

const MIDI_FILTER = {
    name: 'MIDI File',
    extensions: ['mid', 'midi'],
};

export class FileManager {
    private currentPath: string | null = null;
    private currentName: string = 'untitled';
    private lastSavedCode: string = '';
    private dirty = false;
    private dialogPromise: Promise<Dialog> | null = null;

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
        if (!(await this.confirmDiscardIfDirty())) return;

        const dialog = await this.getDialog();
        const picked = await dialog.open({
            multiple: false,
            directory: false,
            filters: [STRUDEL_FILTER],
        });
        const path = typeof picked === 'string' ? picked : picked?.path ?? null;
        if (!path) return;
        await this.openPath(path);
    }

    async openPath(path: string): Promise<void> {
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
            await this.showError(`Could not open file:\n${e}`);
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
        const dialog = await this.getDialog();
        const picked = await dialog.save({
            defaultPath: this.currentPath ?? `${this.currentName}.strudel`,
            filters: [STRUDEL_FILTER],
        });
        if (!picked) return false;
        return this.writeTo(picked);
    }

    private async writeTo(path: string): Promise<boolean> {
        const code = this.getEditorCode();
        const bpm = this.currentBpm();
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
            await this.showError(`Could not save:\n${e}`);
            return false;
        }
    }

    async importMidiDialog(): Promise<void> {
        if (!isTauri) return;
        if (!(await this.confirmDiscardIfDirty())) return;
        const dialog = await this.getDialog();
        const picked = await dialog.open({
            multiple: false,
            directory: false,
            filters: [MIDI_FILTER],
        });
        const path = typeof picked === 'string' ? picked : picked?.path ?? null;
        if (!path) return;
        await this.importMidiPath(path);
    }

    async importMidiPath(path: string, options?: ImportMidiOptions): Promise<void> {
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
            await this.showError(`Could not import MIDI:\n${e}`);
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
        const dialog = await this.getDialog();
        return dialog.ask(
            `"${this.currentName}" has unsaved changes. Discard them?`,
            {title: 'Robostrudel', kind: 'warning'},
        );
    }

    private async showError(message: string): Promise<void> {
        if (!isTauri) {
            console.error(message);
            return;
        }
        const dialog = await this.getDialog();
        await dialog.message(message, {title: 'Robostrudel', kind: 'error'});
    }

    private async getDialog(): Promise<Dialog> {
        if (!this.dialogPromise) {
            this.dialogPromise = import('@tauri-apps/plugin-dialog') as unknown as Promise<Dialog>;
        }
        return this.dialogPromise;
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

    private currentBpm(): number | undefined {
        const el = document.getElementById('bpmSlider') as HTMLInputElement | null;
        const v = el ? parseInt(el.value, 10) : NaN;
        return isNaN(v) ? undefined : v;
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

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

// Singleton — the app expects one instance.
export const fileManager = new FileManager();
(window as any).fileManager = fileManager;
