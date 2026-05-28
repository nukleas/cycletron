/**
 * Aggregates short-lived background tasks ("recording", "ai-response", …)
 * into a single dock/taskbar badge count via the Rust `set_dock_badge`
 * command. Callers add/remove their named task; the helper keeps the count
 * in sync.
 */

const isTauri = !!(window as any).__TAURI__;

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

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}
