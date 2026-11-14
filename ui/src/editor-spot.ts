/**
 * Where the cursor is in strudel code, read from the JavaScript syntax tree:
 * inside a string (and which call it is an argument of), after a `.`, or in
 * plain code. Completion and hover both decide what to offer from this.
 *
 * Takes a `slice` reader instead of the whole text so the editor can pass
 * `state.sliceDoc` without copying the document on every keystroke.
 */
import type {SyntaxNode, Tree} from '@lezer/common';

export type Slice = (from: number, to: number) => string;

export type Spot =
    /** Plain code. `member` is true after a `.` (a method goes here). */
    | {kind: 'code'; member: boolean; from: number}
    /**
     * Inside a string. `callee` is the call it is the argument of (`s`,
     * `bank`, `note`, …), or null. `bank` is the name given to a `.bank("…")`
     * in the same chain. `word` is the mini-notation token being typed.
     */
    | {kind: 'string'; callee: string | null; bank: string | null; from: number; word: string}
    /** In a comment, or somewhere nothing should be offered. */
    | {kind: 'none'};

const STRING_NODES = new Set(['String', 'TemplateString']);
const COMMENT_NODES = new Set(['LineComment', 'BlockComment']);

/** The string node the cursor is inside, or null. An open string at the end counts. */
export function stringAt(tree: Tree, slice: Slice, pos: number): SyntaxNode | null {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) {
        if (!STRING_NODES.has(n.name)) continue;
        if (pos <= n.from) return null;
        const quote = slice(n.from, n.from + 1);
        const closed = n.to - n.from >= 2 && slice(n.to - 1, n.to) === quote;
        return pos < n.to || !closed ? n : null;
    }
    return null;
}

function sameNode(a: SyntaxNode | null, b: SyntaxNode): boolean {
    return !!a && a.from === b.from && a.to === b.to && a.name === b.name;
}

/** `s` for `s(…)`, `bank` for `x.bank(…)`. */
function calleeName(call: SyntaxNode, slice: Slice): string | null {
    const head = call.firstChild;
    if (!head) return null;
    if (head.name === 'VariableName') return slice(head.from, head.to);
    if (head.name === 'MemberExpression') {
        const prop = head.lastChild;
        if (prop?.name === 'PropertyName') return slice(prop.from, prop.to);
    }
    return null;
}

/** Every call in the method chain `call` belongs to, outermost last. */
function chainCalls(call: SyntaxNode): SyntaxNode[] {
    const calls = [call];
    // Down: the receiver of `x.f()` is `x`.
    for (let c: SyntaxNode | null = call; c; ) {
        const member: SyntaxNode | null = c.firstChild;
        const receiver: SyntaxNode | null = member?.name === 'MemberExpression' ? member.firstChild : null;
        c = receiver?.name === 'CallExpression' ? receiver : null;
        if (c) calls.push(c);
    }
    // Up: `call` is the receiver of an outer `.f()`.
    for (let c = call; ; ) {
        const member = c.parent;
        if (member?.name !== 'MemberExpression' || !sameNode(member.firstChild, c)) break;
        const outer = member.parent;
        if (outer?.name !== 'CallExpression') break;
        calls.push(outer);
        c = outer;
    }
    return calls;
}

/** The text of the first string argument of `call`, unquoted. */
function firstStringArg(call: SyntaxNode, slice: Slice): string | null {
    const arg = call.getChild('ArgList')?.firstChild?.nextSibling;
    if (!arg || !STRING_NODES.has(arg.name)) return null;
    const text = slice(arg.from, arg.to);
    return text.length >= 2 && text[text.length - 1] === text[0] ? text.slice(1, -1) : text.slice(1);
}

export function spotAt(tree: Tree, slice: Slice, pos: number): Spot {
    const str = stringAt(tree, slice, pos);
    if (str) {
        const before = slice(str.from + 1, pos);
        const word = /[\w:]*$/.exec(before)![0];
        let callee: string | null = null;
        let bank: string | null = null;
        const call = str.parent?.name === 'ArgList' ? str.parent.parent : null;
        if (call?.name === 'CallExpression') {
            callee = calleeName(call, slice);
            for (const c of chainCalls(call)) {
                if (calleeName(c, slice) === 'bank') bank = firstStringArg(c, slice);
            }
        }
        return {kind: 'string', callee, bank, from: pos - word.length, word};
    }

    if (COMMENT_NODES.has(tree.resolveInner(pos, -1).name)) return {kind: 'none'};

    const lineStart = Math.max(0, pos - 200);
    const before = slice(lineStart, pos);
    const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0] ?? '';
    const lead = before.slice(0, before.length - word.length);
    // A chain may continue on the next line: `\n  .lpf(…)`.
    const member = /\.\s*$/.test(lead) && !/\d\.\s*$/.test(lead);
    return {kind: 'code', member, from: pos - word.length};
}
