/**
 * Suggestions and hover text in the show pane, from `schema.ts`.
 *
 * `spotAt` reads where the cursor is (which table, and whether a key, a
 * value or a header goes there) with a light scan of the text above it, so
 * it works on a half-typed file that doesn't parse yet.
 */

import type {Completion, CompletionContext, CompletionResult, CompletionSource} from '@codemirror/autocomplete';
import {hoverTooltip, type Tooltip} from '@codemirror/view';
import {hoverTheme} from '../editor-completions.js';
import {type KeyDoc, SCHEMA, type TableName} from './schema.js';

/** What goes at the cursor. */
export interface Spot {
    kind: 'key' | 'value' | 'header' | 'none';
    /** The table the cursor is in, or that the value's key belongs to. */
    table: TableName | null;
    /** For a value: its key. */
    key: string | null;
    /** For a value: inside a `[ … ]` list. */
    inList: boolean;
    /** Inside a quoted string. */
    quoted: boolean;
    /** Start of the word being typed. */
    from: number;
    /** Keys already set in this table. */
    seen: ReadonlySet<string>;
    /** Which `[[song]]` the cursor is under, from 0; -1 above the first. */
    song: number;
}

interface Frame {
    /** A table, or a list (whose items are values of `key`). */
    list: boolean;
    table: TableName | null;
    key: string | null;
    seen: Set<string>;
    /** What comes next: a key, a value, or (after a value) a separator. */
    expect: 'key' | 'value' | 'after';
}

const HEADER = /^\s*(\[\[?)\s*([^\]]*?)\s*\]?\]?\s*(#.*)?$/;

export function spotAt(text: string, pos: number): Spot {
    const before = text.slice(0, pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lines = before.split('\n');

    // The header the cursor is under, and the song count above it.
    let song = -1;
    let headerAt = 0;
    let base: TableName | null = null;
    let offset = 0;
    for (const line of lines.slice(0, -1)) {
        const m = HEADER.exec(line);
        if (m && line.trimStart().startsWith('[')) {
            if (m[1] === '[[' && m[2] === 'song') song++;
            base = headerTable(m[2]);
            headerAt = offset + line.length + 1;
        }
        offset += line.length + 1;
    }

    const current = lines[lines.length - 1];
    if (/^\s*\[/.test(current) && !/=/.test(current)) {
        const from = lineStart + current.length - current.trimStart().length;
        return {kind: 'header', table: null, key: null, inList: false, quoted: false, from, seen: new Set(), song};
    }

    const stack: Frame[] = [{list: false, table: base, key: null, seen: new Set(), expect: 'key'}];
    let word = '';
    let wordFrom = headerAt;
    let quote: '"' | "'" | null = null;
    let quoteFrom = 0;
    let comment = false;

    const top = () => stack[stack.length - 1];
    const valueDone = () => {
        top().expect = 'after';
    };

    for (let i = headerAt; i < pos; i++) {
        const c = text[i];
        if (comment) {
            if (c === '\n') comment = false;
            else continue;
        }
        if (quote) {
            if (c === '\\' && quote === '"') i++;
            else if (c === quote) {
                quote = null;
                valueDone();
            }
            continue;
        }
        const frame = top();
        if (/[A-Za-z0-9_\-.+]/.test(c)) {
            if (word === '') wordFrom = i;
            word += c;
            continue;
        }
        // A word ends.
        if (word) {
            if (frame.expect === 'value') valueDone();
            else if (frame.expect === 'key') frame.key = word;
            word = '';
        }
        if (c === '#') comment = true;
        else if (c === '"' || c === "'") {
            quote = c;
            quoteFrom = i + 1;
        } else if (c === '=' && frame.expect === 'key' && frame.key) {
            frame.seen.add(frame.key);
            frame.expect = 'value';
        } else if (c === '{' && frame.expect === 'value') {
            // In a list, each entry of `shots` or `text`.
            stack.push({list: false, table: valueTable(frame), key: null, seen: new Set(), expect: 'key'});
        } else if (c === '[' && frame.expect === 'value') {
            stack.push({list: true, table: frame.table, key: frame.key, seen: new Set(), expect: 'value'});
        } else if ((c === '}' || c === ']') && stack.length > 1) {
            stack.pop();
            valueDone();
        } else if (c === ',') {
            frame.expect = frame.list ? 'value' : 'key';
            if (!frame.list) frame.key = null;
        } else if (c === '\n' && stack.length === 1) {
            frame.expect = 'key';
            frame.key = null;
        }
    }

    const frame = top();
    const spot = (kind: Spot['kind'], from: number, quoted = false): Spot => ({
        kind, from, quoted, song, seen: frame.seen, inList: frame.list,
        table: frame.table, key: kind === 'value' ? frame.key : null,
    });
    if (quote) return frame.expect === 'value' ? spot('value', quoteFrom, true) : spot('none', pos);
    const from = word ? wordFrom : pos;
    if (frame.expect === 'key') return spot('key', from);
    if (frame.expect === 'value') return spot('value', from);
    return spot('none', pos);
}

/** The table a `[a.b.c]` header opens. */
function headerTable(path: string): TableName | null {
    const [first, ...rest] = path.split('.').map((p) => p.trim());
    let table: TableName | null = first === 'show' || first === 'defaults' || first === 'song' ? first : null;
    for (const part of rest) {
        if (!table) return null;
        table = table === 'sections' ? 'section' : SCHEMA[table][part]?.table ?? null;
    }
    return table;
}

/** The table a `{ … }` value of the frame's key is. */
function valueTable(frame: Frame): TableName | null {
    if (!frame.table || !frame.key) return null;
    if (frame.table === 'sections') return 'section';
    return SCHEMA[frame.table][frame.key]?.table ?? null;
}

/** The doc for `key` in `table`; a section label's in `sections`. */
export function keyDoc(table: TableName | null, key: string | null): KeyDoc | null {
    if (!table || !key) return null;
    if (table === 'sections') return {doc: `Section '${key}': a mode, or a table of mode, shots, title, text and look keys.`, choices: 'modes'};
    return SCHEMA[table][key] ?? null;
}

/** What the pane knows beyond the file: the visual modes, a song's section labels, the library's songs. */
export interface AssistSources {
    modes: readonly {id: string; name: string}[];
    /** Labels of the `index`th song's sections, if it's loaded. */
    sections(index: number): readonly string[];
    /** Library songs, as paths relative to the show. */
    songs(): Promise<readonly string[]>;
}

const HEADERS: readonly Completion[] = [
    {label: '[show]', detail: 'title, render output'},
    {label: '[defaults]', detail: 'looks every song starts from'},
    {label: '[[song]]', detail: 'a song in the setlist'},
    {label: '[song.sections]', detail: 'looks by section label'},
];

export function completions(sources: AssistSources): CompletionSource {
    return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const text = ctx.state.doc.toString();
        const spot = spotAt(text, ctx.pos);
        const lineBefore = ctx.state.doc.lineAt(ctx.pos).text.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from);
        const typed = ctx.pos > spot.from;
        // Unprompted, only after a word starts or a value opens.
        if (!ctx.explicit && !typed && !spot.quoted && !/[=[{,]\s*$/.test(lineBefore)) return null;

        if (spot.kind === 'header') {
            const labels = sources.sections(Math.max(spot.song, 0));
            return {
                from: spot.from,
                options: [...HEADERS, ...labels.map((l) => ({label: `[song.sections.${l}]`, detail: 'this section\'s look'}))],
            };
        }

        if (spot.kind === 'key') {
            if (spot.table === 'sections') {
                return {
                    from: spot.from,
                    options: sources.sections(spot.song).filter((l) => !spot.seen.has(l))
                        .map((l) => ({label: l, type: 'property', detail: 'section', apply: `${l} = `})),
                    validFor: /^[\w-]*$/,
                };
            }
            if (!spot.table) return null;
            const options = Object.entries(SCHEMA[spot.table])
                .filter(([key]) => !spot.seen.has(key))
                .map(([key, doc]): Completion => ({label: key, type: 'property', info: doc.doc, detail: doc.example, apply: `${key} = `}));
            return {from: spot.from, options, validFor: /^[\w-]*$/};
        }

        if (spot.kind === 'value') {
            const doc = keyDoc(spot.table, spot.key);
            if (!doc) return null;
            const options: Completion[] = [];
            const word = (w: string, detail?: string): Completion => ({
                label: w, type: 'enum', detail, apply: spot.quoted ? w : `"${w}"`,
            });
            if (doc.choices === 'modes') options.push(...sources.modes.map((m) => word(m.id, m.name)));
            else if (doc.choices) options.push(...doc.choices.map((c) => word(c)));
            if (spot.key === 'source' && spot.table === 'song') options.push(...(await sources.songs()).map((s) => word(s)));
            if (!spot.quoted && !spot.inList) options.push(...(doc.literals ?? []).map((l) => ({label: l, type: 'keyword'})));
            if (options.length === 0) return null;
            return {from: spot.from, options, validFor: spot.quoted ? /^[^"]*$/ : /^[\w-]*$/};
        }
        return null;
    };
}

/** Hover a key for what it does and the values it takes. */
export function hover(sources: AssistSources) {
    return [hoverTheme, hoverTooltip((view, pos): Tooltip | null => {
        const line = view.state.doc.lineAt(pos);
        const at = pos - line.from;
        const m = /[\w-]+/g;
        let hit: RegExpExecArray | null;
        while ((hit = m.exec(line.text))) {
            if (hit.index > at || hit.index + hit[0].length < at) continue;
            // A key: the word followed by `=`.
            if (!/^\s*=/.test(line.text.slice(hit.index + hit[0].length))) return null;
            const spot = spotAt(view.state.doc.toString(), line.from + hit.index);
            const doc = keyDoc(spot.table, hit[0]);
            if (!doc) return null;
            const values = doc.choices === 'modes' ? sources.modes.map((x) => x.id) : doc.choices ?? [];
            const all = [...values.map((v) => `"${v}"`), ...(doc.literals ?? [])];
            return {
                pos: line.from + hit.index,
                end: line.from + hit.index + hit[0].length,
                above: true,
                create: () => {
                    // The song editor's hover look (editor-completions.ts).
                    const dom = document.createElement('div');
                    dom.className = 'cm-strudel-hover';
                    const line = (className: string, text: string) => {
                        const el = document.createElement('div');
                        el.className = className;
                        el.textContent = text;
                        dom.append(el);
                    };
                    line('cm-strudel-hover-sig', hit![0]);
                    line('cm-strudel-hover-info', doc.doc);
                    if (all.length) line('cm-strudel-hover-info', all.join('  '));
                    else if (doc.example) line('cm-strudel-hover-info', `${hit![0]} = ${doc.example}`);
                    return {dom};
                },
            };
        }
        return null;
    }, {hoverTime: 300})];
}
