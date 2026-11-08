/**
 * The backend commands the web build answers itself, so the file tree, songs,
 * shows and packs work unchanged in a browser.
 *
 * The library is a read-only copy published next to the app
 * (`<base>library/`, listed in `<base>library/index.json`). Writes don't exist
 * here; their controls are hidden in the web build (`web.css`).
 *
 * index.json:
 *   {files: string[]          paths relative to the library root, e.g. "Demos/Songs/opener.strudel"
 *    packs: {id, path}[]}     built visualizer packs (`dist/index.js`), path relative to the root
 */

import type {FileDoc, Frontmatter, VizPackSource} from './types/tauri-commands.js';

/** The virtual root the app sees; paths under it map to `<base>library/`. */
export const WEB_LIBRARY_ROOT = '/Library';

const BASE = `${import.meta.env.BASE_URL}library/`;

interface Index {
    files: string[];
    packs: {id: string; path: string}[];
}

interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number | null;
    modified_ms: number | null;
}

let index: Promise<Index> | null = null;
const loadIndex = () => (index ??= fetch(`${BASE}index.json`).then((r) => {
    if (!r.ok) throw new Error(`library index: ${r.status}`);
    return r.json() as Promise<Index>;
}));

/** "/Library/Demos/a.strudel" → "Demos/a.strudel"; refuses anything outside the root. */
function relative(path: string): string {
    const parts: string[] = [];
    const rel = path.startsWith(`${WEB_LIBRARY_ROOT}/`) ? path.slice(WEB_LIBRARY_ROOT.length + 1)
        : path === WEB_LIBRARY_ROOT ? '' : path;
    for (const part of rel.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.pop()) throw new Error(`'${path}' is outside the library`);
        } else parts.push(part);
    }
    return parts.join('/');
}

async function readText(path: string): Promise<string> {
    const rel = relative(path);
    const res = await fetch(BASE + rel.split('/').map(encodeURIComponent).join('/'));
    if (!res.ok) throw new Error(`${rel}: not found`);
    return res.text();
}

/** The frontmatter fields the app reads (mirrors src-tauri/src/files.rs). */
function splitFrontmatter(raw: string): {frontmatter: Frontmatter | null; code: string} {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return {frontmatter: null, code: raw};
    const fields: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    const bpm = Number(fields.bpm);
    return {
        frontmatter: {
            name: fields.name ?? null,
            bpm: Number.isFinite(bpm) ? bpm : null,
            tags: fields.tags?.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean) ?? [],
            created: fields.created ?? null,
        } as Frontmatter,
        code: raw.slice(m[0].length),
    };
}

async function readDoc(path: string): Promise<FileDoc> {
    const p = `${WEB_LIBRARY_ROOT}/${relative(path)}`;
    return {path: p, ...splitFrontmatter(await readText(p))};
}

async function listDir(path: string | undefined): Promise<DirEntry[]> {
    const dir = path ? relative(path) : '';
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, DirEntry>();
    for (const file of (await loadIndex()).files) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split('/');
        if (seen.has(name)) continue;
        seen.set(name, {
            name,
            path: `${WEB_LIBRARY_ROOT}/${prefix}${name}`,
            is_dir: rest.length > 0,
            size: null,
            modified_ms: null,
        });
    }
    // Folders first, then files, by name: the desktop explorer's order.
    return [...seen.values()].sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

interface LabeledSection {
    label: string;
    start_cycle: number;
    cycles: number;
}

/**
 * The song form a `pickRestart` selector declares. A port of
 * `pickrestart_sections` in crates/cycletron-analysis/src/form.rs, which the
 * desktop runs in Rust; keep the two in step (recorded as debt in
 * docs/CYCLETRON_SITE_PLAN.md).
 */
export function songForm(code: string): LabeledSection[] | null {
    const pr = code.indexOf('.pickRestart(');
    if (pr < 0) return null;
    const before = code.slice(0, pr);

    // Labels: the last `<…>` before `.pickRestart(`. `label!N` and `label@N`
    // both occupy N slots (bare `label!` is 2); other modifiers are stripped;
    // tokens without a letter (`<0 2 4>`) aren't labels.
    const open = before.lastIndexOf('<');
    if (open < 0) return null;
    const closeRel = before.slice(open).indexOf('>');
    if (closeRel < 0) return null;
    const labels: string[] = [];
    for (const t of before.slice(open + 1, open + closeRel).split(/\s+/).filter(Boolean)) {
        const base = t.split(/[@*!(:]/)[0].trim();
        const i = t.search(/[!@]/);
        const digits = i >= 0 ? t.slice(i + 1).match(/^\d+/)?.[0] : undefined;
        const reps = i < 0 ? 1 : digits ? Number(digits) : t[i] === '!' ? 2 : 1;
        if (base && /[A-Za-z]/.test(base)) for (let k = 0; k < reps; k++) labels.push(base);
    }
    if (labels.length < 2) return null;

    // Section length: `.slow(n)` between the selector's `>` and `.pickRestart(`.
    const close = before.lastIndexOf('>');
    const tail = before.slice(close);
    const s = tail.indexOf('.slow(');
    if (s < 0) return null;
    const rest = tail.slice(s + '.slow('.length);
    const end = rest.indexOf(')');
    if (end < 0) return null;
    const n = Number(rest.slice(0, end).trim());
    if (!Number.isFinite(n) || n < 1) return null;
    const slow = Math.round(n);

    // Merge consecutive repeats: <a a b> = a × 2n, b × n.
    const sections: LabeledSection[] = [];
    let start = 0;
    for (let i = 0; i < labels.length;) {
        let j = i + 1;
        while (j < labels.length && labels[j] === labels[i]) j++;
        const cycles = (j - i) * slow;
        sections.push({label: labels[i], start_cycle: start, cycles});
        start += cycles;
        i = j;
    }
    return sections;
}

type Handler = (args: Record<string, any>) => Promise<unknown>;

const COMMANDS: Record<string, Handler> = {
    get_library_root: async () => WEB_LIBRARY_ROOT,
    list_library: async ({path}) => listDir(path),
    open_file: async ({path}) => readDoc(path),
    read_song: async ({path}) => readDoc(path),
    read_text: async ({path}) => readText(path),
    list_library_songs: async () =>
        (await loadIndex()).files.filter((f) => /\.(strudel|js)$/.test(f)).map((f) => `${WEB_LIBRARY_ROOT}/${f}`),
    list_viz_packs: async (): Promise<VizPackSource[]> => Promise.all(
        (await loadIndex()).packs.map(async ({id, path}) => ({
            id,
            path: `${WEB_LIBRARY_ROOT}/${path}`,
            source: await readText(`${WEB_LIBRARY_ROOT}/${path}`),
        })),
    ),
    song_form: async ({code}) => songForm(code),
    get_recents: async () => [],
    get_current_file: async () => ({path: null, name: null, saved_code: null}),
};

/** Answer a backend command in the web build, or `undefined` if it isn't one it answers. */
export function webCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | undefined {
    const handler = COMMANDS[cmd];
    return handler ? (handler(args ?? {}) as Promise<T>) : undefined;
}
