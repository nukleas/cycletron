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

import {infoDialog} from './dialog.js';
import {openExternal} from './external-link.js';
import {escapeHtml} from './html.js';
import {renderDocToHtml} from './markdown.js';
import {dismissibleModal} from './modal-utils.js';
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

/**
 * The update prompt: the new release's notes (latest.json `notes`, which the
 * plugin hands over as `update.body`) under a one-line lead. Resolves true
 * when the user picks the confirm button, false for Later or a dismiss.
 */
function askToUpdate(version: string, notes: string | undefined, lead: string, confirmLabel: string): Promise<boolean> {
    const root = document.getElementById('updateModal');
    const body = document.getElementById('updateBody');
    const confirm = document.getElementById('updateConfirm');
    if (!root || !body || !confirm) return Promise.resolve(false);
    body.innerHTML =
        `<p class="help-lead">Cycletron ${escapeHtml(version)} is available. ${escapeHtml(lead)}</p>` +
        (notes?.trim() ? renderDocToHtml(notes) : '');
    body.scrollTop = 0;
    confirm.textContent = confirmLabel;
    return new Promise(resolve => {
        const finish = (ok: boolean) => {
            root.hidden = true;
            cleanup();
            confirm.removeEventListener('click', onConfirm);
            resolve(ok);
        };
        const onConfirm = () => finish(true);
        confirm.addEventListener('click', onConfirm);
        root.hidden = false;
        const cleanup = dismissibleModal(root, () => finish(false));
    });
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
        // on distros without dpkg/rpm). Notify instead of pretending. If the
        // kind can't be read, don't guess: point at the releases page too.
        const installKind = await invoke<string>('updater_install_kind').catch(() => 'unknown');
        if (installKind !== 'native' && installKind !== 'appimage') {
            const packaged = installKind === 'package';
            if (manual) {
                const open = await askToUpdate(
                    update.version, update.body,
                    packaged
                        ? "Your system package manager owns this install, so update it there; the app can't update itself."
                        : "Couldn't tell how this copy was installed, so it won't update itself. Get the new version from the releases page.",
                    'Open releases page',
                );
                if (open) await openExternal(RELEASES_URL);
            } else {
                void notify(
                    `Cycletron ${update.version} available`,
                    packaged ? 'Update via your package manager.' : 'Get it from the releases page.',
                );
            }
            return;
        }
        const accept = await askToUpdate(
            update.version, update.body, "Here's what's in it.", 'Install and restart',
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
        // The bundle on disk has been swapped; the *running* old app was
        // moved to a temp backup, so anything that resolves the current
        // executable now (plugin-process relaunch, Tauri restart) boots the
        // stale copy. relaunch_app re-opens the install path captured at
        // startup instead. Windows never reaches this — the NSIS installer
        // restarts the app itself.
        try {
            await invoke('relaunch_app');
        } catch (e) {
            console.warn('[updater] relaunch failed:', e);
            await infoDialog(
                'Update installed. Please quit and reopen Cycletron to finish.',
            );
        }
    } catch (e: any) {
        console.warn('[updater] check failed:', e);
        if (manual) await infoDialog(`Update check failed:\n${e}`);
    } finally {
        inFlight = false;
    }
}

