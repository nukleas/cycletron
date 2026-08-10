/**
 * Aggregates short-lived background tasks ("recording", "ai-response", …)
 * into a single dock/taskbar badge count via the Rust `set_dock_badge`
 * command. Callers add/remove their named task; the helper keeps the count
 * in sync.
 */

import {invoke, isTauri} from './tauri.js';


const active = new Set<string>();
let lastPosted = -1;

export function addTask(name: string): void {
    active.add(name);
    sync();
}

export function removeTask(name: string): void {
    active.delete(name);
    sync();
}

function sync(): void {
    if (!isTauri) return;
    const count = active.size;
    if (count === lastPosted) return;
    lastPosted = count;
    void invoke<void>('set_dock_badge', {count}).catch((e) => {
        console.warn('[dock-badge] set failed:', e);
    });
}
