/**
 * Strudel editor assist: autocomplete + hover docs sourced from the
 * ground-truth DSL surface (`generated/dsl-surface.ts`, extracted from
 * `docs/STRUDEL_RS_SUPPORTED.md`) plus the live sound catalog.
 *
 * Pure static data + O(1)/O(n) scans — no engine eval, no IPC on the hot path.
 * The whole thing is gated behind a Compartment in `editor.ts` so it can be
 * toggled off live (see `isAssistEnabled` / the editor's `setAssistEnabled`).
 */
import {
    autocompletion,
    type Completion,
    type CompletionContext,
    type CompletionResult,
} from '@codemirror/autocomplete';
import {EditorView, hoverTooltip, type Tooltip} from '@codemirror/view';
import type {Extension} from '@codemirror/state';
import {DSL_SYMBOLS, type DslKind, type DslSymbol} from './generated/dsl-surface.js';

// --- Toggle state (localStorage-backed; default on) ------------------------

const ASSIST_KEY = 'cycletron.editorAssist';

export function isAssistEnabled(): boolean {
    try {
        return localStorage.getItem(ASSIST_KEY) !== 'off';
    } catch {
        return true;
    }
}

export function setAssistEnabledPref(on: boolean): void {
    try {
        localStorage.setItem(ASSIST_KEY, on ? 'on' : 'off');
    } catch {
        /* private mode / storage disabled — toggle still works for the session */
    }
}

// --- Symbol tables ---------------------------------------------------------

/** Hover lookup: label → symbol (first definition wins; the table is deduped). */
const SYMBOL_BY_LABEL = new Map<string, DslSymbol>();
for (const s of DSL_SYMBOLS) if (!SYMBOL_BY_LABEL.has(s.label)) SYMBOL_BY_LABEL.set(s.label, s);

/** CodeMirror completion `type` (drives the icon) per symbol kind. */
const CM_TYPE: Record<DslKind, string> = {
    function: 'function',
    method: 'method',
    sound: 'variable',
    keyword: 'keyword',
};

function toCompletion(s: DslSymbol): Completion {
    return {
        label: s.label,
        type: CM_TYPE[s.kind],
        detail: s.detail !== s.label ? s.detail : undefined,
        info: s.info || undefined,
    };
}

// Split once: sounds are offered inside strings, everything else in code.
const CODE_COMPLETIONS: Completion[] = DSL_SYMBOLS.filter((s) => s.kind !== 'sound').map(toCompletion);
const STATIC_SOUND_COMPLETIONS: Completion[] = DSL_SYMBOLS.filter((s) => s.kind === 'sound').map(toCompletion);

/** Sound names from the live `list_sounds` catalog (drums, GM, user banks). */
let dynamicSoundCompletions: Completion[] = [];

/** Replace the dynamic sound list (call from `sounds:changed`, etc.). */
export function setAssistSounds(names: string[]): void {
    const seen = new Set(STATIC_SOUND_COMPLETIONS.map((c) => c.label));
    dynamicSoundCompletions = names
        .filter((n) => n && !seen.has(n))
        .map((n) => ({label: n, type: 'variable'} as Completion));
}

let soundsRequested = false;

/**
 * Merge the live sound catalog in once, lazily, the first time a string context
 * asks for sounds. Guarded so a non-Tauri/web build (or an engine that isn't up
 * yet) just falls back to the static synth list.
 */
export async function refreshAssistSounds(): Promise<void> {
    try {
        const {invoke} = await import('./tauri.js');
        const cat = await invoke<{
            synths?: string[];
            wavetables?: string[];
            drums?: string[];
            gm_instruments?: string[];
            user_sample_banks?: string[];
            drum_machines?: {banks?: string[]}[];
        }>('list_sounds');
        setAssistSounds([
            ...(cat.synths ?? []),
            ...(cat.wavetables ?? []),
            ...(cat.drums ?? []),
            ...(cat.gm_instruments ?? []),
            ...(cat.user_sample_banks ?? []),
            ...(cat.drum_machines ?? []).flatMap((m) => m.banks ?? []),
        ]);
    } catch {
        /* not under Tauri / engine not ready — static synths still complete */
    }
}

// Keep completions fresh when the app announces sound changes.
if (typeof document !== 'undefined') {
    document.addEventListener('sounds:changed', () => void refreshAssistSounds());
}

// --- Autocomplete ----------------------------------------------------------

/** True if `pos` sits inside an unclosed double-quoted string on its line. */
function insideString(context: CompletionContext): boolean {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    let open = false;
    for (let i = 0; i < before.length; i++) {
        if (before[i] === '"' && before[i - 1] !== '\\') open = !open;
    }
    return open;
}

function strudelCompletionSource(context: CompletionContext): CompletionResult | null {
    const word = context.matchBefore(/[\w]+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    if (insideString(context)) {
        // Sound names live in mini-notation strings. Kick off the one-time
        // catalog fetch; this call uses whatever's loaded so far.
        if (!soundsRequested) {
            soundsRequested = true;
            void refreshAssistSounds();
        }
        const options = dynamicSoundCompletions.length
            ? [...STATIC_SOUND_COMPLETIONS, ...dynamicSoundCompletions]
            : STATIC_SOUND_COMPLETIONS;
        return {from: word.from, options, validFor: /^[\w]*$/};
    }

    return {from: word.from, options: CODE_COMPLETIONS, validFor: /^[\w]*$/};
}

// --- Hover docs ------------------------------------------------------------

function strudelHover(view: EditorView, pos: number): Tooltip | null {
    const line = view.state.doc.lineAt(pos);
    const rel = pos - line.from;
    const re = /[A-Za-z_][\w]*/g;
    let hit: {from: number; to: number; word: string} | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line.text)) !== null) {
        if (m.index <= rel && rel <= m.index + m[0].length) {
            hit = {from: line.from + m.index, to: line.from + m.index + m[0].length, word: m[0]};
            break;
        }
    }
    if (!hit) return null;
    const sym = SYMBOL_BY_LABEL.get(hit.word);
    if (!sym) return null;

    return {
        pos: hit.from,
        end: hit.to,
        above: true,
        create() {
            const dom = document.createElement('div');
            dom.className = 'cm-strudel-hover';
            const sig = document.createElement('div');
            sig.className = 'cm-strudel-hover-sig';
            sig.textContent = sym.detail;
            dom.appendChild(sig);
            if (sym.info) {
                const info = document.createElement('div');
                info.className = 'cm-strudel-hover-info';
                info.textContent = sym.info;
                dom.appendChild(info);
            }
            return {dom};
        },
    };
}

const hoverTheme = EditorView.baseTheme({
    '.cm-strudel-hover': {
        padding: '5px 8px',
        maxWidth: '340px',
        font: '12px/1.5 var(--font-mono, monospace)',
    },
    '.cm-strudel-hover-sig': {
        color: 'var(--accent, #ff2bd6)',
        fontWeight: '600',
    },
    '.cm-strudel-hover-info': {
        marginTop: '2px',
        color: 'var(--text-secondary, #aaa)',
        whiteSpace: 'normal',
    },
});

// --- Assembly --------------------------------------------------------------

/** The full assist bundle: autocomplete + hover, ready to drop in a Compartment. */
export function strudelAssistExtensions(): Extension {
    return [
        autocompletion({override: [strudelCompletionSource], activateOnTyping: true, icons: true}),
        hoverTooltip(strudelHover, {hoverTime: 300}),
        hoverTheme,
    ];
}
