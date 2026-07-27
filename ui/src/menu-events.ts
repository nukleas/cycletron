/**
 * Receives `menu:*` events from the Rust menu and dispatches them
 * to the appropriate frontend module.
 */

import {invoke} from './tauri.js';
import {escapeHtml} from './html.js';
import {fileManager} from './file-manager.js';
import {midiLab} from './midi-lab.js';
import {aboutModal} from './about-modal.js';
import {preferencesModal} from './preferences.js';
import {checkForUpdates} from './updater.js';
import {logsModal} from './logs-modal.js';
import {welcomeModal} from './welcome-modal.js';
import {helpModal} from './help-modal.js';
import {diag} from './diagnostics.js';
import {openExternal} from './external-link.js';

const isTauri = !!(window as any).__TAURI__;

export async function initMenuEvents(): Promise<void> {
    if (!isTauri) return;
    const {listen} = (window as any).__TAURI__.event;

    const simple: Record<string, () => void | Promise<void>> = {
        'menu:new': () => fileManager.newFile(),
        'menu:open': () => fileManager.openFile(),
        'menu:save': async () => { await fileManager.saveCurrent(); },
        'menu:save_as': async () => { await fileManager.saveAs(); },
        'menu:import_midi': () => midiLab.openEmpty(),
        'menu:clear_session': async () => {
            await invoke('clear_session');
            document.dispatchEvent(new CustomEvent('session:cleared'));
        },
        'menu:toggle_ai': () => {
            document.getElementById('aiPanel')?.classList.toggle('collapsed');
        },
        'menu:toggle_corpus': () => {
            document.getElementById('corpusPanel')?.classList.toggle('corpus-hidden');
        },
        'menu:browse_examples': () => {
            document.getElementById('browseExamples')?.click();
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
        'menu:immersive_viz': () => { void (window as any).strudelApp?.toggleImmersiveViz?.(); },
        'menu:next_viz': () => { void (window as any).strudelApp?.cycleImmersiveVizMode?.(); },
    };

    for (const [topic, handler] of Object.entries(simple)) {
        await listen(topic, () => {
            void diag('info', 'menu', `received ${topic}`);
            void handler();
        });
    }

    // Recent-files picker — the backend sends the list, we show a simple overlay.
    await listen('menu:open_recent', async (e: any) => {
        const list = (e.payload as string[] | null) ?? [];
        void diag('info', 'menu', `received menu:open_recent (${list.length} entries)`);
        const picked = await pickFromList('Open Recent', list);
        if (picked) await fileManager.openPath(picked);
    });

    void diag('info', 'menu', `menu listeners installed (${Object.keys(simple).length} topics)`);
}

function adjustBpm(delta: number): void {
    const slider = document.getElementById('bpmSlider') as HTMLInputElement | null;
    if (!slider) return;
    const next = Math.max(30, Math.min(300, parseInt(slider.value, 10) + delta));
    window.strudelApp?.applyBpm?.(next);
}

/**
 * Minimal list picker overlay — used by `Open Recent`. Stays DOM-only
 * (no modals library) to keep bundle size down.
 */
function pickFromList(title: string, items: string[]): Promise<string | null> {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'picker-overlay';
        const empty = items.length === 0
            ? '<div class="picker-empty">No recent files yet</div>'
            : '';
        overlay.innerHTML = `
            <div class="picker-modal">
                <div class="picker-header">
                    <span class="picker-title">${escapeHtml(title)}</span>
                    <button class="picker-close" aria-label="Close">&times;</button>
                </div>
                ${empty}
                <div class="picker-list">
                    ${items.map((p, i) => `
                        <button class="picker-item" data-idx="${i}">
                            <span class="picker-item-name">${escapeHtml(basename(p))}</span>
                            <span class="picker-item-path">${escapeHtml(p)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        const buttons = () => Array.from(overlay.querySelectorAll<HTMLButtonElement>('.picker-item'));
        let focusIdx = 0;

        const close = (value: string | null) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(value);
        };
        const moveFocus = (delta: number) => {
            const btns = buttons();
            if (btns.length === 0) return;
            focusIdx = (focusIdx + delta + btns.length) % btns.length;
            btns[focusIdx].focus();
            btns[focusIdx].scrollIntoView({block: 'nearest'});
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(null);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveFocus(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveFocus(-1);
            } else if (e.key === 'Enter') {
                const btns = buttons();
                if (btns.length > 0) {
                    e.preventDefault();
                    close(items[focusIdx]);
                }
            }
        };
        overlay.addEventListener('click', (e) => {
            const t = e.target as HTMLElement;
            if (t === overlay || t.classList.contains('picker-close')) close(null);
            const item = t.closest('.picker-item') as HTMLElement | null;
            if (item) {
                const idx = parseInt(item.dataset.idx!, 10);
                close(items[idx]);
            }
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        // Focus the first item so Enter/arrows work immediately.
        requestAnimationFrame(() => {
            buttons()[0]?.focus();
        });
    });
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}
