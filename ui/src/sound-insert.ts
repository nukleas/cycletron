/**
 * One insertion policy, shared by the Sound Browser and the sidebar panel.
 *
 * Extracted from the old chip grid so the two views cannot drift: clicking a
 * sound means the same thing wherever you click it.
 */

import {snippetFor, type Bank} from './sound-catalog.js';

/**
 * Put `bank` into the editor. Swaps the value of a nearby `s("…")` when the
 * cursor is already in one, so auditioning alternatives in place does not
 * litter the buffer; otherwise inserts a runnable snippet.
 *
 * `sampleIndex` targets a specific `:n` — something the chip grid could not
 * express at all.
 */
export function insertSound(bank: Bank, sampleIndex?: number): void {
    const editor = window.strudelApp?.editor;
    if (!editor) return;

    // A specific sample means the token carries an index, so the in-place swap
    // would drop the part the user actually clicked.
    if (sampleIndex === undefined && editor.replaceNearestSound(bank.name)) return;

    editor.insertAtCursor(snippetFor(bank, sampleIndex));
}
