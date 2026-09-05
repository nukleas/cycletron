/**
 * The song-form structure of a document, for Stage Mode's "follow the music".
 *
 * A form is a call that switches between named sections over time — the pick
 * family (`"<intro verse>".pickRestart({intro: …, verse: …})`) and
 * `arrange([4, intro], [2, verse])`. Each section is a branch with a source
 * range. Which branch is playing is decided elsewhere, by containment: the
 * engine reports the source spans of the notes sounding right now, and those
 * spans land inside the playing branch's text.
 *
 * Built from the same `@lezer/javascript` tree the code layer already parses
 * for coloring, so this costs nothing extra per edit.
 */

import type {SyntaxNode, Tree} from '@lezer/common';

export interface Range {
    from: number;
    to: number;
}

export interface Branch {
    /** Object key, referenced section name, or the element index. */
    label: string;
    /** Source shown for this branch, and the primary containment range. */
    from: number;
    to: number;
    /**
     * Top-level declarations the branch body refers to. A branch written as
     * `verse: versePat.gain(0.8)` sounds from atoms inside `let versePat = …`,
     * so those ranges count for containment even though the branch displays
     * its own text.
     */
    refs: Range[];
}

export interface Form {
    from: number;
    to: number;
    /** Section labels in selector order, de-duplicated; branch order as fallback. */
    crumbs: string[];
    branches: Branch[];
}

/** Mirrors strudel-rs `SELECTOR_NAMES` — the methods that take a section lookup. */
const SELECTOR_METHODS = new Set([
    'pick', 'pickmod', 'pickOut', 'pickmodOut', 'pickRestart', 'pickmodRestart',
    'pickReset', 'pickmodReset', 'inhabit', 'inhabitmod', 'pickSqueeze', 'pickmodSqueeze',
]);

export function parseForms(tree: Tree, code: string): Form[] {
    const decls = topLevelDeclarations(tree, code);
    const forms: Form[] = [];

    const cursor = tree.cursor();
    do {
        if (cursor.name !== 'CallExpression') continue;
        const node = cursor.node;
        const form = selectorForm(node, code, decls) ?? arrangeForm(node, code, decls);
        if (form) forms.push(form);
    } while (cursor.next());

    // A form nested inside another's branch would be shown twice on stage; the
    // outer one already carries it.
    return forms.filter((form) =>
        !forms.some((outer) => outer !== form && outer.from <= form.from && form.to <= outer.to));
}

/** Ranges of the document's top-level statements, in order. */
export function topLevelStatements(tree: Tree): Range[] {
    const out: Range[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        out.push({from: node.from, to: node.to});
    }
    return out;
}

// ---- forms ------------------------------------------------------------------

function selectorForm(
    node: SyntaxNode, code: string, decls: Map<string, Range>,
): Form | null {
    const callee = node.firstChild;
    if (!callee || callee.name !== 'MemberExpression') return null;
    const method = callee.lastChild;
    if (!method || method.name !== 'PropertyName') return null;
    if (!SELECTOR_METHODS.has(text(code, method))) return null;

    const lookup = firstArg(node);
    if (!lookup) return null;

    let branches: Branch[];
    if (lookup.name === 'ObjectExpression') {
        branches = objectBranches(lookup, code, decls);
    } else if (lookup.name === 'ArrayExpression') {
        branches = arrayBranches(lookup, code, decls);
    } else {
        return null;
    }
    if (!branches.length) return null;

    const crumbs = selectorLabels(callee, code, branches);
    return {from: node.from, to: node.to, crumbs, branches};
}

function arrangeForm(
    node: SyntaxNode, code: string, decls: Map<string, Range>,
): Form | null {
    const callee = node.firstChild;
    if (!callee || callee.name !== 'VariableName' || text(code, callee) !== 'arrange') return null;

    const branches: Branch[] = [];
    for (const arg of namedChildren(node.lastChild)) {
        if (arg.name !== 'ArrayExpression') continue;
        const [count, pattern] = namedChildren(arg);
        if (!count || !pattern) continue;
        const index = String(branches.length);
        branches.push(branchFor(index, arg, pattern, code, decls));
    }
    if (!branches.length) return null;

    return {
        from: node.from,
        to: node.to,
        crumbs: branches.map((b) => b.label),
        branches,
    };
}

function objectBranches(obj: SyntaxNode, code: string, decls: Map<string, Range>): Branch[] {
    const out: Branch[] = [];
    for (const prop of namedChildren(obj)) {
        if (prop.name !== 'Property') continue;
        const key = prop.firstChild;
        if (!key) continue;
        const label = unquote(text(code, key));
        const value = prop.lastChild;
        // `{intro}` shorthand: the key *is* the reference.
        const valueNode = value && value !== key ? value : key;
        out.push(branchFor(label, prop, valueNode, code, decls));
    }
    return out;
}

function arrayBranches(arr: SyntaxNode, code: string, decls: Map<string, Range>): Branch[] {
    return namedChildren(arr).map((el, i) => branchFor(String(i), el, el, code, decls));
}

/**
 * A branch displays `own` (the property or element) unless its value is a bare
 * reference to a top-level declaration, in which case the declaration is both
 * where the notes come from and the code worth showing.
 */
function branchFor(
    label: string,
    own: SyntaxNode,
    value: SyntaxNode,
    code: string,
    decls: Map<string, Range>,
): Branch {
    const refName = referenceName(value, code);
    if (refName) {
        const decl = decls.get(refName);
        if (decl) return {label, from: decl.from, to: decl.to, refs: []};
    }
    return {label, from: own.from, to: own.to, refs: referencedDecls(value, code, decls)};
}

/** `name` or `name()` → the name; anything else → null. */
function referenceName(node: SyntaxNode, code: string): string | null {
    if (node.name === 'VariableName' || node.name === 'PropertyDefinition') return text(code, node);
    if (node.name === 'CallExpression') {
        const callee = node.firstChild;
        const args = node.lastChild;
        if (callee?.name === 'VariableName' && args && namedChildren(args).length === 0) {
            return text(code, callee);
        }
    }
    return null;
}

function referencedDecls(node: SyntaxNode, code: string, decls: Map<string, Range>): Range[] {
    if (!decls.size) return [];
    const out: Range[] = [];
    const seen = new Set<string>();
    const cursor = node.cursor();
    do {
        if (cursor.name !== 'VariableName') continue;
        const name = code.slice(cursor.from, cursor.to);
        const decl = decls.get(name);
        if (decl && !seen.has(name)) {
            seen.add(name);
            out.push(decl);
        }
    } while (cursor.next() && cursor.from < node.to);
    return out;
}

/**
 * Labels in the order the selector string names them — `"<intro verse@2 drop>"`
 * — with weights stripped and repeats removed. The receiver is found by
 * walking the callee chain down to its first string literal.
 */
function selectorLabels(callee: SyntaxNode, code: string, branches: Branch[]): string[] {
    const fallback = branches.map((b) => b.label);
    let node: SyntaxNode | null = callee.firstChild;
    while (node && node.name !== 'String') {
        node = node.name === 'MemberExpression' || node.name === 'CallExpression'
            ? node.firstChild
            : null;
    }
    if (!node) return fallback;

    const known = new Set(fallback);
    const labels: string[] = [];
    for (const raw of unquote(text(code, node)).split(/\s+/)) {
        const label = raw.replace(/^[<[]+|[>\]]+$/g, '').replace(/[@!*?].*$/, '');
        if (!label || label === '~' || label === '-' || labels.includes(label)) continue;
        labels.push(label);
    }
    // Numeric selectors over an object, or labels that match nothing: the
    // branch order is the truth the audience can follow.
    return labels.length && labels.every((l) => known.has(l)) ? labels : fallback;
}

// ---- declarations -----------------------------------------------------------

function topLevelDeclarations(tree: Tree, code: string): Map<string, Range> {
    const decls = new Map<string, Range>();
    for (let stmt = tree.topNode.firstChild; stmt; stmt = stmt.nextSibling) {
        if (stmt.name !== 'VariableDeclaration' && stmt.name !== 'FunctionDeclaration') continue;
        for (const child of namedChildren(stmt)) {
            if (child.name === 'VariableDefinition') {
                decls.set(text(code, child), {from: stmt.from, to: stmt.to});
            }
        }
    }
    return decls;
}

// ---- helpers ----------------------------------------------------------------

function firstArg(call: SyntaxNode): SyntaxNode | null {
    return namedChildren(call.lastChild)[0] ?? null;
}

/** Children that are grammar nodes rather than punctuation. */
function namedChildren(node: SyntaxNode | null): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let child = node?.firstChild ?? null; child; child = child.nextSibling) {
        if (/^[A-Z]/.test(child.name)) out.push(child);
    }
    return out;
}

function text(code: string, node: SyntaxNode): string {
    return code.slice(node.from, node.to);
}

function unquote(s: string): string {
    return s.length >= 2 && /^['"`]/.test(s) && s[0] === s[s.length - 1] ? s.slice(1, -1) : s;
}
