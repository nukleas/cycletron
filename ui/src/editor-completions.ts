/**
 * Strudel editor assist: autocomplete + hover docs.
 *
 * What to offer depends on where the cursor is (`editor-spot.ts`):
 *   - after a `.`            methods from the DSL surface
 *   - in plain code          free functions and directives
 *   - `s("…")`/`sound("…")`  banks from the sound catalog; `:n` variants;
 *                            a machine's voices when the chain has `.bank("…")`
 *   - `.bank("…")`           drum machine names
 *   - any other string       nothing (notes, scales and chords are not sounds)
 *
 * Code symbols come from `generated/dsl-surface.ts` (extracted from
 * `docs/STRUDEL_RS_SUPPORTED.md`); sounds from `loadCatalog()`, the same
 * catalog the sounds panel shows. Gated behind a Compartment in `editor.ts`
 * (see `isAssistEnabled` / the editor's `setAssistEnabled`).
 */
import {
    autocompletion,
    type Completion,
    type CompletionContext,
    type CompletionResult,
} from '@codemirror/autocomplete';
import {ensureSyntaxTree, syntaxTree} from '@codemirror/language';
import type {EditorState, Extension} from '@codemirror/state';
import {EditorView, hoverTooltip, type Tooltip} from '@codemirror/view';
import {DSL_SYMBOLS, type DslSymbol} from './generated/dsl-surface.js';
import {CATEGORIES, loadCatalog, type Catalog} from './sound-catalog.js';
import {spotAt, stringAt, type Slice} from './editor-spot.js';
import {hoverTheme} from './hover-theme.js';

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

// --- Code symbols ----------------------------------------------------------

/** Hover lookup: label → symbol (the generated table has one entry per name). */
const SYMBOL_BY_LABEL = new Map<string, DslSymbol>(DSL_SYMBOLS.map((s) => [s.label, s]));

function codeCompletion(s: DslSymbol, type: string): Completion {
    return {
        label: s.label,
        type,
        detail: s.detail !== s.label ? s.detail : undefined,
        info: s.info || undefined,
    };
}

const METHOD_COMPLETIONS: Completion[] = DSL_SYMBOLS.filter((s) => s.kinds.includes('method')).map((s) =>
    codeCompletion(s, 'method'),
);
const TOP_LEVEL_COMPLETIONS: Completion[] = DSL_SYMBOLS.filter(
    (s) => s.kinds.includes('function') || s.kinds.includes('keyword'),
).map((s) => codeCompletion(s, s.kinds.includes('function') ? 'function' : 'keyword'));

// --- Sound options -----------------------------------------------------------

interface SoundOptions {
    /** Everything `s("…")` can name. Full machine voice names rank last. */
    banks: Completion[];
    /** `.bank("…")` names. */
    machines: Completion[];
    /** machine → its voices, for `s("…")` with a `.bank("…")` in the chain. */
    voices: Map<string, Completion[]>;
    /** bank name → variant count, for `:n`. Pitched banks have none. */
    counts: Map<string, number>;
}

const CATEGORY_LABEL = new Map(CATEGORIES.map((c) => [c.id, c.label]));
const DSL_SOUNDS = DSL_SYMBOLS.filter((s) => s.kinds.includes('sound'));
const DSL_SOUND_INFO = new Map(DSL_SOUNDS.map((s) => [s.label, s.info]));

export function buildSoundOptions(catalog: Catalog | null): SoundOptions {
    const banks: Completion[] = [];
    const voices = new Map<string, Completion[]>();
    const counts = new Map<string, number>();
    const seen = new Set<string>();

    for (const bank of catalog?.banks ?? []) {
        // Disabled packs don't play; a shadowed pack bank is a duplicate name.
        if (bank.disabled || bank.shadowed) continue;
        seen.add(bank.name);
        // A pitched bank's samples are notes of one instrument, not `:n` takes.
        const variants = bank.kind === 'pitched' ? 0 : bank.count;
        counts.set(bank.name, variants);
        const category = CATEGORY_LABEL.get(bank.category) ?? bank.category;
        const machineVoice = bank.kind === 'machine-voice' && bank.machine;
        if (machineVoice) {
            const voice = bank.name.slice(bank.machine!.length + 1);
            const list = voices.get(bank.machine!) ?? [];
            list.push({label: voice, type: 'variable', detail: variants > 1 ? `${bank.machine} · ${variants}` : bank.machine});
            voices.set(bank.machine!, list);
        }
        banks.push({
            label: bank.name,
            type: 'variable',
            detail: variants > 1 ? `${category} · ${variants}` : category,
            info: DSL_SOUND_INFO.get(bank.name) || bank.origin,
            // Valid, but `s("bd").bank("RolandTR909")` is the idiom; keep these last.
            boost: machineVoice ? -10 : undefined,
        });
    }
    // Synths are DSP, not files: the catalog only lists them under Tauri.
    for (const s of DSL_SOUNDS) {
        if (seen.has(s.label)) continue;
        banks.push({label: s.label, type: 'variable', detail: 'Synths', info: s.info || undefined});
    }

    const machines: Completion[] = [...voices].map(([machine, list]) => ({
        label: machine,
        type: 'class',
        detail: `${list.length} voices`,
        info: list.map((v) => v.label).join(' '),
    }));

    return {banks, machines, voices, counts};
}

const optionsByCatalog = new WeakMap<Catalog, SoundOptions>();
let staticOptions: SoundOptions | null = null;

async function soundOptions(): Promise<SoundOptions> {
    let catalog: Catalog;
    try {
        catalog = await loadCatalog();
    } catch (e) {
        console.warn('[editor-completions] sound catalog unavailable:', e);
        return (staticOptions ??= buildSoundOptions(null));
    }
    let options = optionsByCatalog.get(catalog);
    if (!options) {
        options = buildSoundOptions(catalog);
        optionsByCatalog.set(catalog, options);
    }
    return options;
}

// --- Autocomplete ----------------------------------------------------------

function treeAt(state: EditorState, pos: number) {
    return ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
}

function sliceOf(state: EditorState): Slice {
    return (from, to) => state.sliceDoc(from, to);
}

const WORD = /^[\w$]*$/;

async function stringCompletions(
    context: CompletionContext,
    callee: string | null,
    bank: string | null,
    from: number,
    word: string,
): Promise<CompletionResult | null> {
    if (callee === 'bank') {
        if (word.includes(':')) return null;
        const {machines} = await soundOptions();
        return {from, options: machines, validFor: WORD};
    }
    if (callee !== 's' && callee !== 'sound') return null;

    const opts = await soundOptions();
    const machineVoices = bank ? opts.voices.get(bank) : undefined;

    // `bd:` → the variant indexes that bank has.
    const variant = /^(\w+):(\d*)$/.exec(word);
    if (variant) {
        const name = machineVoices ? `${bank}_${variant[1]}` : variant[1];
        const count = opts.counts.get(name) ?? 0;
        if (count < 2) return null;
        const options = Array.from({length: count}, (_, i) => ({label: String(i), type: 'constant'}));
        return {from: from + variant[1].length + 1, options, validFor: /^\d*$/};
    }
    if (word.includes(':')) return null;
    if (!word && !context.explicit) return null;
    // With `.bank("X")` in the chain, `s("bd")` means `X_bd`: offer X's voices.
    return {from, options: machineVoices ?? opts.banks, validFor: WORD};
}

export function strudelCompletionSource(context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> {
    const {state, pos} = context;
    const spot = spotAt(treeAt(state, pos), sliceOf(state), pos);
    switch (spot.kind) {
        case 'none':
            return null;
        case 'string':
            return stringCompletions(context, spot.callee, spot.bank, spot.from, spot.word);
        case 'code':
            // After `.` the list opens straight away; elsewhere wait for a letter.
            if (spot.from === pos && !spot.member && !context.explicit) return null;
            return {
                from: spot.from,
                options: spot.member ? METHOD_COMPLETIONS : TOP_LEVEL_COMPLETIONS,
                validFor: WORD,
            };
    }
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
    // Inside a string a word is a sound (or a note); in code it's a function or method.
    const inString = stringAt(treeAt(view.state, pos), sliceOf(view.state), hit.from + 1) !== null;
    const isSound = sym.kinds.includes('sound');
    const isCode = sym.kinds.some((k) => k !== 'sound');
    if (inString ? !isSound : !isCode) return null;

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

// --- Assembly --------------------------------------------------------------

/** The full assist bundle: autocomplete + hover, ready to drop in a Compartment. */
export function strudelAssistExtensions(): Extension {
    return [
        autocompletion({override: [strudelCompletionSource], activateOnTyping: true, icons: true}),
        hoverTooltip(strudelHover, {hoverTime: 300}),
        hoverTheme,
    ];
}
