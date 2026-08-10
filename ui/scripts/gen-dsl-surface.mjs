#!/usr/bin/env node
/**
 * Build-time extractor: parse `docs/STRUDEL_RS_SUPPORTED.md` — the ground-truth
 * DSL surface — into a typed symbol table for editor autocomplete + hover docs.
 *
 * Outputs (both checked in; regenerate with `npm run gen:dsl`):
 *   - `ui/src/generated/dsl-surface.ts`   — consumed by the editor (TypeScript).
 *   - `ui/src/generated/dsl-surface.json` — consumed by the Rust agent via
 *     `include_str!` (see `crates/cycletron-analysis/src/methods.rs`), so the
 *     `list_methods` tool and the editor completions share ONE source of truth.
 *
 * Keeping the table generated means it can never drift from the doc that the
 * validator is verified against — the whole point of sourcing completions from
 * the ground truth rather than hand-maintaining a second list.
 *
 * Zero deps: a small line-oriented scan, not a full markdown AST. It harvests
 * backticked symbols from the sections that actually define the surface and
 * ignores the prose-heavy ones (source-file list, samples narrative, gotchas).
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(HERE, '../../docs/STRUDEL_RS_SUPPORTED.md');
const OUT = resolve(HERE, '../src/generated/dsl-surface.ts');
const OUT_JSON = resolve(HERE, '../src/generated/dsl-surface.json');

/**
 * `## heading` prefix → symbol kind. Only these sections are harvested; a
 * section whose heading matches no prefix is skipped entirely. Prefix match so
 * the backticks in "Synth names (the `s(\"…\")` registry)" don't matter.
 */
const SECTIONS = [
    {prefix: 'File-level directives', kind: 'keyword'},
    {prefix: 'Free functions', kind: 'function'},
    {prefix: 'Pattern methods', kind: 'method'},
    {prefix: 'Synth names', kind: 'sound'},
];

function sectionKind(h2) {
    const found = SECTIONS.find((s) => h2.startsWith(s.prefix));
    return found ? found.kind : null;
}

/** Clean a markdown table cell / doc string down to a single plain-text line. */
function cleanDoc(text) {
    return text
        .replace(/\\\|/g, '|')       // unescape table-escaped pipes
        .replace(/`([^`]*)`/g, '$1') // drop code ticks
        .replace(/\*\*/g, '')        // drop bold
        .replace(/\s+/g, ' ')
        .trim();
}

/** All backtick code spans on a line, in order. */
function codeSpans(line) {
    const out = [];
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push(m[1]);
    return out;
}

/**
 * Parse a code span into {name, signature}. Returns null unless the span leads
 * with an identifier — so operators (`*N`, `?P`, `{ } % N`) are skipped.
 * `every(n, fn)` → {name:'every', signature:'every(n, fn)'};  `firstOf` → bare.
 */
function parseSymbol(span) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^`]*)\))?/.exec(span);
    if (!m) return null;
    const name = m[1];
    const signature = m[2] ? `${name}(${m[3].trim()})` : name;
    return {name, signature};
}

const doc = readFileSync(DOC, 'utf8');
const lines = doc.split('\n');

/** name → {label, detail, info, kind, specific} — richest entry wins. */
const table = new Map();

let kind = null; // current section kind, or null when outside a harvested section
let h3 = '';     // current ### subheading (used as fallback doc for prose lists)

function record(sym, info, specific, symbolKind) {
    if (!sym) return;
    const prev = table.get(sym.name);
    const next = {
        label: sym.name,
        detail: sym.signature,
        info: info || '',
        kind: symbolKind,
        specific,
    };
    if (!prev) {
        table.set(sym.name, next);
        return;
    }
    // Prefer a signature that carries args, and a section-specific doc over a
    // generic heading fallback.
    const better =
        (next.detail.includes('(') && !prev.detail.includes('(')) ||
        (next.specific && !prev.specific);
    if (better) {
        // Keep the richest of each field rather than clobbering wholesale.
        prev.detail = next.detail.includes('(') ? next.detail : prev.detail;
        if (next.specific) prev.info = next.info;
        prev.specific = prev.specific || next.specific;
    }
}

for (const raw of lines) {
    const line = raw.trimEnd();

    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
        // Headings are numbered ("## 3. Free functions …") — drop the "N." first.
        kind = sectionKind(h2[1].replace(/^\d+\.\s*/, '').trim());
        h3 = '';
        continue;
    }
    const h3m = /^###\s+(.*)$/.exec(line);
    if (h3m) {
        h3 = cleanDoc(h3m[1]);
        continue;
    }
    if (!kind) continue;

    // Table row (not the `| --- |` separator).
    if (line.startsWith('|') && !/^\|[\s|:-]+\|?$/.test(line)) {
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length < 2) continue;
        const info = cleanDoc(cells[cells.length - 1]);
        for (const span of codeSpans(cells[0])) {
            record(parseSymbol(span), info, true, kind);
        }
        continue;
    }

    // Prose is only a symbol list in the Pattern-methods section (the others are
    // tables). Even there, harvest only *span-dense* lines — the comma-separated
    // method lists — so intro sentences that merely cite source files
    // (`pattern.rs`, `getCurrentBpmPtr()`) don't leak in as symbols.
    if (kind !== 'method') continue;
    const spans = codeSpans(line);
    if (spans.length === 0) continue;
    const nonWs = line.replace(/\s/g, '').length;
    const spanChars = spans.reduce((n, s) => n + s.length + 2, 0);
    if (nonWs === 0 || spanChars / nonWs < 0.5) continue; // sentence, not a list
    for (const span of spans) {
        record(parseSymbol(span), h3, false, kind);
    }
}

const symbols = [...table.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({label, detail, info, kind}) => ({label, detail, info, kind}));

const banner = `// AUTO-GENERATED from docs/STRUDEL_RS_SUPPORTED.md — do not edit by hand.
// Regenerate with \`npm run gen:dsl\`. Sourced from the ground-truth DSL surface
// so completions/hover can never drift from what the validator accepts.`;

const body = `${banner}

export type DslKind = 'function' | 'method' | 'sound' | 'keyword';

export interface DslSymbol {
    /** Identifier to complete / look up on hover. */
    label: string;
    /** Signature, e.g. "every(n, fn)". Equals \`label\` when it takes no args. */
    detail: string;
    /** One-line description (section-specific where the doc had one). */
    info: string;
    kind: DslKind;
}

export const DSL_SYMBOLS: DslSymbol[] = ${JSON.stringify(symbols, null, 4)};
`;

mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, body);

// JSON twin for the Rust agent (`list_methods`). Same `symbols` array, so the
// two surfaces can never diverge. `include_str!`'d at compile time, so it must
// stay checked in alongside the .ts.
writeFileSync(OUT_JSON, JSON.stringify(symbols, null, 2) + '\n');

const rel = (p) => p.replace(resolve(HERE, '../..') + '/', '');
console.log(`gen-dsl-surface: wrote ${symbols.length} symbols → ${rel(OUT)} + ${rel(OUT_JSON)}`);
