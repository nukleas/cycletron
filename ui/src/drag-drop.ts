/**
 * Tauri drag-drop: dropping a .strudel or .js file onto the window loads it.
 *
 * Tauri v2 emits three related events on the webview:
 *   - tauri://drag-enter   (preview of paths)
 *   - tauri://drag-leave
 *   - tauri://drag-drop    (final — contains paths)
 */

import {isTauri} from './tauri.js';
import {fileManager} from './file-manager.js';
import {packImport} from './pack-import.js';
import {midiLab} from './midi-lab.js';
import {diag} from './diagnostics.js';
import {basename} from './paths.js';

const STRUDEL_EXT = /\.(strudel|js)$/i;
const ZIP_EXT = /\.zip$/i;
/** A dropped folder arrives as a path with no extension. */
const NO_EXT = /(^|[\\/])[^.\\/]+$/;
const MIDI_EXT = /\.(mid|midi)$/i;

// Tracks the last seen Shift state — Tauri drag-drop events don't carry
// modifier flags, so we sample whatever keydown last told us.
let shiftHeld = false;

export async function initDragDrop(): Promise<void> {
    if (!isTauri) {
        void diag('info', 'drag-drop', 'init skipped: not in Tauri');
        return;
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift') shiftHeld = true;
    }, true);
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') shiftHeld = false;
    }, true);

    try {
        const {getCurrentWebview} = await import('@tauri-apps/api/webview');
        const webview = getCurrentWebview();

        await webview.onDragDropEvent((e: any) => {
            const type = e.payload?.type;
            if (type === 'enter' || type === 'over') {
                document.body.classList.add('is-drop-target');
                return;
            }
            if (type === 'leave') {
                document.body.classList.remove('is-drop-target');
                return;
            }
            if (type === 'drop') {
                document.body.classList.remove('is-drop-target');
                const paths: string[] = e.payload?.paths ?? [];
                void diag('info', 'drag-drop', `drop received: ${paths.length} path(s) [${paths.join(', ')}]`);
                handleDrop(paths);
            }
        });
        void diag('info', 'drag-drop', 'onDragDropEvent listener registered');
    } catch (e: any) {
        void diag('error', 'drag-drop', `init failed: ${e?.message ?? e}`);
    }
}

function handleDrop(paths: string[]): void {
    // MIDI takes precedence if present.
    // Default: open the MIDI Lab pre-loaded so the user can tune options.
    // Hold Shift while dropping to bypass the Lab and convert silently
    // (the legacy fast path).
    const midi = paths.find(p => MIDI_EXT.test(p));
    if (midi) {
        if (shiftHeld) {
            flash(`Converting ${basename(midi)}…`);
            void fileManager.importMidiPath(midi);
        } else {
            void midiLab.openWithFile(midi);
        }
        return;
    }
    const strudel = paths.find(p => STRUDEL_EXT.test(p));
    if (strudel) {
        void fileManager.openPath(strudel);
        return;
    }
    // A sample pack: a .zip, or a dropped folder. Extensionless paths go to the
    // importer too — the backend can tell a folder from a stray file and says
    // so precisely, which beats a generic "unsupported" toast.
    const pack = paths.find(p => ZIP_EXT.test(p)) ?? paths.find(p => NO_EXT.test(p));
    if (pack) {
        flash(`Reading ${basename(pack)}…`);
        void packImport.openFromPath(pack);
        return;
    }
    flash(`Unsupported file. Drop .strudel, .js, .mid, a .zip sample pack, or a folder.`);
}


/** Quick status toast via the existing status bar. */
function flash(message: string): void {
    const el = document.getElementById('status');
    if (!el) return;
    const prev = el.textContent;
    el.textContent = message;
    setTimeout(() => {
        if (el.textContent === message) el.textContent = prev;
    }, 2500);
}
