/**
 * Native notifications. Permission is requested lazily on the first call.
 * If the user has notifications disabled in Preferences, calls are no-ops.
 *
 * Caller-side rule: only fire notifications for things the user benefits
 * from being told about *while away from the window*. Don't flood.
 */

import type {UserSettings} from './types/tauri-commands.js';

const isTauri = !!(window as any).__TAURI__;

let permission: 'granted' | 'denied' | 'unknown' = 'unknown';
let enabled = true;
let settingsLoaded = false;

async function loadSettingsOnce(): Promise<void> {
    if (settingsLoaded || !isTauri) return;
    try {
        const settings = await invoke<UserSettings>('get_user_settings');
        enabled = settings.notifications?.enabled ?? true;
    } catch {
        enabled = true;
    }
    settingsLoaded = true;
}

/** Call when the user toggles the setting, so subsequent calls reflect it
 *  without waiting for a reload. */
export function setNotificationsEnabled(value: boolean): void {
    enabled = value;
    settingsLoaded = true;
}

export async function notify(title: string, body: string): Promise<void> {
    if (!isTauri) return;
    await loadSettingsOnce();
    if (!enabled) return;

    try {
        const {isPermissionGranted, requestPermission, sendNotification} =
            await import('@tauri-apps/plugin-notification');
        if (permission === 'unknown') {
            permission = (await isPermissionGranted()) ? 'granted' : 'denied';
            if (permission !== 'granted') {
                const next = await requestPermission();
                permission = next === 'granted' ? 'granted' : 'denied';
            }
        }
        if (permission !== 'granted') return;
        sendNotification({title, body});
    } catch (e) {
        console.warn('[notify] failed:', e);
    }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}
