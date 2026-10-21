/**
 * The show file, editable beside the song while the show plays.
 *
 * Its own CodeMirror view, with its own history, so undo never crosses
 * between song and show. Edits reach the player after a short pause; the
 * player answers with the problem in the buffer (if any) and the line of the
 * playing section, which the pane marks.
 */

import {autocompletion} from '@codemirror/autocomplete';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {StreamLanguage} from '@codemirror/language';
import {toml} from '@codemirror/legacy-modes/mode/toml';
import {lintGutter, setDiagnostics} from '@codemirror/lint';
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search';
import {Annotation, EditorState, StateEffect, StateField, Transaction} from '@codemirror/state';
import {
    EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
} from '@codemirror/view';
import {tags} from '@lezer/highlight';
import {basename, relativePath} from '../paths.js';
import {invoke} from '../tauri.js';
import {strudelThemeExtension} from '../theme.js';
import {VIZ_MODES} from '../viz/registry.js';
import {type AssistSources, completions, hover} from './assist.js';

/** Quiet time after a keystroke before the show is re-read. */
const EDIT_PAUSE_MS = 300;
const WIDTH_KEY = 'show-pane-width';

export interface ShowPaneHandlers {
    /** The buffer after an edit pause. */
    onEdit(text: string): void;
    onClose(): void;
    /** Section labels of the `index`th song, once it's loaded. */
    sections(index: number): readonly string[];
}

/** The problem in the buffer, at a 1-based line. */
export interface Problem {
    line: number;
    message: string;
}

// Table headers read as keywords, as they do in other editors.
const tomlLanguage = StreamLanguage.define({...toml, tokenTable: {atom: tags.keyword}});

/** A change that came from disk, not from typing: not an edit, not undoable. */
const fromDisk = Annotation.define<boolean>();

const setPlaying = StateEffect.define<number | null>();
const playingLine = StateField.define<number | null>({
    create: () => null,
    update: (line, tr) => {
        for (const e of tr.effects) if (e.is(setPlaying)) return e.value;
        return line;
    },
});

class PlayingMarker extends GutterMarker {
    toDOM(): Node {
        const el = document.createElement('span');
        el.className = 'show-pane-playing';
        el.textContent = '▶';
        el.title = 'Playing';
        return el;
    }
}
const PLAYING = new PlayingMarker();

class ShowPane {
    private view: EditorView | null = null;
    private handlers: ShowPaneHandlers | null = null;
    private path: string | null = null;
    private savedText = '';
    private editTimer: ReturnType<typeof setTimeout> | null = null;
    private wired = false;
    /** Kept across focus moving to the palette, menus or dialogs. */
    private lastEditor: 'song' | 'show' = 'song';
    /** The library's songs, listed once per open. */
    private songs: Promise<string[]> | null = null;

    get isOpen(): boolean {
        return this.view !== null;
    }

    get text(): string {
        return this.view?.state.doc.toString() ?? '';
    }

    get isDirty(): boolean {
        return this.isOpen && this.text !== this.savedText;
    }

    /** Whether the show, not the song, is the editor last worked in — what Save saves. */
    isActiveEditor(): boolean {
        return this.isOpen && this.lastEditor === 'show';
    }

    open(path: string, text: string, handlers: ShowPaneHandlers): void {
        this.close();
        this.wire();
        this.path = path;
        this.handlers = handlers;
        this.savedText = text;
        this.lastEditor = 'song';
        this.songs = null;
        this.view = new EditorView({
            state: EditorState.create({doc: text, extensions: this.extensions()}),
            parent: element('showPaneEditor'),
        });
        element('showPaneName').textContent = basename(path);
        element('showPaneName').title = path;
        element('showPane').hidden = false;
        element('showDivider').hidden = false;
        this.renderDirty();
    }

    close(): void {
        if (!this.view) return;
        if (this.editTimer !== null) clearTimeout(this.editTimer);
        this.editTimer = null;
        this.view.destroy();
        this.view = null;
        this.handlers = null;
        this.path = null;
        element('showPane').hidden = true;
        element('showDivider').hidden = true;
    }

    /** Write the buffer to the show file. */
    async save(): Promise<boolean> {
        if (!this.view || !this.path) return false;
        const text = this.text;
        await invoke('write_text', {path: this.path, text});
        this.savedText = text;
        this.renderDirty();
        return true;
    }

    /** Take the file's text from disk, as saved. */
    replace(text: string): void {
        if (!this.view) return;
        this.savedText = text;
        if (text !== this.text) {
            this.view.dispatch({
                changes: {from: 0, to: this.view.state.doc.length, insert: text},
                annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
            });
        }
        this.renderDirty();
    }

    /** Treat `text` as what's on disk while keeping the buffer's edits. */
    adopt(text: string): void {
        this.savedText = text;
        this.renderDirty();
    }

    /** The disk text this buffer was last loaded from or saved as. */
    get saved(): string {
        return this.savedText;
    }

    setProblem(problem: Problem | null): void {
        const view = this.view;
        if (!view) return;
        const diagnostics = [];
        if (problem) {
            const line = view.state.doc.line(Math.min(Math.max(problem.line, 1), view.state.doc.lines));
            diagnostics.push({from: line.from, to: line.to, severity: 'error' as const, message: problem.message});
        }
        view.dispatch(setDiagnostics(view.state, diagnostics));
    }

    /** Mark the playing section's 1-based line, or none. */
    setPlaying(line: number | null): void {
        const view = this.view;
        if (!view || view.state.field(playingLine) === line) return;
        view.dispatch({effects: setPlaying.of(line)});
    }

    /** What suggestions draw on beyond the file. */
    private sources(): AssistSources {
        return {
            modes: VIZ_MODES.map((m) => ({id: m.id, name: m.name})),
            sections: (index) => this.handlers?.sections(index) ?? [],
            songs: async () => {
                this.songs ??= invoke<string[]>('list_library_songs').catch(() => []);
                const dir = (this.path ?? '').replace(/[\\/][^\\/]*$/, '');
                return (await this.songs).map((song) => relativePath(dir, song));
            },
        };
    }

    private extensions() {
        const sources = this.sources();
        return [
            lineNumbers(),
            gutter({
                class: 'show-pane-playing-gutter',
                lineMarker: (view, line) => {
                    const at = view.state.field(playingLine);
                    return at !== null && at <= view.state.doc.lines && view.state.doc.line(at).from === line.from ? PLAYING : null;
                },
                lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setPlaying))),
            }),
            playingLine,
            highlightActiveLineGutter(),
            highlightActiveLine(),
            history(),
            drawSelection(),
            highlightSelectionMatches(),
            keymap.of([
                // Play and stop work from here as they do from the song.
                {key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: () => (void window.strudelApp?.play(), true)},
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                indentWithTab,
            ]),
            tomlLanguage,
            strudelThemeExtension,
            EditorView.theme({'&': {fontSize: 'var(--editor-font-size)'}}),
            EditorView.lineWrapping,
            lintGutter(),
            // ⌃Space for suggestions anywhere; they also open as you type.
            autocompletion({override: [completions(sources)]}),
            hover(sources),
            EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                this.renderDirty();
                if (update.transactions.some((tr) => tr.annotation(fromDisk))) return;
                if (this.editTimer !== null) clearTimeout(this.editTimer);
                this.editTimer = setTimeout(() => {
                    this.editTimer = null;
                    this.handlers?.onEdit(this.text);
                }, EDIT_PAUSE_MS);
            }),
        ];
    }

    private renderDirty(): void {
        element('showPaneDirty').hidden = !this.isDirty;
    }

    /** The close button and the divider drag, wired once. */
    private wire(): void {
        if (this.wired) return;
        this.wired = true;
        element('showPaneClose').addEventListener('click', () => this.handlers?.onClose());
        document.addEventListener('focusin', (e) => {
            const target = e.target as Node;
            if (element('showPaneEditor').contains(target)) this.lastEditor = 'show';
            else if (document.getElementById('editor')?.contains(target)) this.lastEditor = 'song';
        });

        const pane = element('showPane');
        const width = localStorage.getItem(WIDTH_KEY);
        if (width) pane.style.setProperty('--show-pane-width', width);

        const divider = element('showDivider');
        divider.addEventListener('pointerdown', (down) => {
            down.preventDefault();
            divider.setPointerCapture(down.pointerId);
            divider.classList.add('dragging');
            const split = element('editorSplit').getBoundingClientRect();
            const move = (e: PointerEvent) => {
                const px = Math.min(Math.max(split.right - e.clientX, 220), split.width - 240);
                pane.style.setProperty('--show-pane-width', `${Math.round(px)}px`);
            };
            const up = () => {
                divider.removeEventListener('pointerup', up);
                divider.removeEventListener('pointercancel', up);
                divider.classList.remove('dragging');
                divider.removeEventListener('pointermove', move);
                localStorage.setItem(WIDTH_KEY, pane.style.getPropertyValue('--show-pane-width'));
            };
            divider.addEventListener('pointermove', move);
            divider.addEventListener('pointerup', up, {once: true});
            divider.addEventListener('pointercancel', up, {once: true});
        });
    }
}

function element(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`show pane: #${id} is missing`);
    return el;
}

export const showPane = new ShowPane();
