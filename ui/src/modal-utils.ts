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
const activeCleanups = new WeakMap<HTMLElement, () => void>();

export function dismissibleModal(root: HTMLElement, close: () => void): () => void {
    // Tear down any existing listeners on this modal root so repeated open()
    // calls can never leak capture-phase keydown or click handlers.
    activeCleanups.get(root)?.();

    const onClick = (e: Event) => {
        const target = e.target as Element | null;
        if (!target) return;
        if (target.closest('[data-dismiss]') || target.matches('.app-modal-backdrop')) {
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
    const cleanup = () => {
        root.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey, true);
        if (activeCleanups.get(root) === cleanup) {
            activeCleanups.delete(root);
        }
    };
    activeCleanups.set(root, cleanup);
    return cleanup;
}
