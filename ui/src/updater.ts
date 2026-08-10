/**
 * Update checking + install. Wraps `@tauri-apps/plugin-updater` so the
 * UI can call a single `checkForUpdates(manual)` and we centralise the
 * "no endpoint configured" branch and the user-facing dialog.
 *
 * Triggered by:
 *   - Help → Check for Updates… (manual: true)
 *   - Startup, when `userSettings.updater.auto_check` is on AND an endpoint
 *     is configured (manual: false — silent if nothing's available)
 */

import {confirmDialog, infoDialog} from './dialog.js';
import {isTauri} from './tauri.js';

let inFlight = false;

export async function checkForUpdates(manual: boolean): Promise<void> {
    if (!isTauri) {
        if (manual) console.warn('[updater] only available in desktop build');
        return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
        // Import the updater + dialog lazily so the bundle stays light.
        let updater: any;
        try {
            updater = await import('@tauri-apps/plugin-updater');
        } catch (e) {
            if (manual) await infoDialog(`Updater unavailable in this build:\n${e}`);
            return;
        }

        let update: any;
        try {
            update = await updater.check();
        } catch (e: any) {
            // No endpoint configured at build time, or fetch failed.
            if (manual) {
                await infoDialog(
                    "Couldn't reach the update endpoint.\n\n" +
                    "If you're running a development build, configure " +
                    "`plugins.updater.endpoints` in tauri.conf.json and " +
                    "generate signing keys with `tauri signer generate`.\n\n" +
                    `Details: ${e}`,
                );
            }
            return;
        }
        if (!update) {
            if (manual) await infoDialog("You're up to date.");
            return;
        }
        const accept = await confirmDialog(
            `Cycletron ${update.version} is available.\n\nDownload and install now?`,
            {title: 'Update available', kind: 'info'},
        );
        if (!accept) return;
        await update.downloadAndInstall();
        // Plugin will trigger a relaunch on macOS/Windows automatically once
        // installation completes; on Linux some bundles require explicit
        // relaunch.
        try {
            const {relaunch} = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch {
            // No-op — relaunch isn't critical if the updater handles it.
        }
    } catch (e: any) {
        console.warn('[updater] check failed:', e);
        if (manual) await infoDialog(`Update check failed:\n${e}`);
    } finally {
        inFlight = false;
    }
}

