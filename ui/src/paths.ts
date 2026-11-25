/** Path helpers shared across the UI (no Node path module in the webview). */

/** Last path segment; handles both `/` and `\` separators. */
export function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

/** Parent directory of `path`, or `""` when there is no separator. */
export function dirname(path: string): string {
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx > 0 ? path.slice(0, idx) : idx === 0 ? '/' : '';
}

/** `to` relative to the directory `fromDir`, with `/` separators. */
export function relativePath(fromDir: string, to: string): string {
    const from = fromDir.split(/[\\/]/).filter(Boolean);
    const target = to.split(/[\\/]/).filter(Boolean);
    let same = 0;
    while (same < from.length && same < target.length && from[same] === target[same]) same++;
    return [...from.slice(same).map(() => '..'), ...target.slice(same)].join('/');
}
