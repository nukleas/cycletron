/**
 * Receives system-wide global shortcut events from the backend.
 * These fire whether or not Cycletron is the focused app.
 */

import {isTauri, listen} from './tauri.js';


export async function initShortcutBridge(): Promise<void> {
    if (!isTauri) return;

    await listen('shortcut:play_pause', () => {
        void window.strudelApp?.togglePlayPause?.();
    });
    await listen('shortcut:stop', () => {
        window.strudelApp?.stop?.();
    });
}
