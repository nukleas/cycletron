/**
 * Shared Tauri IPC helper. Every module that talks to the Rust backend should
 * import `invoke` from here rather than re-deriving the `window.__TAURI__`
 * access — keeps the "Tauri not available" guard in a single place.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = window.__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke<T>(cmd, args);
}

/**
 * Invoke with a raw binary payload instead of JSON arguments.
 *
 * The buffer must be the *top-level* payload: Tauri delivers that as
 * `InvokeBody::Raw`, whereas a buffer nested inside an args object is
 * JSON-encoded into a number array — roughly 5x inflation, which matters once
 * you are streaming a recording. Small scalars ride along in `headers`.
 */
export async function invokeRaw<T>(
    cmd: string,
    body: Uint8Array,
    headers: Record<string, string>,
): Promise<T> {
    const api = window.__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke<T>(cmd, body, {headers});
}

/** Subscribe to a backend event. Throws when there's no Tauri shell — callers
 *  that can run in a browser should guard with `isTauri` first. */
export async function listen<T = unknown>(
    event: string,
    handler: (event: {payload: T}) => void,
): Promise<() => void> {
    const api = window.__TAURI__?.event;
    if (!api) throw new Error('Tauri not available');
    return api.listen<T>(event, handler);
}

/** True when running inside the Tauri desktop shell (vs. a plain browser). */
export const isTauri = !!window.__TAURI__;
