/**
 * Receives `menu:*` events from the Rust menu and dispatches them
 * to the appropriate frontend module.
 */

import {invoke, isTauri, listen} from './tauri.js';
import {adjustBpm} from './bpm.js';
import {clearSession, toggleAiPanel} from './ai-bridge.js';
import {fileManager} from './file-manager.js';
import {midiLab} from './midi-lab.js';
import {aboutModal} from './about-modal.js';
import {preferencesModal} from './preferences.js';
import {checkForUpdates} from './updater.js';
import {logsModal} from './logs-modal.js';
import {welcomeModal} from './welcome-modal.js';
import {helpModal} from './help-modal.js';
import {diag} from './diagnostics.js';
import {notify} from './notifications.js';
import {openExternal} from './external-link.js';


export async function initMenuEvents(): Promise<void> {
    if (!isTauri) return;

    const simple: Record<string, () => void | Promise<void>> = {
        'menu:new': () => fileManager.newFile(),
        'menu:open': () => fileManager.openFile(),
        'menu:save': async () => { await fileManager.saveCurrent(); },
        'menu:save_as': async () => { await fileManager.saveAs(); },
        'menu:import_midi': () => { void midiLab.openWithPicker(); },
        'menu:export_audio': () => { void fileManager.exportAudio(); },
        'menu:export_midi': () => { void fileManager.exportMidi(); },
        'menu:clear_session': () => clearSession(),
        'menu:toggle_ai': () => {
            toggleAiPanel();
        },
        'menu:browse_examples': () => {
            document.getElementById('browseExamples')?.click();
        },
        'menu:reload_corpus': async () => {
            try {
                const n = await invoke<number>('reload_corpus');
                void notify('Corpus reloaded', `${n} genre recipe${n === 1 ? '' : 's'} now loaded.`);
            } catch (e) {
                void notify('Corpus reload failed', String(e));
            }
        },
        'menu:play_pause': () => {
            void window.strudelApp?.togglePlayPause?.();
        },
        'menu:stop': () => window.strudelApp?.stop?.(),
        'menu:tempo_up': () => adjustBpm(1),
        'menu:tempo_down': () => adjustBpm(-1),
        'menu:undo': async () => {
            const code = await invoke<string | null>('session_undo');
            if (code != null) void window.strudelApp?.replaceCodeAndPlay?.(code);
        },
        'menu:redo': async () => {
            const code = await invoke<string | null>('session_redo');
            if (code != null) void window.strudelApp?.replaceCodeAndPlay?.(code);
        },
        'menu:docs': () => { void openExternal('https://strudel.cc/learn/'); },
        'menu:user_guide': () => { helpModal.open('guide'); },
        'menu:shortcuts': () => { helpModal.open('shortcuts'); },
        'menu:dialect': () => { helpModal.open('dialect'); },
        'menu:about': () => { void aboutModal.open(); },
        'menu:preferences': () => { void preferencesModal.open(); },
        'menu:check_updates': () => { void checkForUpdates(true); },
        'menu:show_logs': () => { void logsModal.open(); },
        'menu:welcome': () => { void welcomeModal.openExplicit(); },
        'menu:immersive_viz': () => { void window.strudelApp?.toggleImmersiveViz?.(); },
        'menu:next_viz': () => { void window.strudelApp?.cycleImmersiveVizMode?.(); },
    };

    for (const [topic, handler] of Object.entries(simple)) {
        await listen(topic, () => {
            void diag('info', 'menu', `received ${topic}`);
            void handler();
        });
    }

    void diag('info', 'menu', `menu listeners installed (${Object.keys(simple).length} topics)`);
}
