/**
 * Push a frontend event into the Rust in-memory log ring buffer so it
 * shows up in the Logs modal alongside backend traces. In release builds
 * the JS console is invisible, so this is the only way to see drag-drop /
 * menu / dialog activity at runtime.
 *
 * Never throws — diagnostic logging must never break the feature it observes.
 */
export async function diag(
    level: 'info' | 'warn' | 'error' | 'debug',
    target: string,
    message: string,
): Promise<void> {
    try {
        const api = window.__TAURI__?.core;
        if (!api?.invoke) return;
        await api.invoke('log_diagnostic', {level, target, message});
    } catch {
        // Swallow — diagnostics must never disrupt the host call.
    }
}
