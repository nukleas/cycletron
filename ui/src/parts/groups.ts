/**
 * The shelf as a tree: role, then where the part came from, then a cut that
 * suits the role (tempo for drums, key for pitched parts, genre for the
 * built-in ones), then the pack folder, then length in bars. A group small
 * enough to read lists its parts directly, best rated first.
 *
 * Kits sit above the roles: parts written to play together, by style.
 */

import type {Part} from './catalog.js';
import {ROLES, type Role} from './split.js';

export type Row =
    | {t: 'group'; id: string; label: string; count: number; open: boolean; depth: number; kit?: Part[]}
    | {t: 'part'; part: Part; depth: number};

/** A group this size or smaller is not split further. */
export const SPLIT_OVER = 24;

const ROLE_LABELS: Record<Role, string> = {
    drums: 'Drums',
    bass: 'Bass',
    chords: 'Chords',
    lead: 'Lead',
    other: 'Other',
};

const KITS = 'Kits';
/** Tags that mark a kit part as an alternative to play in place of the main one. */
const ALTERNATES = ['variation', 'fill'];
const MINE = 'My parts';
const RECIPES = 'Recipes';
const EXAMPLES = 'Examples';
const TEMPO_BAND = 20;
/** Smaller groups are gathered under one "other" row. */
const MIN_GROUP = 3;
const OTHER = 'other';
/** Where a part with no rating sorts: with the 3s. */
const UNRATED = 3;
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS: Record<string, string> = {Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#'};

interface Cut {
    label: string;
    /** Sort position among its siblings. */
    order: number | string;
}

/** Where the part came from: the user, an imported collection, or built in. */
function shelfOf(part: Part): Cut {
    if (part.source === 'recipe') return {label: RECIPES, order: '~1'};
    if (part.source === 'corpus') return {label: EXAMPLES, order: '~2'};
    return part.collection ? {label: part.collection, order: part.collection.toLowerCase()} : {label: MINE, order: ''};
}

function facetOf(part: Part): Cut {
    if (part.role === 'drums') {
        if (!part.bpm) return {label: 'no tempo', order: 1e6};
        const low = Math.floor(part.bpm / TEMPO_BAND) * TEMPO_BAND;
        return {label: `${low}–${low + TEMPO_BAND - 1} bpm`, order: low};
    }
    if (part.source !== 'mine') {
        return part.genre ? {label: part.genre, order: part.genre} : {label: 'general', order: ''};
    }
    const [root, mode] = (part.key ?? '').split(':');
    const at = ROOTS.indexOf(FLATS[root] ?? root);
    if (at < 0) return {label: 'no key', order: 1e6};
    return {label: `${root} ${mode ?? ''}`.trim(), order: at + (mode === 'major' ? 0 : 0.5)};
}

/** The pack folder a pitched part came from. Drum sets file by player, which says nothing. */
function folderOf(part: Part): Cut {
    if (part.role === 'drums' || !part.folder) return {label: 'unfiled', order: '~'};
    return {label: part.folder, order: part.folder.toLowerCase()};
}

function lengthOf(part: Part): Cut {
    if (!part.bars) return {label: 'any length', order: 1e6};
    return {label: part.bars === 1 ? '1 bar' : `${part.bars} bars`, order: part.bars};
}

function cut(parts: Part[], by: (p: Part) => Cut): {cut: Cut; parts: Part[]}[] {
    const groups = new Map<string, {cut: Cut; parts: Part[]}>();
    for (const part of parts) {
        const c = by(part);
        const group = groups.get(c.label) ?? {cut: c, parts: []};
        group.parts.push(part);
        groups.set(c.label, group);
    }
    // A group of one or two is not worth a row of its own.
    const other: Part[] = [];
    for (const [label, group] of groups) {
        if (group.parts.length >= MIN_GROUP) continue;
        other.push(...group.parts);
        groups.delete(label);
    }
    if (other.length) groups.set(OTHER, {cut: {label: OTHER, order: Infinity}, parts: other});
    return [...groups.values()].sort((a, b) => {
        const [x, y] = [a.cut.order, b.cut.order];
        if (typeof x === 'number' && typeof y === 'number') return x - y || a.cut.label.localeCompare(b.cut.label);
        if (typeof x === 'number' || typeof y === 'number') return typeof x === 'number' ? 1 : -1;
        return x.localeCompare(y);
    });
}

function slot(part: Part): number {
    return ALTERNATES.findIndex((tag) => part.tags?.includes(tag)) + 1;
}

/** A kit's parts in playing order: by role, the main part before its alternates. */
function kitOrder(parts: Part[]): Part[] {
    return [...parts].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || slot(a) - slot(b));
}

/** The parts that make the kit's groove when added together. */
export function kitCore(parts: Part[]): Part[] {
    return kitOrder(parts).filter((p) => slot(p) === 0);
}

/** Kits, grouped by the style they were written for. */
function kitRows(all: Part[], open: ReadonlySet<string>, rows: Row[]): void {
    const styles = new Map<string, Map<string, Part[]>>();
    for (const part of all) {
        if (!part.kit) continue;
        const style = part.collection ?? MINE;
        const kits = styles.get(style) ?? new Map<string, Part[]>();
        kits.set(part.kit, [...(kits.get(part.kit) ?? []), part]);
        styles.set(style, kits);
    }
    if (!styles.size) return;

    const group = (id: string, label: string, count: number, depth: number, kit?: Part[]): boolean => {
        rows.push({t: 'group', id, label, count, open: open.has(id), depth, kit});
        return open.has(id);
    };
    const total = [...styles.values()].reduce((n, kits) => n + kits.size, 0);
    if (!group('kits', KITS, total, 0)) return;
    for (const [style, kits] of [...styles].sort(([a], [b]) => a.localeCompare(b))) {
        if (!group(`kits/${style}`, style, kits.size, 1)) continue;
        for (const [name, parts] of [...kits].sort(([a], [b]) => a.localeCompare(b))) {
            if (!group(`kits/${style}/${name}`, name, parts.length, 2, kitCore(parts))) continue;
            for (const part of kitOrder(parts)) rows.push({t: 'part', part, depth: 3});
        }
    }
}

/** The visible rows, given which groups are open. */
export function shelfRows(all: Part[], open: ReadonlySet<string>): Row[] {
    const rows: Row[] = [];
    const levels = [shelfOf, facetOf, folderOf, lengthOf];

    // `level` is the next cut to try. One that puts everything in a single
    // group says nothing, so the one after it is tried instead.
    const walk = (parts: Part[], id: string, label: string, depth: number, level: number): void => {
        const isOpen = open.has(id);
        rows.push({t: 'group', id, label, count: parts.length, open: isOpen, depth});
        if (!isOpen) return;
        if (parts.length > SPLIT_OVER) {
            for (let l = level; l < levels.length; l++) {
                const groups = cut(parts, levels[l]);
                if (groups.length < 2) continue;
                for (const g of groups) walk(g.parts, `${id}/${g.cut.label}`, g.cut.label, depth + 1, l + 1);
                return;
            }
        }
        // Best rated first; unrated parts sit with the usable ones.
        const rated = [...parts].sort((a, b) => (b.rating ?? UNRATED) - (a.rating ?? UNRATED));
        for (const part of rated) rows.push({t: 'part', part, depth: depth + 1});
    };

    kitRows(all, open, rows);
    for (const role of ROLES) {
        const parts = all.filter((p) => p.role === role);
        if (parts.length) walk(parts, role, ROLE_LABELS[role], 0, 0);
    }
    return rows;
}
