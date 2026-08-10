/**
 * Show a "No file open / drop one here" overlay over the editor when:
 *   - no file is open (currentPath is null), AND
 *   - the editor buffer is empty/whitespace.
 *
 * Hides as soon as the user opens a file or starts typing. Provides
 * Zed/VSCode-style discoverable affordances.
 */

import {fileManager} from './file-manager.js';

class EditorEmptyState {
    private root: HTMLElement | null = null;
    private filePath: string | null = null;
    private code: string = '';

    init(): void {
        this.root = document.getElementById('editorEmptyState');
        if (!this.root) return;

        document.getElementById('emptyOpenBtn')?.addEventListener('click', () => {
            void fileManager.openFile();
        });
        document.getElementById('emptyNewBtn')?.addEventListener('click', () => {
            void fileManager.newFile();
        });
        document.getElementById('emptyExamplesBtn')?.addEventListener('click', () => {
            document.getElementById('browseExamples')?.click();
        });

        document.addEventListener('file:changed', ((e: CustomEvent) => {
            this.filePath = e.detail?.path ?? null;
            this.update();
        }) as EventListener);

        document.addEventListener('session:cleared', () => {
            this.filePath = null;
            this.code = '';
            this.update();
        });

        this.hookEditor();
        this.update();
    }

    private hookEditor(): void {
        const app = window.strudelApp;
        if (!app) {
            requestAnimationFrame(() => this.hookEditor());
            return;
        }
        const prev = app.onCodeChange;
        app.onCodeChange = (code: string) => {
            this.code = code;
            this.update();
            prev?.call(app, code);
        };
        // Initial seed.
        try {
            this.code = app.editor?.getCode?.() ?? '';
        } catch {
            this.code = '';
        }
        this.update();
    }

    private update(): void {
        if (!this.root) return;
        const empty = !this.filePath && this.code.trim().length === 0;
        this.root.hidden = !empty;
    }
}

export const editorEmptyState = new EditorEmptyState();
