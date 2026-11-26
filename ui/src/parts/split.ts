/**
 * Cut a source file into single-voice lanes.
 *
 * A file with `$:` tracks gives one lane per track. A file that is one bare
 * `stack(a, b, …)` gives one lane per argument. Anything else is one lane.
 * Files that lean on `const` bindings or a section form are skipped: a lane
 * has to play on its own.
 */

import {parser} from '@lezer/javascript';
import type {SyntaxNode} from '@lezer/common';
import {parseTracks} from '../mixer.js';

export type Role = 'drums' | 'bass' | 'chords' | 'lead' | 'other';

export const ROLES: Role[] = ['drums', 'bass', 'chords', 'lead', 'other'];

export interface Lane {
    /** Comment above the lane, if it had one. */
    label: string | null;
    code: string;
}

export interface Split {
    bpm: number | null;
    lanes: Lane[];
}

const SECTION_FORM = /\.(?:pick|inhabit)\w*\s*\(|\barrange\s*\(/;

/** Tempo set by the file, in beats per minute. One cycle is four beats. */
export function tempoOf(code: string): number | null {
    const bpm = code.match(/^\s*setbpm\s*\(\s*(\d+(?:\.\d+)?)\s*\)/m);
    if (bpm) return Number(bpm[1]);
    const cpm = code.match(/^\s*setcpm\s*\(\s*(\d+(?:\.\d+)?)\s*\)/m);
    return cpm ? Number(cpm[1]) * 4 : null;
}

export function splitLanes(code: string): Split {
    const bpm = tempoOf(code);
    if (SECTION_FORM.test(code)) return {bpm, lanes: []};

    const tree = parser.parse(code);
    const statements: SyntaxNode[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'LineComment' || node.name === 'BlockComment') continue;
        if (node.name !== 'ExpressionStatement' && node.name !== 'LabeledStatement') {
            return {bpm, lanes: []};
        }
        if (/^set(?:bpm|cpm)\b/.test(code.slice(node.from, node.to))) continue;
        statements.push(node);
    }

    const tracks = parseTracks(code);
    if (tracks.length > 0) {
        // A bare expression next to `$:` tracks is a voice we would lose.
        if (statements.some((s) => s.name !== 'LabeledStatement')) return {bpm, lanes: []};
        const lanes = tracks.map((t) => ({
            label: commentAbove(code, t.start),
            code: tidy(code.slice(t.start, t.end).replace(/^\s*\$:\s*/, '')),
        }));
        return {bpm, lanes: lanes.filter((l) => l.code)};
    }

    if (statements.length !== 1) return {bpm, lanes: []};
    const expr = statements[0].firstChild;
    if (!expr) return {bpm, lanes: []};

    const args = stackArgs(expr, code);
    if (!args) return {bpm, lanes: [{label: null, code: tidy(code.slice(expr.from, expr.to))}]};

    return {
        bpm,
        lanes: args.map((arg) => ({
            label: commentAbove(code, arg.from),
            code: tidy(code.slice(arg.from, arg.to)),
        })),
    };
}

/** The arguments of `node` when it is a plain `stack(…)` call, else null. */
export function stackArgs(node: SyntaxNode, code: string): SyntaxNode[] | null {
    if (node.name !== 'CallExpression') return null;
    const callee = node.firstChild;
    if (!callee || callee.name !== 'VariableName') return null;
    if (code.slice(callee.from, callee.to) !== 'stack') return null;
    const list = node.getChild('ArgList');
    return list ? argNodes(list) : null;
}

export function argNodes(list: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let child = list.firstChild; child; child = child.nextSibling) {
        if (child.from === child.to) continue;
        if (['(', ')', ',', 'LineComment', 'BlockComment'].includes(child.name)) continue;
        out.push(child);
    }
    return out;
}

/** Text of a `//` comment on the line right above `pos`. */
function commentAbove(code: string, pos: number): string | null {
    const lineStart = code.lastIndexOf('\n', pos - 1) + 1;
    if (code.slice(lineStart, pos).trim() !== '') return null;
    if (lineStart === 0) return null;
    const prevStart = code.lastIndexOf('\n', lineStart - 2) + 1;
    const prev = code.slice(prevStart, lineStart - 1).trim();
    if (!prev.startsWith('//')) return null;
    return prev.replace(/^\/+\s*/, '').trim() || null;
}

/** Trim, drop a trailing `;`, and pull continuation lines back to one indent step. */
export function tidy(text: string): string {
    const lines = text.trim().replace(/;$/, '').split('\n');
    const rest = lines.slice(1).filter((l) => l.trim());
    const indent = Math.min(...rest.map((l) => l.match(/^\s*/)![0].length));
    const cut = Number.isFinite(indent) ? Math.max(0, indent - 2) : 0;
    return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(cut, l.match(/^\s*/)![0].length)).trimEnd())]
        .join('\n');
}

const ROLE_WORDS: [Role, RegExp][] = [
    ['drums', /\b(drums?|kick|snare|hats?|hi-?hats?|clap|perc\w*|break|ride|toms?|kit|four-on-the-floor|backbeat|shuffle|rim)\b/i],
    ['bass', /\b(bass\w*|sub|303|reese)\b/i],
    ['chords', /\b(chords?|pads?|stab\w*|harmony|progression|voicings?|piano|organ|keys)\b/i],
    ['lead', /\b(leads?|arp\w*|melody|hook|riff|pluck|solo)\b/i],
];

const DRUM_TOKEN = /^(bd|sd|hh|oh|ch|cp|rim|lt|mt|ht|cr|rd|cb|perc|tom|clap|kick|snare|hat|crash|ride|shaker|tamb)\d*$/;

/** Best guess at what a lane is for. Words in the name win over the code. */
export function classify(name: string, code: string): Role {
    for (const [role, re] of ROLE_WORDS) if (re.test(name)) return role;

    // `RolandTR808_bd` and `gm_acoustic_bass` name their role after the underscore.
    const sounds = [...code.matchAll(/\b(?:s|sound)\(\s*["'`]([^"'`]*)/g)]
        .flatMap((m) => m[1].split(/[^a-z0-9_]+/i))
        .filter((t) => /^[a-z]/i.test(t))
        .map((t) => t.toLowerCase().split('_').at(-1)!);
    if (sounds.length && sounds.filter((t) => DRUM_TOKEN.test(t)).length * 2 >= sounds.length) {
        return 'drums';
    }

    const words = code.replace(/_/g, ' ');
    for (const [role, re] of ROLE_WORDS) if (role !== 'drums' && re.test(words)) return role;

    if (/\b(?:chord|voicing)\s*\(/.test(code) || /\[[a-g][#b]?\d\s*,/i.test(code)) return 'chords';
    const octaves = [...code.matchAll(/\b[a-g][#bs]?(\d)\b/gi)].map((m) => Number(m[1]));
    if (octaves.length) return octaves.filter((o) => o <= 2).length * 2 > octaves.length ? 'bass' : 'lead';
    return 'other';
}

/** Short name for a lane with no comment: the first sound it plays. */
export function nameFromCode(code: string): string | null {
    const sound = code.match(/\b(?:s|sound)\(\s*["'`]([^"'`]*)/);
    const first = sound?.[1].trim().split(/[\s*<>[\]({,~!@?:]+/).find(Boolean);
    return first ?? null;
}
