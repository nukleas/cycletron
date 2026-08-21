/** Path helpers shared across the UI (no Node path module in the webview). */

/** Last path segment; handles both `/` and `\` separators. */
export function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}
