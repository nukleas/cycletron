/**
 * CodeMirror 6 Editor for Strudel Live Coding
 */
import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    showPanel,
    type Panel
} from '@codemirror/view';
import {Decoration, type DecorationSet} from '@codemirror/view';
import {EditorState, Compartment, StateEffect, StateField} from '@codemirror/state';
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {javascript} from '@codemirror/lang-javascript';
import {
    bracketMatching,
    foldGutter,
    indentOnInput
} from '@codemirror/language';
import {closeBrackets, closeBracketsKeymap, completionStatus, closeCompletion} from '@codemirror/autocomplete';
import {highlightSelectionMatches, searchKeymap} from '@codemirror/search';
import {lintGutter, setDiagnostics} from '@codemirror/lint';
import {strudelThemeExtension} from './theme.js';
import {
    strudelAssistExtensions,
    isAssistEnabled,
    setAssistEnabledPref,
} from './editor-completions.js';

// Default pattern to show
const defaultCode = `// Strudel core runs in Rust/WASM; UI and scheduling are TypeScript
// Press Ctrl+Enter to play, Escape to stop

stack(
  // Drums
  s("bd*4"),
  s("~ cp ~ cp").gain(0.6),
  s("hh*8").gain(0.3).hpf(5000),

  // Bass
  note("<c2 ~ c2 ~> <~ eb2 ~ g2>")
    .s("sawtooth").lpf(500).gain(0.5),

  // Lead
  note("c4 eb4 g4 bb4").fast(2)
    .s("triangle").lpf(2000)
    .delay(0.3).room(0.3).gain(0.4)
)
`;

const oldDefaultClaim = '// Strudel WASM — 100% Rust, compiled to WebAssembly';
const softenedDefaultClaim = '// Strudel core runs in Rust/WASM; UI and scheduling are TypeScript';

function softenDefaultClaim(code: string | null): string | null {
    return code?.replace(oldDefaultClaim, softenedDefaultClaim) ?? null;
}

/** Carry {from, to} char offsets into the StateField. */
const setFlash = StateEffect.define<{ from: number; to: number }>();
/** Clear the flash decoration. */
const clearFlash = StateEffect.define<null>();

/** Set active-note highlight ranges (fired every animation frame during playback). */
const setActiveNotes = StateEffect.define<{ from: number; to: number }[]>();
/** Clear all active-note highlights (on stop). */
const clearActiveNotes = StateEffect.define<null>();

/** StateField for active-note highlights (separate from eval flash). */
const activeNoteField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setActiveNotes)) {
                const ranges = effect.value
                    .filter(({from, to}) => from < to)
                    .map(({from, to}) =>
                        Decoration.mark({class: 'cm-active-note'}).range(from, to)
                    )
                    .sort((a, b) => a.from - b.from || a.to - b.to);
                decorations = Decoration.set(ranges);
            } else if (effect.is(clearActiveNotes)) {
                decorations = Decoration.none;
            }
        }
        return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/** CSS for the active-note highlight. */
const activeNoteTheme = EditorView.baseTheme({
    '.cm-active-note': {
        backgroundColor: 'rgba(247, 255, 90, 0.18)',
        outline: '1.5px solid rgba(247, 255, 90, 0.72)',
        outlineOffset: '-1px',
        borderRadius: '0',
        transition: 'background-color 0.08s ease-out',
    },
});

/** StateField that manages the evaluated-block highlight DecorationSet. */
const flashField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        // Map existing decorations through any document changes first.
        decorations = decorations.map(tr.changes);

        for (const effect of tr.effects) {
            if (effect.is(setFlash)) {
                const {from, to} = effect.value;
                decorations = Decoration.set([
                    Decoration.mark({class: 'cm-evaluated-flash'}).range(from, to)
                ]);
            } else if (effect.is(clearFlash)) {
                decorations = Decoration.none;
            }
        }
        return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/** CSS injected once so the flash class is available. */
const flashTheme = EditorView.baseTheme({
    '.cm-evaluated-flash': {
        backgroundColor: 'rgba(255, 43, 214, 0.18)',
        borderRadius: '0',
        transition: 'background-color 0.4s ease-out',
    },
});

/** Set (or clear, with null) the inline inspect-readout panel content (HTML). */
const setInspect = StateEffect.define<string | null>();

/** Holds the current inspect-readout HTML; null hides the panel entirely. */
const inspectField = StateField.define<string | null>({
    create() {
        return null;
    },
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setInspect)) value = effect.value;
        }
        return value;
    },
    provide: (f) => showPanel.from(f, (content) => (content ? createInspectPanel : null)),
});

/** Bottom panel docked inside the editor, showing the pattern readout. */
function createInspectPanel(view: EditorView): Panel {
    const dom = document.createElement('div');
    dom.className = 'cm-inspect-panel';
    dom.innerHTML = view.state.field(inspectField) ?? '';
    return {
        dom,
        update(update) {
            const content = update.state.field(inspectField);
            if (content !== update.startState.field(inspectField)) {
                dom.innerHTML = content ?? '';
            }
        },
    };
}

/** Styling for the inspect panel (inner .insp-* spans come from style.css). */
const inspectTheme = EditorView.baseTheme({
    '.cm-inspect-panel': {
        padding: '5px 10px',
        fontSize: '11px',
        lineHeight: '1.5',
        color: 'var(--text-secondary)',
        background: 'var(--accent-subtle)',
        borderTop: '1px solid var(--border)',
        borderLeft: '2px solid var(--accent)',
        whiteSpace: 'nowrap',
        overflowX: 'auto',
        fontFamily: 'inherit',
    },
});

interface EditorCallbacks {
    onChange: (code: string) => void;
    onEvaluate: (code: string) => void;
    onStop: () => void;
}

export class StrudelEditor {
    private readonly container: HTMLDivElement;
    private readonly onChange: (code: string) => void;
    private readonly onEvaluate: (code: string) => void;
    private readonly onStop: () => void;

    private readonly themeCompartment: Compartment;
    private readonly fontSizeCompartment: Compartment;
    /** Holds the autocomplete + hover extensions so they can be toggled live. */
    private readonly assistCompartment: Compartment;

    private _flashTimer: ReturnType<typeof setTimeout> | null;

    view: EditorView;

    /**
     * @param container
     * @param callbacks - Object containing callbacks for editor events
     */
    constructor(container: HTMLDivElement, callbacks: EditorCallbacks) {
        this.container = container;
        const skeleton = container.querySelector('.editor-skel');
        this.onChange = callbacks.onChange;
        this.onEvaluate = callbacks.onEvaluate;
        this.onStop = callbacks.onStop;

        this.themeCompartment = new Compartment();
        this.fontSizeCompartment = new Compartment();
        this.assistCompartment = new Compartment();

        this._flashTimer = null;

        this.view = this.createEditor();

        // Small delay to ensure CM6 has performed its initial measure/render
        requestAnimationFrame(() => {
            setTimeout(() => {
                skeleton?.classList.add('fade-out');
                // Clean up DOM after transition to keep it light
                skeleton?.addEventListener('transitionend', () => {
                    skeleton?.remove();
                }, {once: true});
            }, 100);
        });
    }

    createEditor(): EditorView {
        const self = this;

        // Custom keybindings for live coding
        const liveKeymap = keymap.of([
            {
                key: 'Ctrl-Enter',
                mac: 'Cmd-Enter',
                run: () => {
                    self.evaluate();
                    return true;
                }
            },
            {
                key: 'Shift-Enter',
                run: () => {
                    // Evaluate current block (between blank lines)
                    self.evaluateBlock();
                    return true;
                }
            },
            {
                key: 'Escape',
                run: (view) => {
                    // If the autocomplete popup is open, Escape only dismisses it —
                    // it must not stop playback. Returning true marks the event
                    // handled so the global Escape handler skips the stop too.
                    if (completionStatus(view.state) != null) {
                        closeCompletion(view);
                        return true;
                    }
                    self.onStop();
                    return true;
                }
            },
            {
                key: 'Ctrl-.',
                mac: 'Cmd-.',
                run: () => {
                    self.onStop();
                    return true;
                }
            }
        ]);

        const state = EditorState.create({
            doc: softenDefaultClaim(window.__savedEditorCode) || defaultCode,
            extensions: [
                // Core functionality
                lineNumbers(),
                highlightActiveLineGutter(),
                highlightActiveLine(),
                history(),
                drawSelection(),
                indentOnInput(),
                bracketMatching(),
                closeBrackets(),
                foldGutter(),
                highlightSelectionMatches(),

                // Keymaps
                liveKeymap,
                keymap.of([
                    ...closeBracketsKeymap,
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...searchKeymap,
                    indentWithTab,
                ]),

                // Language
                javascript(),

                // Autocomplete + hover docs (toggleable; off = empty compartment)
                this.assistCompartment.of(
                    isAssistEnabled() ? strudelAssistExtensions() : []
                ),

                // Theme
                this.themeCompartment.of(strudelThemeExtension),
                this.fontSizeCompartment.of(EditorView.theme({
                    '&': {fontSize: 'var(--editor-font-size)'}
                })),

                // Flash highlight
                flashField,
                flashTheme,

                // Active note highlight (during playback)
                activeNoteField,
                activeNoteTheme,

                // Inline pattern readout (bottom panel)
                inspectField,
                inspectTheme,

                // Lint
                lintGutter(),

                // Change listener
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        this.onChange(this.getCode());
                    }
                }),

                // Styling
                EditorView.lineWrapping,
            ],
        });

        return new EditorView({
            state,
            parent: this.container,
        });
    }

    setFontSize(px: number): void {
        this.view.dispatch({
            effects: this.fontSizeCompartment.reconfigure(
                EditorView.theme({'&': {fontSize: `${px}px`}})
            )
        });
    }

    /** Whether autocomplete + hover docs are currently active. */
    isAssistEnabled(): boolean {
        return isAssistEnabled();
    }

    /** Toggle autocomplete + hover docs live, and remember the choice. */
    setAssistEnabled(on: boolean): void {
        setAssistEnabledPref(on);
        this.view.dispatch({
            effects: this.assistCompartment.reconfigure(
                on ? strudelAssistExtensions() : []
            ),
        });
    }

    getCode(): string {
        return this.view.state.doc.toString();
    }

    setCode(code: string): void {
        this.view.dispatch({
            changes: {
                from: 0,
                to: this.view.state.doc.length,
                insert: code
            }
        });
    }

    /** Insert text at the cursor (replacing any selection), then focus. */
    insertAtCursor(text: string): void {
        const sel = this.view.state.selection.main;
        this.view.dispatch({
            changes: {from: sel.from, to: sel.to, insert: text},
            selection: {anchor: sel.from + text.length},
        });
        this.view.focus();
    }

    /** Append `text` as a fresh line at the end of the document; cursor lands on it. */
    appendLine(text: string): void {
        const state = this.view.state;
        const end = state.doc.length;
        const prefix = end > 0 && !state.doc.toString().endsWith('\n') ? '\n' : '';
        const insert = prefix + text;
        this.view.dispatch({
            changes: {from: end, insert},
            selection: {anchor: end + insert.length},
        });
        this.view.focus();
    }

    /** Replace the text of the line the cursor sits on. */
    replaceCurrentLine(text: string): void {
        const state = this.view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        this.view.dispatch({
            changes: {from: line.from, to: line.to, insert: text},
            selection: {anchor: line.from + text.length},
        });
        this.view.focus();
    }

    /** Delete the line the cursor sits on, including its line break. */
    deleteCurrentLine(): void {
        const state = this.view.state;
        const line = state.doc.lineAt(state.selection.main.head);
        let from = line.from;
        let to = line.to;
        if (to < state.doc.length) to += 1;       // eat the following newline
        else if (from > 0) from -= 1;             // last line: eat the preceding newline
        this.view.dispatch({
            changes: {from, to, insert: ''},
            selection: {anchor: from},
        });
        this.view.focus();
    }

    /**
     * If the cursor sits inside or adjacent to an `s("…")` call (including
     * chained `.s("…")`), replace just the quoted sound name and return true.
     * Otherwise return false so the caller can fall back to a full insert.
     *
     * Scans ±400 chars around the cursor so multi-line patterns work fine.
     * Picks the candidate whose quoted range is closest to the cursor.
     */
    replaceNearestSound(name: string): boolean {
        const state = this.view.state;
        const cursor = state.selection.main.head;
        const doc = state.doc.toString();

        const lo = Math.max(0, cursor - 400);
        const hi = Math.min(doc.length, cursor + 400);
        const window = doc.slice(lo, hi);
        const cursorInWindow = cursor - lo;

        // Match both `s("…")` top-level and `.s("…")` chained forms.
        // Captures: [full match, quote char, content]
        const re = /\.?s\((['"]) *([\w:#.]*) *\1\)/g;
        let best: { from: number; to: number; dist: number } | null = null;

        let m: RegExpExecArray | null;
        while ((m = re.exec(window)) !== null) {
            // Position of the quoted content (inside the quotes)
            const q = m[1];
            const qStart = m.index + m[0].indexOf(q) + 1;
            const qEnd   = qStart + m[2].length;
            // Distance from cursor to this match (0 if cursor is inside it)
            const dist = cursorInWindow >= qStart && cursorInWindow <= qEnd
                ? 0
                : Math.min(Math.abs(cursorInWindow - qStart), Math.abs(cursorInWindow - qEnd));
            if (!best || dist < best.dist) {
                best = {from: lo + qStart, to: lo + qEnd, dist};
            }
        }

        if (!best || best.dist > 80) return false;

        this.view.dispatch({
            changes: {from: best.from, to: best.to, insert: name},
            selection: {anchor: best.from + name.length},
        });
        this.view.focus();
        return true;
    }

    evaluate(): void {
        const code = this.getCode();
        this.onEvaluate(code);
    }

    evaluateBlock(): void {
        // Find the block around the cursor (between blank lines)
        const pos = this.view.state.selection.main.head;
        const doc = this.view.state.doc;

        let startLine = doc.lineAt(pos).number;
        let endLine = startLine;

        // Find start of block
        while (startLine > 1) {
            const line = doc.line(startLine - 1);
            if (line.text.trim() === '') break;
            startLine--;
        }

        // Find end of block
        while (endLine < doc.lines) {
            const line = doc.line(endLine + 1);
            if (line.text.trim() === '') break;
            endLine++;
        }

        // Extract and evaluate block
        const startOffset = doc.line(startLine).from;
        const endOffset = doc.line(endLine).to;
        const block = doc.sliceString(startOffset, endOffset);

        if (block.trim()) {
            this.onEvaluate(block);
            this.flashBlock(startOffset, endOffset);
        }
    }

    /**
     * Briefly highlights the evaluated region using a CM6 mark decoration,
     * then fades it out after 500 ms.
     *
     * @param from - Start character offset in the document
     * @param to   - End character offset in the document
     */
    setActiveNotes(ranges: { from: number; to: number }[]): void {
        this.view.dispatch({effects: setActiveNotes.of(ranges)});
    }

    clearActiveNotes(): void {
        this.view.dispatch({effects: clearActiveNotes.of(null)});
    }

    flashBlock(from: number, to: number): void {
        // Cancel any in-progress flash so rapid Shift-Enters don't pile up.
        if (this._flashTimer !== null) {
            clearTimeout(this._flashTimer);
            this._flashTimer = null;
        }

        // Apply the highlight decoration via the StateField.
        this.view.dispatch({effects: setFlash.of({from, to})});

        // Remove it after the CSS transition has had time to run (~500 ms).
        this._flashTimer = setTimeout(() => {
            this._flashTimer = null;
            // Guard: editor may have been destroyed before the timer fires.
            if (!this.view.dom.isConnected) return;
            this.view.dispatch({effects: clearFlash.of(null)});
        }, 500);
    }

    /**
     * Show a squiggly error underline from `from` to `to`, with a hover tooltip
     * showing `message`. CM lint handles doc-change invalidation automatically.
     */
    setErrorDecoration(from: number, to: number, message: string): void {
        const docLen = this.view.state.doc.length;
        const clampedFrom = Math.max(0, Math.min(from, docLen - 1));
        const clampedTo = Math.max(clampedFrom + 1, Math.min(to, docLen));
        this.view.dispatch(setDiagnostics(this.view.state, [{
            from: clampedFrom,
            to: clampedTo,
            severity: 'error',
            message,
        }]));
    }

    /**
     * Remove the error squiggle and gutter marker.
     */
    clearErrorDecoration(): void {
        this.view.dispatch(setDiagnostics(this.view.state, []));
    }

    /** Show the inline pattern readout as a panel docked at the editor bottom. */
    setInspect(html: string): void {
        this.view.dispatch({effects: setInspect.of(html)});
    }

    /** Remove the inline readout panel. */
    clearInspect(): void {
        this.view.dispatch({effects: setInspect.of(null)});
    }

    focus(): void {
        this.view.focus();
    }

    destroy(): void {
        if (this._flashTimer !== null) {
            clearTimeout(this._flashTimer);
            this._flashTimer = null;
        }
        this.view.destroy();
    }
}
