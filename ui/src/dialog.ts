/**
 * Central, typed wrapper around `@tauri-apps/plugin-dialog`.
 *
 * Every module used to inline `await import('@tauri-apps/plugin-dialog')` and
 * call message/ask/save/open directly, each with its own slightly-different
 * out-of-Tauri fallback. This collapses that duplication into a handful of
 * intention-revealing functions and one place that owns the lazy import and
 * the "not running under Tauri" behaviour.
 *
 * Titles default to the app name; pass one only when a call needs its own.
 */

import type {OpenDialogOptions, SaveDialogOptions} from '@tauri-apps/plugin-dialog';
import {isTauri} from './tauri.js';

const TITLE = 'Cycletron';

function plugin(): Promise<typeof import('@tauri-apps/plugin-dialog')> {
    return import('@tauri-apps/plugin-dialog');
}

/** Modal error alert. Logs to the console when there's no Tauri shell. */
export async function errorDialog(message: string, title = TITLE): Promise<void> {
    if (!isTauri) { console.error('[dialog]', message); return; }
    const {message: show} = await plugin();
    await show(message, {title, kind: 'error'});
}

/** Modal warning alert. Logs to the console when there's no Tauri shell. */
export async function warnDialog(message: string, title = TITLE): Promise<void> {
    if (!isTauri) { console.warn('[dialog]', message); return; }
    const {message: show} = await plugin();
    await show(message, {title, kind: 'warning'});
}

/** Modal informational alert. Logs to the console when there's no Tauri shell. */
export async function infoDialog(message: string, title = TITLE): Promise<void> {
    if (!isTauri) { console.info('[dialog]', message); return; }
    const {message: show} = await plugin();
    await show(message, {title});
}

export interface ConfirmOptions {
    title?: string;
    kind?: 'info' | 'warning' | 'error';
    okLabel?: string;
    cancelLabel?: string;
}

/** OK/Cancel prompt. Resolves `false` outside Tauri so a missing shell never
 *  greenlights a destructive or irreversible action by default. */
export async function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    if (!isTauri) { console.warn('[dialog] confirm suppressed (no Tauri shell):', message); return false; }
    const {ask} = await plugin();
    return ask(message, {title: TITLE, ...opts});
}

/** Native save-file picker. Resolves `null` when cancelled or outside Tauri. */
export async function saveFileDialog(opts: SaveDialogOptions): Promise<string | null> {
    if (!isTauri) return null;
    const {save} = await plugin();
    return save(opts);
}

/** Native single-selection open picker (file or, with `directory: true`, a
 *  folder). Resolves `null` when cancelled or outside Tauri. */
export async function openPathDialog(opts: Omit<OpenDialogOptions, 'multiple'> = {}): Promise<string | null> {
    if (!isTauri) return null;
    const {open} = await plugin();
    const picked = await open({...opts, multiple: false});
    return typeof picked === 'string' ? picked : null;
}
