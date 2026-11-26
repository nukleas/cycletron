/**
 * Where a part goes in a song, and the text to put there.
 *
 * Inside the argument list of a `stack(…)` the part becomes one more argument,
 * so it plays only in that section. Anywhere else it becomes a `$:` track at
 * the nearest gap between top-level statements.
 */

import {parser} from '@lezer/javascript';
import type {SyntaxNode} from '@lezer/common';
import {argNodes} from './split.js';

export interface PartText {
    title: string;
    code: string;
    bpm: number | null;
}

export interface Insert {
    kind: 'stack' | 'track';
    from: number;
    to: number;
    insert: string;
    /** Range of the part's own code inside `insert`, relative to `from`. */
    partFrom: number;
    partTo: number;
}

/** `pos` is a document offset, or null to add at the end. */
export function planInsert(code: string, pos: number | null, part: PartText): Insert {
    if (code.trim() === '') {
        const head = part.bpm ? `setbpm(${part.bpm});\n\n` : '';
        return track(0, code.length, head, part, '');
    }

    const tree = parser.parse(code);
    if (pos !== null) {
        const list = enclosingStack(tree.resolveInner(pos, -1), code, pos)
            ?? enclosingStack(tree.resolveInner(pos, 1), code, pos);
        if (list) return intoStack(code, list, pos, part);
    }

    const gaps = trackGaps(tree.topNode, code);
    const at = pos === null
        ? code.length
        : gaps.reduce((best, g) => (Math.abs(g - pos) < Math.abs(best - pos) ? g : best), code.length);

    if (at >= code.length) {
        const lead = code.endsWith('\n\n') ? '' : code.endsWith('\n') ? '\n' : '\n\n';
        return track(code.length, code.length, lead, part, '');
    }
    return track(at, at, '', part, '\n');
}

function track(from: number, to: number, lead: string, part: PartText, tail: string): Insert {
    const head = `${lead}// ${part.title}\n$: `;
    return {
        kind: 'track',
        from,
        to,
        insert: `${head}${part.code}\n${tail}`,
        partFrom: head.length,
        partTo: head.length + part.code.length,
    };
}

/** The innermost `stack(` argument list that holds `pos`. */
function enclosingStack(node: SyntaxNode | null, code: string, pos: number): SyntaxNode | null {
    for (let n = node; n; n = n.parent) {
        if (n.name !== 'ArgList' || pos <= n.from || pos >= n.to) continue;
        const callee = n.parent?.firstChild;
        if (callee?.name === 'VariableName' && code.slice(callee.from, callee.to) === 'stack') return n;
    }
    return null;
}

function intoStack(code: string, list: SyntaxNode, pos: number, part: PartText): Insert {
    const args = argNodes(list);
    if (args.length === 0) {
        return {kind: 'stack', from: list.from + 1, to: list.from + 1, insert: part.code, partFrom: 0, partTo: part.code.length};
    }

    // The argument the pointer is on or just past; before the first one, lead with the part.
    const before = pos < args[0].from;
    const anchor = before ? args[0] : args.filter((a) => a.from <= pos).at(-1)!;
    const lineStart = code.lastIndexOf('\n', anchor.from - 1) + 1;
    const lead = code.slice(lineStart, anchor.from);
    const ownLine = lead.trim() === '';
    const body = ownLine ? part.code.replace(/\n/g, `\n${lead}`) : part.code.replace(/\s*\n\s*/g, '');

    const sep = ownLine ? `,\n${lead}` : ', ';
    if (before) {
        return {kind: 'stack', from: anchor.from, to: anchor.from, insert: body + sep, partFrom: 0, partTo: body.length};
    }
    return {
        kind: 'stack',
        from: anchor.to,
        to: anchor.to,
        insert: sep + body,
        partFrom: sep.length,
        partTo: sep.length + body.length,
    };
}

/**
 * Offsets where a new track can start: the first line of each top-level
 * statement, counting the comment lines right above it as part of it. Nothing
 * goes above the tempo line.
 */
function trackGaps(top: SyntaxNode, code: string): number[] {
    const gaps: number[] = [];
    let blockStart: number | null = null;
    let floor = 0;

    for (let node = top.firstChild; node; node = node.nextSibling) {
        if (node.from === node.to) continue;
        const start = code.lastIndexOf('\n', node.from - 1) + 1;
        if (node.name === 'LineComment') {
            blockStart ??= start;
            continue;
        }
        const from = blockStart ?? start;
        blockStart = null;
        if (/^set(?:bpm|cpm)\b/.test(code.slice(node.from, node.to))) {
            floor = gaps.length + 1;
        }
        gaps.push(from);
    }
    return gaps.slice(floor);
}
