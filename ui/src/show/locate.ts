/**
 * Where in a show file's text a path (`song[0].sections.drop.code`) is
 * written, so errors and the playing section can be marked on their line.
 * A line-based read of table headers and `key =` lines — enough for show
 * files, which are flat tables; anything it can't place falls back to the
 * nearest enclosing table.
 */

export interface Located {
    /** 1-based line. */
    line: number;
    /** True when the line names the whole path, not an enclosing table. */
    exact: boolean;
}

const HEADER = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?/;
/** A bare, quoted or dotted key (`sections.drop = …`), up to its `=`. */
const KEY = /^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/;

export function locate(text: string, path: string): Located {
    const target = segments(path);
    const arrays = new Map<string, number>();
    let table: string[] = [];
    let best: Located = {line: 1, exact: target.length === 0};
    let bestDepth = 0;

    const consider = (at: string[], line: number) => {
        const depth = sharedDepth(at, target);
        if (depth === at.length && depth > bestDepth) {
            bestDepth = depth;
            best = {line, exact: depth === target.length};
        }
    };

    text.split('\n').forEach((raw, i) => {
        const header = HEADER.exec(raw);
        if (header) {
            const name = dotted(header[2]);
            if (header[1] === '[[') {
                const n = arrays.get(name.join('.')) ?? -1;
                arrays.set(name.join('.'), n + 1);
            }
            table = indexed(name, arrays);
            consider(table, i + 1);
            return;
        }
        const key = KEY.exec(raw);
        if (key) consider([...table, ...dotted(key[1])], i + 1);
    });
    return best;
}

/** `song.sections` → `song[0].sections`, using the latest element of each array of tables. */
function indexed(name: string[], arrays: Map<string, number>): string[] {
    const out: string[] = [];
    for (let i = 0; i < name.length; i++) {
        const n = arrays.get(name.slice(0, i + 1).join('.'));
        out.push(n === undefined ? name[i] : `${name[i]}[${n}]`);
    }
    return out;
}

/** `a."b.c".d` → `a`, `b.c`, `d`. */
function dotted(key: string): string[] {
    return [...key.matchAll(/"([^"]*)"|'([^']*)'|([^.\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function segments(path: string): string[] {
    return path ? path.split('.') : [];
}

function sharedDepth(a: string[], b: string[]): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}
