/**
 * Shared modal helpers. Used by About, Preferences (and any other modal
 * that needs to handle Esc + backdrop dismiss + `data-dismiss` buttons
 * uniformly).
 */

/**
 * Wire up the standard dismiss behaviours on `root`:
 *   - Click any descendant carrying `data-dismiss` → close
 *   - Click the `.app-modal-backdrop` child → close
 *   - Press Escape while visible → close
 *
 * Returns a cleanup function — call it when the modal is hidden so the Esc
 * handler doesn't keep firing.
 */
export function dismissibleModal(root: HTMLElement, close: () => void): () => void {
    const onClick = (e: Event) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.matches('[data-dismiss], .app-modal-backdrop')) {
            close();
        }
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    };
    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
        root.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey, true);
    };
}
