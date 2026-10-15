/**
 * Show files (`*.show.toml`): a song and the visuals each of its sections
 * shows. Parsing is pure — no DOM, no file access — so live playback and the
 * offline renderer resolve a show the same way. The song's sections are an
 * input: live they come from its form (`song_form`), offline from its
 * performance export, and both are the same `pickRestart` timing.
 *
 * Settings layer `[defaults]` → `[[song]]` → `[song.sections].<label>`. A
 * section entry is a mode id, or a table with an optional `mode` plus any
 * look key. Every unknown key or bad value fails with its path; a typo is
 * never ignored.
 */

import {parse, TomlError} from 'smol-toml';

export type CodeFollow = 'off' | 'fold' | 'solo';

/** What one section shows. */
export interface Look {
    mode: string;
    code: CodeFollow;
    camera: boolean;
    titles: boolean;
}

/** A section of the song's form, in cycles. */
export interface FormSection {
    label: string;
    startCycle: number;
    cycles: number;
}

/** A section of the song, cued with its look. */
export interface Cue extends FormSection {
    look: Look;
}

export interface ShowSong {
    /** Position in the setlist, for error paths (`song[1]…`). */
    index: number;
    /** Absolute path to the `.strudel` file. */
    source: string;
    /** Times through the song's form before the next song; the last song loops. */
    passes: number;
    /** Absolute path to the performance-export directory, if given. */
    performance: string | null;
    gainDb: number;
    sensitivity: number;
    /** The song-level look, for any section not listed. */
    look: Look;
    /** Looks by section label, as written; checked against the form by {@link cue}. */
    sections: Map<string, Look>;
}

export interface Show {
    title: string | null;
    /** Absolute output path for a render, if given. */
    out: string | null;
    size: {width: number; height: number} | null;
    fps: number | null;
    /** The setlist, in order. */
    songs: ShowSong[];
}

export interface ShowContext {
    /** Directory the show file is in; relative paths resolve against it. */
    dir: string;
    /** The user's home directory, for `~`. */
    home: string;
    /** Valid mode ids. */
    modes: readonly string[];
}

/** A mistake in a show, at `path` (`song[0].sections.drop.code`), or at `line` for TOML syntax. */
export class ShowError extends Error {
    constructor(readonly path: string, readonly detail: string, readonly line: number | null = null) {
        super(path ? `${path}: ${detail}` : detail);
    }
}

const CODE_FOLLOW: readonly CodeFollow[] = ['off', 'fold', 'solo'];
const LOOK_KEYS = ['code', 'camera', 'titles'] as const;
const AUDIO_KEYS = ['gain_db', 'sensitivity'] as const;

type Table = Record<string, unknown>;

export function parseShow(text: string, ctx: ShowContext): Show {
    let doc: Table;
    try {
        doc = parse(text);
    } catch (e) {
        // The line is marked; smol-toml's excerpt under the message would only repeat it.
        throw e instanceof TomlError ? new ShowError('', e.message.split('\n')[0], e.line) : new ShowError('', String(e));
    }
    only(doc, '', ['show', 'defaults', 'song']);

    const show = table(doc.show ?? {}, 'show');
    only(show, 'show', ['title', 'out', 'size', 'fps']);
    const defaults = table(doc.defaults ?? {}, 'defaults');
    only(defaults, 'defaults', [...LOOK_KEYS, ...AUDIO_KEYS]);
    // Checked once, here, whether or not a song overrides them.
    const base: SongDefaults = {
        look: overlay({mode: '', code: 'off', camera: false, titles: false}, defaults, 'defaults'),
        gainDb: num(defaults.gain_db ?? 0, 'defaults.gain_db'),
        sensitivity: num(defaults.sensitivity ?? 1, 'defaults.sensitivity'),
    };

    if (!Array.isArray(doc.song) || doc.song.length === 0) throw new ShowError('song', 'a show needs at least one [[song]]');

    return {
        title: optional(show.title, 'show.title', str),
        out: optional(show.out, 'show.out', (v, at) => resolvePath(str(v, at), ctx)),
        size: optional(show.size, 'show.size', size),
        fps: optional(show.fps, 'show.fps', positiveInt),
        songs: doc.song.map((entry, i) => parseSong(entry, i, base, ctx)),
    };
}

/** `[defaults]`, checked: what a song inherits. */
interface SongDefaults {
    look: Look;
    gainDb: number;
    sensitivity: number;
}

function parseSong(entry: unknown, index: number, defaults: SongDefaults, ctx: ShowContext): ShowSong {
    const at = `song[${index}]`;
    const song = table(entry, at);
    only(song, at, ['source', 'performance', 'mode', 'passes', 'transition', 'sections', ...LOOK_KEYS, ...AUDIO_KEYS]);
    // Cuts land on the downbeat; flash and the rest come later.
    if (song.transition !== undefined && song.transition !== 'cut') {
        throw new ShowError(`${at}.transition`, `only "cut" so far, not ${JSON.stringify(song.transition)}`);
    }

    const songLook = overlay({...defaults.look, mode: modeId(song.mode, `${at}.mode`, ctx)}, song, at);

    const sections = new Map<string, Look>();
    for (const [label, value] of Object.entries(table(song.sections ?? {}, `${at}.sections`))) {
        const entryAt = `${at}.sections.${label}`;
        if (typeof value === 'string') {
            sections.set(label, {...songLook, mode: modeId(value, entryAt, ctx)});
            continue;
        }
        const t = table(value, entryAt);
        only(t, entryAt, ['mode', ...LOOK_KEYS]);
        const look = overlay(songLook, t, entryAt);
        if (t.mode !== undefined) look.mode = modeId(t.mode, `${entryAt}.mode`, ctx);
        sections.set(label, look);
    }

    return {
        index,
        source: resolvePath(str(song.source, `${at}.source`), ctx),
        passes: song.passes === undefined ? 1 : positiveInt(song.passes, `${at}.passes`),
        performance: optional(song.performance, `${at}.performance`, (v, p) => resolvePath(str(v, p), ctx)),
        gainDb: song.gain_db === undefined ? defaults.gainDb : num(song.gain_db, `${at}.gain_db`),
        sensitivity: song.sensitivity === undefined ? defaults.sensitivity : num(song.sensitivity, `${at}.sensitivity`),
        look: songLook,
        sections,
    };
}

/** Cue the song's form: each section with its look. Every listed label must be in the form. */
export function cue(song: ShowSong, form: readonly FormSection[]): Cue[] {
    for (const label of song.sections.keys()) {
        if (!form.some((s) => s.label === label)) {
            throw new ShowError(`song[${song.index}].sections.${label}`, `the song has no section '${label}' (it has: ${form.map((s) => s.label).join(', ')})`);
        }
    }
    return form.map((s) => ({...s, look: song.sections.get(s.label) ?? song.look}));
}

/** Cycles in one pass through the form. */
export function formLength(cues: readonly Cue[]): number {
    const last = cues[cues.length - 1];
    return last.startCycle + last.cycles;
}

/** The cue playing at `cycle`; the form loops, as the song's selector does. */
export function cueAt(cues: readonly Cue[], cycle: number): Cue {
    const total = formLength(cues);
    const at = ((cycle % total) + total) % total;
    let i = 0;
    while (i + 1 < cues.length && cues[i + 1].startCycle <= at) i++;
    return cues[i];
}

// ---- values -----------------------------------------------------------------

function overlay(look: Look, t: Table, at: string): Look {
    const next = {...look};
    if (t.code !== undefined) {
        if (!CODE_FOLLOW.includes(t.code as CodeFollow)) {
            throw new ShowError(`${at}.code`, `${CODE_FOLLOW.join(', ')} — not ${JSON.stringify(t.code)}`);
        }
        next.code = t.code as CodeFollow;
    }
    if (t.camera !== undefined) next.camera = bool(t.camera, `${at}.camera`);
    if (t.titles !== undefined) next.titles = bool(t.titles, `${at}.titles`);
    return next;
}

function only(t: Table, at: string, keys: readonly string[]): void {
    for (const key of Object.keys(t)) {
        if (!keys.includes(key)) {
            throw new ShowError(at ? `${at}.${key}` : key, `unknown key (expected one of: ${keys.join(', ')})`);
        }
    }
}

function table(v: unknown, at: string): Table {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ShowError(at, `expected a table`);
    return v as Table;
}

function optional<T>(v: unknown, at: string, read: (v: unknown, at: string) => T): T | null {
    return v === undefined ? null : read(v, at);
}

function str(v: unknown, at: string): string {
    if (typeof v !== 'string' || v === '') throw new ShowError(at, `expected a string`);
    return v;
}

function num(v: unknown, at: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShowError(at, `expected a number`);
    return v;
}

function bool(v: unknown, at: string): boolean {
    if (typeof v !== 'boolean') throw new ShowError(at, `expected true or false`);
    return v;
}

function positiveInt(v: unknown, at: string): number {
    if (!Number.isInteger(v) || (v as number) <= 0) throw new ShowError(at, `expected a positive whole number`);
    return v as number;
}

function size(v: unknown, at: string): {width: number; height: number} {
    const m = /^([1-9]\d*)x([1-9]\d*)$/.exec(str(v, at));
    if (!m) throw new ShowError(at, `expected WIDTHxHEIGHT, like "1920x1080"`);
    return {width: Number(m[1]), height: Number(m[2])};
}

function modeId(v: unknown, at: string, ctx: ShowContext): string {
    const id = str(v, at);
    if (!ctx.modes.includes(id)) throw new ShowError(at, `no mode '${id}' (have: ${ctx.modes.join(', ')})`);
    return id;
}

/**
 * `~/x` → home, absolute stays, anything else is relative to the show file;
 * `.` and `..` collapse. Either separator is accepted, and `/` is written.
 */
function resolvePath(p: string, ctx: ShowContext): string {
    if (p === '~' || /^~[\\/]/.test(p)) return normalize(`${ctx.home}/${p.slice(2)}`);
    // POSIX root, Windows drive, or UNC share.
    if (/^([\\/]|[A-Za-z]:[\\/])/.test(p)) return normalize(p);
    return normalize(`${ctx.dir}/${p}`);
}

function normalize(p: string): string {
    // `/`, `C:/` or `//` (a UNC share), with `\` read as `/`.
    const root = /^(?:[A-Za-z]:)?[\\/]{0,2}/.exec(p)![0];
    const out: string[] = [];
    for (const part of p.slice(root.length).split(/[\\/]+/)) {
        if (part === '' || part === '.') continue;
        if (part !== '..') out.push(part);
        else if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!root) out.push(part);
    }
    return root.replace(/\\/g, '/') + out.join('/');
}
