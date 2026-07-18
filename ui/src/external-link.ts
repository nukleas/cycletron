/**
 * Open a URL in the user's default browser, working both inside the Tauri
 * webview and in a plain browser (dev preview). Centralizes the
 * Tauri-vs-browser branch so callers don't re-derive it.
 */
import {invoke} from './tauri.js';

const isTauri = !!(window as any).__TAURI__;

export async function openExternal(url: string): Promise<void> {
    if (!isTauri) {
        window.open(url, '_blank', 'noopener');
        return;
    }
    try {
        await invoke('plugin:opener|open_url', {url});
    } catch (e) {
        console.warn('[external-link] open failed:', e);
    }
}
