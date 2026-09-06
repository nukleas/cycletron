/**
 * Boot wires the Tauri-only app chrome into the existing StrudelApp:
 *   - file manager (open/save/new/recents, dirty tracking)
 *   - native menu event listeners
 *   - drag-and-drop of .strudel/.js
 *   - corpus browser panel
 *   - session autosave + restore
 *   - title bar / status bar updates reflecting current file
 *   - global shortcuts (app-local): Cmd+O/S/Shift+S/N
 */

import {invoke, isTauri} from './tauri.js';
import {confirmDialog} from './dialog.js';
import {fileManager} from './file-manager.js';
import {initMenuEvents} from './menu-events.js';
import {initDragDrop} from './drag-drop.js';
import {soundsBrowser} from './sounds-browser.js';
import {fileExplorer} from './file-explorer.js';
import {midiLab} from './midi-lab.js';
import {aboutModal} from './about-modal.js';
import {samplesModal} from './samples-modal.js';
import {helpModal} from './help-modal.js';
import {preferencesModal} from './preferences.js';
import {audioRecorder} from './audio-recorder.js';
import {commandPalette} from './command-palette.js';
import {historyModal} from './history-modal.js';
import {metronome} from './metronome.js';
import {stage} from './stage.js';
import {midiInput} from './midi-input.js';
import {welcomeModal} from './welcome-modal.js';
import {logsModal} from './logs-modal.js';
import {checkForUpdates} from './updater.js';
import {notify} from './notifications.js';
import {initPlaybackBridge} from './playback-bridge.js';
import {initDesktopTheme} from './desktop-theme.js';
import {diag} from './diagnostics.js';
import {fileMenuButton} from './file-menu-button.js';
import {editorEmptyState} from './editor-empty-state.js';
import {basename} from './paths.js';
import {currentBpm} from './bpm.js';
import {toolRowFromTrace} from './ai-tool-row.js';
import type {SessionSnapshot, UserSettings} from './types/tauri-commands.js';


document.addEventListener('DOMContentLoaded', () => {
    // Scrub any coi-serviceworker left over from previous dev sessions.
    // The SW intercepts fetches, appends COOP/COEP headers, and forces a
    // reload — that reload loop leaves SharedArrayBuffer unreachable in
    // Tauri's WKWebView. Vite (dev) and Tauri (prod) both serve the
    // headers natively, so the SW is redundant and harmful here.
    void unregisterStaleServiceWorkers();

    setupTitleBar();
    setupAppShortcuts();
    // Outside boot(): Stage Mode is pure frontend — it needs neither Tauri nor
    // audio, and boot() returns early without a Tauri shell. Wiring it here
    // means ⌘⇧F works from the moment the page is up, including in a browser.
    stage.init();
    void boot();
});

async function unregisterStaleServiceWorkers(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.length === 0) return;
        console.warn('[boot] unregistering stale service workers:', regs.length);
        await Promise.all(regs.map(r => r.unregister()));
        // A leftover SW was controlling this page; reload once so the
        // next load is SW-free and SharedArrayBuffer is exposed cleanly.
        if (navigator.serviceWorker.controller) {
            location.reload();
        }
    } catch (e) {
        console.warn('[boot] service worker scrub failed:', e);
    }
}

function setupTitleBar(): void {
    const fileNameEl = document.getElementById('currentFileName');

    const update = (detail: {name: string; dirty: boolean}) => {
        const marker = detail.dirty ? ' •' : '';
        document.title = `Cycletron — ${detail.name}${marker}`;
        if (fileNameEl) {
            fileNameEl.textContent = `${detail.name}${marker}`;
            fileNameEl.classList.toggle('status-file--dirty', detail.dirty);
        }
    };

    // Initial state
    update({name: 'untitled', dirty: false});

    document.addEventListener('file:changed', ((e: CustomEvent) => {
        update({
            name: e.detail?.name ?? 'untitled',
            dirty: !!e.detail?.dirty,
        });
    }) as EventListener);
}

function setupAppShortcuts(): void {
    document.addEventListener('keydown', (e) => {
        const meta = e.ctrlKey || e.metaKey;
        if (!meta) return;
        const key = e.key.toLowerCase();
        // Don't intercept text-level undo/redo (CodeMirror owns those).
        if (key === 'o' && !e.shiftKey) {
            e.preventDefault();
            void fileManager.openFile();
        } else if (key === 's' && !e.shiftKey) {
            e.preventDefault();
            void fileManager.saveCurrent();
        } else if (key === 's' && e.shiftKey) {
            e.preventDefault();
            void fileManager.saveAs();
        } else if (key === 'n' && !e.shiftKey) {
            e.preventDefault();
            void fileManager.newFile();
        }
    }, true);

    // Close confirmation if the buffer is dirty.
    window.addEventListener('beforeunload', (e) => {
        if (fileManager.isDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

async function boot(): Promise<void> {
    if (!isTauri) {
        console.log('[boot] not running in Tauri — file management disabled');
        return;
    }

    // Wait for the StrudelApp instance that app.ts sets up on DOMContentLoaded.
    await waitForStrudelApp();

    // Pipe editor changes into the dirty tracker.
    hookEditorChanges();

    // Pure-DOM modals: wire eagerly so menu / Cmd+, work before the
    // parallel init below completes.
    midiLab.init();
    aboutModal.init();
    samplesModal.init();
    helpModal.init();
    preferencesModal.init();
    audioRecorder.init();
    commandPalette.init();
    historyModal.init();
    metronome.init();
    welcomeModal.init();
    logsModal.init();
    fileMenuButton.init();
    editorEmptyState.init();
    void midiInput.init();
    void applyPhase4Settings();
    setupMidiLabTriggers();
    setupOpenFilesListener();
    setupExternalChangeListener();

    // Stand up subsystems in parallel.
    await Promise.all([
        initMenuEvents(),
        initDragDrop(),
        soundsBrowser.init(),
        fileManager.init(),
        fileExplorer.init(),
        initPlaybackBridge(),
        restoreIfAny(),
    ]);

    // Update check on startup — silent if nothing's available, and a no-op
    // when no endpoint is configured.
    void maybeAutoCheckUpdates();

    // Onboarding: opens itself only if first_run_done is false.
    void welcomeModal.maybeOpen();

    // Autosave on significant events — the backend throttles internally.
    setupAutosave();
}

function setupMidiLabTriggers(): void {
    document.getElementById('editorMidiBtn')?.addEventListener('click', () => {
        void midiLab.openEmpty();
    });
    document.getElementById('filesMidiImport')?.addEventListener('click', () => {
        void midiLab.openEmpty();
    });
    document.getElementById('historyBtn')?.addEventListener('click', () => {
        void historyModal.open();
    });
    // Allow keyboard shortcut Cmd+, for Preferences alongside the menu.
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === ',') {
            e.preventDefault();
            void preferencesModal.open();
        }
    });
}

/** Listen for the Rust `open-files` event emitted by the single-instance
 *  hand-off (i.e. user double-clicks a .strudel/.mid in Finder). */
function setupOpenFilesListener(): void {
    if (!isTauri) return;
    const event = window.__TAURI__?.event;
    if (!event?.listen) return;
    void event.listen('open-files', async (e: any) => {
        const paths: string[] = e.payload ?? [];
        void diag('info', 'open-files', `received ${paths.length} path(s): ${paths.join(', ')}`);
        for (const p of paths) {
            if (/\.(mid|midi)$/i.test(p)) {
                await midiLab.openWithFile(p);
            } else if (/\.(strudel|js)$/i.test(p)) {
                await fileManager.openPath(p);
            }
        }
    });
}

/** Listen for the Rust `file-externally-changed` event and reconcile:
 *  - clean buffer → silently reload
 *  - dirty buffer → prompt the user
 *  - window not focused → also fire a notification */
function setupExternalChangeListener(): void {
    if (!isTauri) return;
    const event = window.__TAURI__?.event;
    if (!event?.listen) return;
    void event.listen('file-externally-changed', async (e: any) => {
        const path: string | null = e.payload ?? null;
        if (!path) return;
        // Ignore the event if we just saved this file ourselves; the file
        // manager's dirty flag is a good enough proxy.
        if (fileManager.filePath !== path) return;

        if (!document.hasFocus()) {
            void notify('File changed on disk', basename(path));
        }

        if (!fileManager.isDirty) {
            await fileManager.openPath(path, {force: true});
            return;
        }
        const reload = await confirmDialog(
            `"${basename(path)}" changed on disk. Discard your unsaved changes and reload?`,
            {kind: 'warning'},
        );
        if (reload) await fileManager.openPath(path, {force: true});
    });
}

async function maybeAutoCheckUpdates(): Promise<void> {
    if (!isTauri) return;
    try {
        const settings = await invoke<UserSettings>('get_user_settings');
        if (!settings.updater.auto_check) return;
        await checkForUpdates(false);
    } catch (e) {
        console.warn('[boot] auto update check failed:', e);
    }
}

/** Restore Phase 4 user state (metronome enabled/volume, MIDI device + CC
 *  mappings) once settings load. Persisting the *enabled* state for the
 *  metronome is intentionally fire-and-forget — toggling shouldn't block. */
async function applyPhase4Settings(): Promise<void> {
    if (!isTauri) return;
    try {
        const settings = await invoke<UserSettings>('get_user_settings');
        // Rust settings are authoritative — reconcile the editor's localStorage-
        // seeded assist state with the saved value (skip if already in sync so we
        // don't reconfigure the editor on every launch).
        const assist = settings.editor?.assist_enabled ?? true;
        const editor = window.strudelApp?.editor;
        if (editor && editor.isAssistEnabled() !== assist) editor.setAssistEnabled(assist);
        metronome.applyFromSettings(settings.metronome ?? {enabled: false, volume: 0.4});
        await initDesktopTheme(!!settings.follow_desktop_theme);
        midiInput.applyFromSettings(settings.midi_input ?? {
            device_id: null, cc_gain: 7, cc_bpm: 74,
            monitor_enabled: false, monitor_instrument: 'sawtooth', monitor_gain: 0.8,
            pad_assignments: [],
        });
    } catch (e) {
        console.warn('[boot] Phase 4 settings restore failed:', e);
    }
}

function waitForStrudelApp(): Promise<void> {
    return new Promise(resolve => {
        const check = () => {
            if (window.strudelApp?.editor) return resolve();
            requestAnimationFrame(check);
        };
        check();
    });
}

let autosaveHook: ((code: string) => void) | null = null;

function hookEditorChanges(): void {
    const app = window.strudelApp;
    if (!app) return;
    const orig = app.onCodeChange;
    app.onCodeChange = (code: string) => {
        fileManager.onEditorChange(code);
        autosaveHook?.(code);
        orig.call(app, code);
    };
}

async function restoreIfAny(): Promise<void> {
    try {
        const snap = await invoke<SessionSnapshot | null>('restore_session');
        if (!snap) return;

        // Restore the chat history into the DOM (ai-bridge owns the container).
        const msgsEl = document.getElementById('aiMessages');
        if (msgsEl && snap.messages.length > 0) {
            document.dispatchEvent(new Event('session:restored'));
            msgsEl.innerHTML = '';
            for (const m of snap.messages) {
                if (m.role === 'system') continue;
                const div = document.createElement('div');
                div.className = `ai-msg ai-msg-${m.role}`;
                // Same shape as a live assistant turn: tool rows, then prose.
                if (m.tools?.length) {
                    const tools = document.createElement('div');
                    tools.className = 'ai-tools';
                    for (const t of m.tools) tools.appendChild(toolRowFromTrace(t));
                    div.appendChild(tools);
                }
                const body = document.createElement('div');
                body.className = 'ai-msg-body';
                body.textContent = m.content;
                div.appendChild(body);
                msgsEl.appendChild(div);
            }
        }

        // BPM and code
        if (snap.bpm) window.strudelApp?.applyBpm?.(snap.bpm);
        if (snap.code) window.strudelApp?.editor?.setCode?.(snap.code);

        // File metadata
        if (snap.file_path) {
            const name = basename(snap.file_path);
            document.dispatchEvent(new CustomEvent('file:changed', {
                detail: {path: snap.file_path, name, dirty: false},
            }));
            // Treat restored file as clean: sync the file-manager cache.
            fileManager.applyCurrentFile({
                path: snap.file_path,
                name,
                dirty: false,
            });
        }
    } catch (e) {
        console.warn('[boot] restore failed:', e);
    }
}

function setupAutosave(): void {
    let scheduled = false;
    const trigger = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(async () => {
            scheduled = false;
            const code = window.strudelApp?.editor?.getCode?.() ?? '';
            const bpm = currentBpm();
            try {
                await invoke('autosave_session', {code, bpm});
            } catch (e) {
                console.warn('[autosave] failed:', e);
            }
        }, 1500);
    };

    // hookEditorChanges already wrapped app.onCodeChange; we just install
    // the autosave trigger into the shared hook slot.
    autosaveHook = () => trigger();

    // Autosave on window blur so the most recent state is always on disk.
    window.addEventListener('blur', trigger);
}
