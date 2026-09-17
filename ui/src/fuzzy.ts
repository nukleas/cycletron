/**
 * The app's one fuzzy matcher. Extracted verbatim from the command palette so
 * the palette, the Sound Browser and the sidebar Sounds panel rank the same way
 * — a query that finds a command should find a bank by the same rules.
 *
 * Tiers: exact 1000 / prefix 500 / substring 200 / subtitle 100 /
 * subsequence 50 / no match 0. Length nudges break ties toward shorter names.
 */

/**
 * Score `title` (and its `subtitle` as a weaker field) against an
 * already-lowercased, already-trimmed query. Returns 0 for no match.
 */
export function scoreText(title: string, subtitle: string, q: string): number {
    const t = title.toLowerCase();
    const s = subtitle.toLowerCase();
    if (t === q) return 1000;
    if (t.startsWith(q)) return 500 - t.length;
    const tIdx = t.indexOf(q);
    if (tIdx >= 0) return 200 - tIdx - t.length * 0.01;
    const sIdx = s.indexOf(q);
    if (sIdx >= 0) return 100 - sIdx;
    // Subsequence match (e.g. "opnf" matches "Open File").
    let i = 0;
    for (const ch of t) {
        if (ch === q[i]) i++;
        if (i === q.length) return 50;
    }
    return 0;
}
