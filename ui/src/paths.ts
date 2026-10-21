/** Path helpers shared across the UI (no Node path module in the webview). */

/** Last path segment; handles both `/` and `\` separators. */
export function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

/** `to` relative to the directory `fromDir`, with `/` separators. */
export function relativePath(fromDir: string, to: string): string {
    const from = fromDir.split(/[\\/]/).filter(Boolean);
    const target = to.split(/[\\/]/).filter(Boolean);
    let same = 0;
    while (same < from.length && same < target.length && from[same] === target[same]) same++;
    return [...from.slice(same).map(() => '..'), ...target.slice(same)].join('/');
}
