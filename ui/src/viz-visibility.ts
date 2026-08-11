/**
 * Pause a rAF loop while the document is hidden. WebKitGTK does not reliably
 * throttle requestAnimationFrame for occluded/unmapped windows (notably under
 * tiling Wayland compositors), so each loop owner gates itself: `pause` must
 * cancel the pending frame without clearing the owner's running intent, and
 * `resume` must reschedule only if that intent is still set (#8).
 */
export function pauseWhileHidden(hooks: {pause(): void; resume(): void}): void {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) hooks.pause();
        else hooks.resume();
    });
}
