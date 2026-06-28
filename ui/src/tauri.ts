/**
 * Shared Tauri IPC helper. Every module that talks to the Rust backend should
 * import `invoke` from here rather than re-deriving the `window.__TAURI__`
 * access — keeps the "Tauri not available" guard in a single place.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}
