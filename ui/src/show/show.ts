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
 * never ignored. The keys and values allowed are in `schema.ts`.
 */

import {parse, TomlError} from 'smol-toml';
import {CAMERA_MOVES, type CameraMove, type CameraStyle, DEFAULT_CAMERA} from '../viz/edit.js';
import {PALETTES} from '../viz/palettes.js';
import type {CodePlace} from '../viz/stage/code-layer.js';
import {type Transition, TRANSITION_BARS, TRANSITION_KINDS, type TransitionKind} from '../viz/transitions.js';
import {CAPTION_PLACES, CAPTION_STYLES, closest, CODE_FOLLOW, CODE_PLACES, keysOf, STROBE_ON} from './schema.js';

/** How the code shows over the visuals: hidden, or following the music (`off` shows it all, still). */
export type CodeFollow = typeof CODE_FOLLOW[number];

/** How a section shows the song's code. */
export interface CodeLook {
    follow: CodeFollow;
    /** Text size at 1080p, or null for Stage Mode's own. */
    size: number | null;
    place: CodePlace;
    /** 0 to 1, over the code's own. */
    opacity: number;
    /** The dark backing behind each row. */
    scrim: boolean;
    /** Bars the code takes to type in from the section's downbeat, or null to show it whole. */
    type: number | null;
}

const PLAIN_CODE: CodeLook = {follow: 'off', size: null, place: 'left', opacity: 1, scrim: true, type: null};

/** What one section shows. */
export interface Look {
    mode: string;
    code: CodeLook;
    /** How the camera moves over the mode, or null for no camera. */
    camera: CameraStyle | null;
    titles: boolean;
    /** The section's title card text; null for `// LABEL`. Set per section only, and turns its card on. */
    title: string | null;
    /** Modes to cut between, in turn, until the section ends; null to hold `mode`. */
    shots: Shot[] | null;
    /** Bars each shot holds when it doesn't say. */
    every: number;
    /** How each shot is entered. */
    transition: Transition;
    /** Named colors the visuals are drawn in (`neon` is the app's own). */
    palette: string;
    /** Frame aspect the letterbox bars crop to, or null for none. */
    letterbox: number | null;
    /** Film grain, 0 to 1. */
    grain: number;
    scanlines: boolean;
    /** Flashes on each hit of a drum, or each beat; null for none. */
    strobe: Strobe | null;
    /** How fast the visuals move, against the music's own pace (1). */
    speed: number;
    /** Words on screen during the section. Set per section only. */
    text: Caption[];
}

export interface Strobe {
    on: typeof STROBE_ON[number];
    /** 0 to 1; 1 is a full white flash. */
    strength: number;
}

/** A line of words on screen. */
export interface Caption {
    /** Bars into the section it appears. */
    at: number;
    say: string;
    /** Bars it holds before fading. */
    hold: number;
    place: typeof CAPTION_PLACES[number];
    /** A caption, or a big glitching card like a title. */
    style: typeof CAPTION_STYLES[number];
}

/** One shot of a section's `shots`. */
export interface Shot {
    mode: string;
    /** Bars it holds; null for the look's `every`. */
    bars: number | null;
    /** Its own camera, or undefined for the section's. */
    camera?: CameraStyle | null;
    /** Its own palette, or undefined for the section's. */
    palette?: string;
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
    /** Bars the song fades up from black at its start, and down to black at its last pass's end. */
    fade: {in: number; out: number};
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

const NO_TRANSITION: Transition = {kind: 'cut', bars: 0};

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
    only(show, 'show', keysOf('show'));
    const defaults = table(doc.defaults ?? {}, 'defaults');
    only(defaults, 'defaults', keysOf('defaults'));
    // Checked once, here, whether or not a song overrides them.
    const base: SongDefaults = {
        look: overlay({
            mode: '', code: PLAIN_CODE, camera: null, titles: false, title: null, shots: null, every: 4, transition: NO_TRANSITION,
            palette: 'neon', letterbox: null, grain: 0, scanlines: true, strobe: null, speed: 1, text: [],
        }, defaults, 'defaults'),
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
    only(song, at, keysOf('song'));

    // A song cutting between shots needs no mode of its own: its first shot's stands in.
    const songLook = overlay({...defaults.look}, song, at);
    if (song.shots !== undefined) songLook.shots = shots(song.shots, songLook.camera, `${at}.shots`, ctx);
    songLook.mode = song.mode === undefined && songLook.shots ? songLook.shots[0].mode : modeId(song.mode, `${at}.mode`, ctx);

    const sections = new Map<string, Look>();
    for (const [label, value] of Object.entries(table(song.sections ?? {}, `${at}.sections`))) {
        const entryAt = `${at}.sections.${label}`;
        if (typeof value === 'string') {
            sections.set(label, {...songLook, mode: modeId(value, entryAt, ctx), shots: null});
            continue;
        }
        const t = table(value, entryAt);
        only(t, entryAt, keysOf('section'));
        if (t.mode !== undefined && t.shots !== undefined) throw new ShowError(`${entryAt}.shots`, 'give a mode or shots, not both');
        const look = overlay(songLook, t, entryAt);
        // A section's own mode holds through it, over any shots the song cuts between.
        if (t.mode !== undefined) look.mode = modeId(t.mode, `${entryAt}.mode`, ctx);
        if (t.mode !== undefined) look.shots = null;
        if (t.shots !== undefined) look.shots = shots(t.shots, look.camera, `${entryAt}.shots`, ctx);
        if (t.text !== undefined) look.text = captions(t.text, `${entryAt}.text`);
        // Naming a section's card shows it, even where the cards are off.
        if (t.title !== undefined) {
            look.title = str(t.title, `${entryAt}.title`);
            if (t.titles === undefined) look.titles = true;
        }
        sections.set(label, look);
    }

    return {
        index,
        source: resolvePath(str(song.source, `${at}.source`), ctx),
        passes: song.passes === undefined ? 1 : positiveInt(song.passes, `${at}.passes`),
        fade: fade(song.fade, `${at}.fade`),
        performance: optional(song.performance, `${at}.performance`, (v, p) => resolvePath(str(v, p), ctx)),
        gainDb: song.gain_db === undefined ? defaults.gainDb : num(song.gain_db, `${at}.gain_db`),
        sensitivity: song.sensitivity === undefined ? defaults.sensitivity : num(song.sensitivity, `${at}.sensitivity`),
        look: songLook,
        sections,
    };
}

/** A new show file playing `source` (a path relative to the show). */
export function newShowText(source: string): string {
    return `# Help → Shows has the format. ⌃Space suggests keys and values here.

[[song]]
source = ${JSON.stringify(source)}
mode = "tunnel"
`;
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
    if (t.code !== undefined) next.code = code(t.code, look.code, `${at}.code`);
    if (t.camera !== undefined) next.camera = parseCamera(t.camera, look.camera, `${at}.camera`);
    if (t.titles !== undefined) next.titles = bool(t.titles, `${at}.titles`);
    if (t.every !== undefined) next.every = bars(t.every, `${at}.every`);
    if (t.transition !== undefined) next.transition = transition(t.transition, `${at}.transition`);
    if (t.palette !== undefined) next.palette = palette(t.palette, `${at}.palette`);
    if (t.letterbox !== undefined) next.letterbox = letterbox(t.letterbox, `${at}.letterbox`);
    if (t.grain !== undefined) next.grain = fraction(t.grain, `${at}.grain`);
    if (t.scanlines !== undefined) next.scanlines = bool(t.scanlines, `${at}.scanlines`);
    if (t.strobe !== undefined) next.strobe = strobe(t.strobe, `${at}.strobe`);
    if (t.speed !== undefined) {
        next.speed = num(t.speed, `${at}.speed`);
        if (next.speed < 0 || next.speed > 4) throw new ShowError(`${at}.speed`, `expected 0 (frozen) to 4, not ${next.speed}`);
    }
    return next;
}

/**
 * `true` / `false`, a move (`"orbit"`), or a table of `move`, `punch` and
 * `kick`; whatever is left out comes from the layer below, or the default.
 */
function parseCamera(v: unknown, below: CameraStyle | null, at: string): CameraStyle | null {
    if (v === false) return null;
    const base = below ?? DEFAULT_CAMERA;
    if (v === true) return base;
    if (typeof v === 'string') return {...base, move: cameraMove(v, at)};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new ShowError(at, `expected true, false, a move (${CAMERA_MOVES.join(', ')}), or a table of move, punch, kick`);
    }
    const t = v as Table;
    only(t, at, keysOf('camera'));
    return {
        move: t.move === undefined ? base.move : cameraMove(t.move, `${at}.move`),
        punch: t.punch === undefined ? base.punch : strength(t.punch, `${at}.punch`),
        kick: t.kick === undefined ? base.kick : strength(t.kick, `${at}.kick`),
    };
}

/** A list of mode ids, or of `{mode, bars, camera}` tables, in the order they cut. */
function shots(v: unknown, camera: CameraStyle | null, at: string, ctx: ShowContext): Shot[] {
    if (!Array.isArray(v) || v.length === 0) throw new ShowError(at, 'expected a list of modes, like ["tunnel", "plasma"]');
    return v.map((entry, i) => {
        const shotAt = `${at}[${i}]`;
        if (typeof entry === 'string') return {mode: modeId(entry, shotAt, ctx), bars: null};
        const t = table(entry, shotAt);
        only(t, shotAt, keysOf('shot'));
        const shot: Shot = {mode: modeId(t.mode, `${shotAt}.mode`, ctx), bars: t.bars === undefined ? null : bars(t.bars, `${shotAt}.bars`)};
        if (t.camera !== undefined) shot.camera = parseCamera(t.camera, camera, `${shotAt}.camera`);
        if (t.palette !== undefined) shot.palette = palette(t.palette, `${shotAt}.palette`);
        return shot;
    });
}

/** A kind (`"flash"`) over its usual bars, or `{kind, bars}`. */
function transition(v: unknown, at: string): Transition {
    if (typeof v === 'string') return {kind: transitionKind(v, at), bars: TRANSITION_BARS[transitionKind(v, at)]};
    const t = table(v, at);
    only(t, at, keysOf('transition'));
    const kind = transitionKind(t.kind, `${at}.kind`);
    return {kind, bars: t.bars === undefined ? TRANSITION_BARS[kind] : bars(t.bars, `${at}.bars`)};
}

function transitionKind(v: unknown, at: string): TransitionKind {
    if (!TRANSITION_KINDS.includes(v as TransitionKind)) throw new ShowError(at, notOneOf(TRANSITION_KINDS, v));
    return v as TransitionKind;
}

/** A length in bars: more than none, at most 64; quarters and the like are fine. */
function bars(v: unknown, at: string): number {
    const n = num(v, at);
    if (n <= 0 || n > 64) throw new ShowError(at, `expected bars, more than 0 and at most 64, not ${n}`);
    return n;
}

/** A follow (`"solo"`), or a table of `follow`, `size`, `place`, `opacity`, `scrim` and `type` over the layer below. */
function code(v: unknown, below: CodeLook, at: string): CodeLook {
    const follow = (w: unknown, wAt: string): CodeFollow => {
        if (!CODE_FOLLOW.includes(w as CodeFollow)) throw new ShowError(wAt, notOneOf(CODE_FOLLOW, w));
        return w as CodeFollow;
    };
    if (typeof v === 'string') return {...below, follow: follow(v, at)};
    const t = table(v, at);
    only(t, at, keysOf('code'));
    const next = {...below};
    if (t.follow !== undefined) next.follow = follow(t.follow, `${at}.follow`);
    if (t.size !== undefined) {
        next.size = num(t.size, `${at}.size`);
        if (next.size < 10 || next.size > 96) throw new ShowError(`${at}.size`, `expected 10 to 96 (px at 1080p), not ${next.size}`);
    }
    if (t.place !== undefined) {
        if (!CODE_PLACES.includes(t.place as CodePlace)) {
            throw new ShowError(`${at}.place`, notOneOf(CODE_PLACES, t.place));
        }
        next.place = t.place as CodePlace;
    }
    if (t.opacity !== undefined) next.opacity = fraction(t.opacity, `${at}.opacity`);
    if (t.scrim !== undefined) next.scrim = bool(t.scrim, `${at}.scrim`);
    if (t.type !== undefined) next.type = t.type === false ? null : bars(t.type, `${at}.type`);
    return next;
}

/** A drum or `beat` at full strength, a table of `on` and `strength`, or false for none. */
function strobe(v: unknown, at: string): Strobe | null {
    if (v === false) return null;
    const on = (w: unknown, wAt: string) => {
        if (!STROBE_ON.includes(w as Strobe['on'])) throw new ShowError(wAt, notOneOf(STROBE_ON, w));
        return w as Strobe['on'];
    };
    if (typeof v === 'string') return {on: on(v, at), strength: 0.6};
    const t = table(v, at);
    only(t, at, keysOf('strobe'));
    return {on: on(t.on, `${at}.on`), strength: t.strength === undefined ? 0.6 : fraction(t.strength, `${at}.strength`)};
}

/** A list of `{say, at, hold, place, style}`; `at` defaults to the downbeat, `hold` to 2 bars. */
function captions(v: unknown, at: string): Caption[] {
    if (!Array.isArray(v)) throw new ShowError(at, 'expected a list of { say = "…", at = 2 }');
    return v.map((entry, i) => {
        const lineAt = `${at}[${i}]`;
        const t = table(entry, lineAt);
        only(t, lineAt, keysOf('caption'));
        const style = t.style ?? 'line';
        if (!CAPTION_STYLES.includes(style as Caption['style'])) {
            throw new ShowError(`${lineAt}.style`, notOneOf(CAPTION_STYLES, style));
        }
        // A card sits in the middle unless placed; a line, at the bottom.
        const place = t.place ?? (style === 'card' ? 'center' : 'bottom');
        if (!CAPTION_PLACES.includes(place as Caption['place'])) {
            throw new ShowError(`${lineAt}.place`, notOneOf(CAPTION_PLACES, place));
        }
        const start = t.at === undefined ? 0 : num(t.at, `${lineAt}.at`);
        if (start < 0) throw new ShowError(`${lineAt}.at`, `expected bars into the section, not ${start}`);
        return {say: str(t.say, `${lineAt}.say`), at: start, hold: t.hold === undefined ? 2 : bars(t.hold, `${lineAt}.hold`),
            place: place as Caption['place'], style: style as Caption['style']};
    });
}

/** `{in, out}` in bars; either may be left out (none). */
function fade(v: unknown, at: string): {in: number; out: number} {
    if (v === undefined) return {in: 0, out: 0};
    const t = table(v, at);
    only(t, at, keysOf('fade'));
    return {in: t.in === undefined ? 0 : bars(t.in, `${at}.in`), out: t.out === undefined ? 0 : bars(t.out, `${at}.out`)};
}

function palette(v: unknown, at: string): string {
    if (!PALETTES.includes(v as string)) throw new ShowError(at, notOneOf(PALETTES, v));
    return v as string;
}

/** An aspect ratio wider than square (2.39 is scope), or false for none. */
function letterbox(v: unknown, at: string): number | null {
    if (v === false) return null;
    const n = num(v, at);
    if (n <= 1 || n > 4) throw new ShowError(at, `expected an aspect like 2.39 (more than 1, at most 4), or false — not ${n}`);
    return n;
}

function fraction(v: unknown, at: string): number {
    const n = num(v, at);
    if (n < 0 || n > 1) throw new ShowError(at, `expected 0 to 1, not ${n}`);
    return n;
}

function cameraMove(v: unknown, at: string): CameraMove {
    if (!CAMERA_MOVES.includes(v as CameraMove)) throw new ShowError(at, notOneOf(CAMERA_MOVES, v));
    return v as CameraMove;
}

/** A camera strength: 1 is the default, 0 none. */
function strength(v: unknown, at: string): number {
    const n = num(v, at);
    if (n < 0 || n > 4) throw new ShowError(at, `expected 0 to 4 (1 is the default), not ${n}`);
    return n;
}

function only(t: Table, at: string, keys: readonly string[]): void {
    for (const key of Object.keys(t)) {
        if (!keys.includes(key)) {
            const near = closest(key, keys);
            const guess = near ? `did you mean '${near}'? ` : '';
            throw new ShowError(at ? `${at}.${key}` : key, `unknown key; ${guess}(expected one of: ${keys.join(', ')})`);
        }
    }
}

/** The message for `v` not being one of `options`, with the nearest as a guess. */
function notOneOf(options: readonly string[], v: unknown): string {
    const near = typeof v === 'string' ? closest(v, options) : null;
    return `${near ? `did you mean "${near}"? ` : ''}${options.join(', ')} — not ${JSON.stringify(v)}`;
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
    if (!ctx.modes.includes(id)) {
        const near = closest(id, ctx.modes);
        throw new ShowError(at, `no mode '${id}'${near ? `; did you mean '${near}'?` : ''} (have: ${ctx.modes.join(', ')})`);
    }
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
