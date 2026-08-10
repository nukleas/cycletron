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
import {openExternal} from './external-link.js';
import {notify} from './notifications.js';
import {invoke, isTauri} from './tauri.js';

const RELEASES_URL = 'https://github.com/nukleas/cycletron/releases/latest';

let inFlight = false;

/**
 * Minimal in-window progress toast. downloadAndInstall() can take a while on
 * a ~70 MB bundle and otherwise gives zero feedback — the window just sits
 * there until the app restarts.
 */
let toastEl: HTMLDivElement | null = null;
let toastBarEl: HTMLDivElement | null = null;
let toastTextEl: HTMLSpanElement | null = null;

function showToast(text: string, fraction: number | null): void {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
            'min-width:240px', 'padding:10px 14px',
            'background:var(--bg-lighter, #111827)',
            'border:1px solid var(--border, #26324c)',
            'border-radius:6px',
            'color:var(--text, #f2f7ff)',
            'font:12px/1.5 ui-monospace, monospace', 'letter-spacing:0.04em',
            'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
        ].join(';');
        toastTextEl = document.createElement('span');
        toastEl.appendChild(toastTextEl);
        const track = document.createElement('div');
        track.style.cssText =
            'margin-top:8px;height:3px;border-radius:2px;background:var(--accent-subtle, rgba(71,246,255,0.12));overflow:hidden';
        toastBarEl = document.createElement('div');
        toastBarEl.style.cssText =
            'height:100%;width:0%;background:var(--accent, #47f6ff);transition:width 0.15s linear';
        track.appendChild(toastBarEl);
        toastEl.appendChild(track);
        document.body.appendChild(toastEl);
    }
    if (toastTextEl) toastTextEl.textContent = text;
    if (toastBarEl) {
        // Indeterminate phases (installing/restarting) show a full bar.
        toastBarEl.style.width = `${Math.round((fraction ?? 1) * 100)}%`;
    }
}

function hideToast(): void {
    toastEl?.remove();
    toastEl = toastBarEl = toastTextEl = null;
}

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
        // deb/rpm/pacman installs are owned by the system package manager —
        // the plugin's self-update path can't work there (and fails silently
        // on distros without dpkg/rpm). Notify instead of pretending.
        let installKind = 'native';
        try {
            installKind = await invoke<string>('updater_install_kind');
        } catch {
            // Older backend without the command — assume self-update works.
        }
        if (installKind === 'package') {
            if (manual) {
                const open = await confirmDialog(
                    `Cycletron ${update.version} is available.\n\n` +
                    'This install is managed by your system package manager, ' +
                    "so the app can't update itself. Open the releases page?",
                    {title: 'Update available', kind: 'info'},
                );
                if (open) await openExternal(RELEASES_URL);
            } else {
                void notify(
                    `Cycletron ${update.version} available`,
                    'Update via your package manager.',
                );
            }
            return;
        }
        const accept = await confirmDialog(
            `Cycletron ${update.version} is available.\n\nDownload and install now?`,
            {title: 'Update available', kind: 'info'},
        );
        if (!accept) return;
        let total = 0;
        let received = 0;
        showToast(`Downloading ${update.version}…`, 0);
        try {
            await update.downloadAndInstall((event: any) => {
                switch (event?.event) {
                    case 'Started':
                        total = Number(event.data?.contentLength) || 0;
                        break;
                    case 'Progress':
                        received += Number(event.data?.chunkLength) || 0;
                        if (total > 0) {
                            const pct = Math.min(received / total, 1);
                            showToast(
                                `Downloading ${update.version}… ${Math.round(pct * 100)}%`,
                                pct,
                            );
                        } else {
                            showToast(
                                `Downloading ${update.version}… ${(received / 1048576).toFixed(1)} MB`,
                                null,
                            );
                        }
                        break;
                    case 'Finished':
                        showToast('Installing…', null);
                        break;
                }
            });
        } catch (e: any) {
            hideToast();
            await infoDialog(`Update failed:\n${e}`);
            return;
        }
        showToast('Restarting…', null);
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

