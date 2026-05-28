/**
 * Receives system-wide global shortcut events from the backend.
 * These fire whether or not Robostrudel is the focused app.
 */

const isTauri = !!(window as any).__TAURI__;

export async function initShortcutBridge(): Promise<void> {
    if (!isTauri) return;
    const {listen} = (window as any).__TAURI__.event;

    await listen('shortcut:play_pause', () => {
        void window.strudelApp?.togglePlayPause?.();
    });
    await listen('shortcut:stop', () => {
        window.strudelApp?.stop?.();
    });
}
