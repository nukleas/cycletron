/**
 * Command palette (Cmd+Shift+P) — universal launcher.
 *
 * Three sources of items:
 *   - "Commands": built-in actions (play, save, new file, preferences, …)
 *   - "Files": every `.strudel`/`.js` in the user library (lazy-scanned)
 *   - "Recent": last 10 files from the Rust-side recents list
 *
 * Substring match, case-insensitive. Recent + Files are prefixed with their
 * own section header. Built-ins always appear first when the query is empty
 * or matches a command title.
 */

import {fileManager} from './file-manager.js';
import {aboutModal} from './about-modal.js';
import {preferencesModal} from './preferences.js';
import {midiLab} from './midi-lab.js';
import {audioRecorder} from './audio-recorder.js';
import {checkForUpdates} from './updater.js';
import {dismissibleModal} from './modal-utils.js';
import {logsModal} from './logs-modal.js';

const isTauri = !!(window as any).__TAURI__;

interface Item {
    id: string;
    title: string;
    subtitle?: string;
    section: 'Commands' | 'Files' | 'Recent';
    hint?: string;
    run: () => void | Promise<void>;
}

interface DirEntry { name: string; path: string; is_dir: boolean }

class CommandPalette {
    private root: HTMLElement | null = null;
    private input: HTMLInputElement | null = null;
    private listEl: HTMLElement | null = null;

    private items: Item[] = [];
    private filtered: Item[] = [];
    private activeIdx = 0;
    private cleanup: (() => void) | null = null;

    init(): void {
        this.root = document.getElementById('commandPalette');
        this.input = document.getElementById('cmdPaletteInput') as HTMLInputElement | null;
        this.listEl = document.getElementById('cmdPaletteList');
        if (!this.root || !this.input || !this.listEl) return;

        this.input.addEventListener('input', () => this.refilter());
        this.input.addEventListener('keydown', (e) => this.onKey(e));
        this.listEl.addEventListener('click', (e) => {
            const row = (e.target as Element).closest('[data-idx]') as HTMLElement | null;
            if (!row) return;
            const idx = parseInt(row.dataset.idx ?? '-1', 10);
            if (this.filtered[idx]) void this.run(this.filtered[idx]);
        });

        // Cmd+Shift+P / Ctrl+Shift+P → open palette.
        document.addEventListener('keydown', (e) => {
            const meta = e.metaKey || e.ctrlKey;
            if (meta && e.shiftKey && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                void this.open();
            }
        });
    }

    async open(): Promise<void> {
        if (!this.root || !this.input || !this.listEl) return;
        // Re-collect items every open so file lists stay fresh.
        this.items = await collectItems();
        this.input.value = '';
        this.refilter();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
        // Focus + select after the next frame so the dismissible modal's
        // Esc handler doesn't see this open as the trigger event.
        requestAnimationFrame(() => {
            this.input?.focus();
            this.input?.select();
        });
    }

    private close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private onKey(e: KeyboardEvent): void {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.move(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.move(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = this.filtered[this.activeIdx];
            if (item) void this.run(item);
        }
    }

    private move(delta: number): void {
        if (this.filtered.length === 0) return;
        this.activeIdx = (this.activeIdx + delta + this.filtered.length) % this.filtered.length;
        this.render();
        // Scroll the active row into view.
        const el = this.listEl?.querySelector<HTMLElement>('.cmd-palette-row.active');
        el?.scrollIntoView({block: 'nearest'});
    }

    private async run(item: Item): Promise<void> {
        this.close();
        try {
            await item.run();
        } catch (e) {
            console.warn('[command-palette] run failed:', e);
        }
    }

    private refilter(): void {
        const q = (this.input?.value ?? '').trim().toLowerCase();
        if (!q) {
            this.filtered = this.items.slice(0, 60);
        } else {
            this.filtered = this.items
                .map((item) => ({item, score: score(item, q)}))
                .filter((r) => r.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 60)
                .map((r) => r.item);
        }
        this.activeIdx = 0;
        this.render();
    }

    private render(): void {
        if (!this.listEl) return;
        if (this.filtered.length === 0) {
            this.listEl.innerHTML = '<div class="cmd-palette-empty">No matches.</div>';
            return;
        }
        // Group consecutive items by section.
        let lastSection: Item['section'] | null = null;
        let html = '';
        this.filtered.forEach((item, idx) => {
            if (item.section !== lastSection) {
                html += `<div class="cmd-palette-section">${item.section}</div>`;
                lastSection = item.section;
            }
            html += `
                <div class="cmd-palette-row ${idx === this.activeIdx ? 'active' : ''}" data-idx="${idx}" role="option">
                    <span class="cmd-palette-icon">${iconFor(item.section)}</span>
                    <span>
                        <div class="cmd-palette-title">${escapeHtml(item.title)}</div>
                        ${item.subtitle ? `<div class="cmd-palette-subtitle">${escapeHtml(item.subtitle)}</div>` : ''}
                    </span>
                    <span class="cmd-palette-hint">${item.hint ?? ''}</span>
                </div>
            `;
        });
        this.listEl.innerHTML = html;
    }
}

// ------------------------------------------------------------------
// Items
// ------------------------------------------------------------------

const COMMANDS: Item[] = [
    {id: 'cmd.new',         title: 'New File',              section: 'Commands', hint: '⌘N',     run: () => fileManager.newFile()},
    {id: 'cmd.open',        title: 'Open File…',            section: 'Commands', hint: '⌘O',     run: () => fileManager.openFile()},
    {id: 'cmd.save',        title: 'Save',                  section: 'Commands', hint: '⌘S',     run: () => { void fileManager.saveCurrent(); }},
    {id: 'cmd.save_as',     title: 'Save As…',              section: 'Commands', hint: '⌘⇧S',    run: () => { void fileManager.saveAs(); }},
    {id: 'cmd.play_pause',  title: 'Play / Pause',          section: 'Commands', hint: '⌘↩',     run: () => { void window.strudelApp?.togglePlayPause?.(); }},
    {id: 'cmd.stop',        title: 'Stop Playback',         section: 'Commands', hint: 'Esc',    run: () => window.strudelApp?.stop?.()},
    {id: 'cmd.record',      title: 'Toggle Recording',      section: 'Commands',                 run: () => { void audioRecorder.toggle(); }},
    {id: 'cmd.midi',        title: 'Open MIDI Lab…',        section: 'Commands',                 run: () => { void midiLab.openEmpty(); }},
    {id: 'cmd.preferences', title: 'Preferences…',          section: 'Commands', hint: '⌘,',     run: () => { void preferencesModal.open(); }},
    {id: 'cmd.about',       title: 'About Robostrudel',     section: 'Commands',                 run: () => { void aboutModal.open(); }},
    {id: 'cmd.updates',     title: 'Check for Updates',     section: 'Commands',                 run: () => { void checkForUpdates(true); }},
    {id: 'cmd.logs',        title: 'Show Logs…',            section: 'Commands',                 run: () => { void logsModal.open(); }},
    {id: 'cmd.toggle_ai',   title: 'Toggle AI Panel',       section: 'Commands',                 run: () => document.getElementById('aiPanel')?.classList.toggle('collapsed')},
    {id: 'cmd.toggle_files',title: 'Toggle Files Panel',    section: 'Commands',                 run: () => document.getElementById('filesPanel')?.classList.toggle('collapsed')},
    {id: 'cmd.tempo_up',    title: 'Tempo +1 BPM',          section: 'Commands',                 run: () => adjustBpm(1)},
    {id: 'cmd.tempo_down',  title: 'Tempo −1 BPM',          section: 'Commands',                 run: () => adjustBpm(-1)},
    {id: 'cmd.clear_session', title: 'Clear AI Session',    section: 'Commands',                 run: async () => {
        await invoke('clear_session');
        document.dispatchEvent(new CustomEvent('session:cleared'));
    }},
];

async function collectItems(): Promise<Item[]> {
    const out: Item[] = [...COMMANDS];

    if (!isTauri) return out;

    // Recent files first (most recently opened on top).
    try {
        const recents = await invoke<string[]>('get_recents');
        for (const path of recents.slice(0, 10)) {
            out.push({
                id: `recent:${path}`,
                title: basename(path),
                subtitle: path,
                section: 'Recent',
                run: () => fileManager.openPath(path),
            });
        }
    } catch { /* ignore */ }

    // Library files — shallow walk so this stays fast.
    try {
        const root = await invoke<string>('get_library_root');
        const found: DirEntry[] = await walkLibrary(root, 0, 3);
        for (const entry of found) {
            if (entry.is_dir) continue;
            out.push({
                id: `file:${entry.path}`,
                title: entry.name,
                subtitle: entry.path,
                section: 'Files',
                run: () => fileManager.openPath(entry.path),
            });
        }
    } catch { /* ignore */ }

    return out;
}

async function walkLibrary(path: string, depth: number, maxDepth: number): Promise<DirEntry[]> {
    let entries: DirEntry[];
    try {
        entries = await invoke<DirEntry[]>('list_library', {path});
    } catch {
        return [];
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
        if (e.is_dir) {
            if (depth < maxDepth) {
                out.push(...(await walkLibrary(e.path, depth + 1, maxDepth)));
            }
        } else {
            out.push(e);
        }
    }
    return out;
}

// ------------------------------------------------------------------
// Scoring + helpers
// ------------------------------------------------------------------

function score(item: Item, q: string): number {
    const title = item.title.toLowerCase();
    const subtitle = (item.subtitle ?? '').toLowerCase();
    if (title === q) return 1000;
    if (title.startsWith(q)) return 500 - title.length;
    const tIdx = title.indexOf(q);
    if (tIdx >= 0) return 200 - tIdx - title.length * 0.01;
    const sIdx = subtitle.indexOf(q);
    if (sIdx >= 0) return 100 - sIdx;
    // Subsequence match (e.g. "opnf" matches "Open File").
    let i = 0;
    for (const ch of title) {
        if (ch === q[i]) i++;
        if (i === q.length) return 50;
    }
    return 0;
}

function iconFor(section: Item['section']): string {
    return section === 'Commands' ? '⚡' : section === 'Files' ? '▤' : '↻';
}

function adjustBpm(delta: number): void {
    const slider = document.getElementById('bpmSlider') as HTMLInputElement | null;
    if (!slider) return;
    const next = Math.max(30, Math.min(300, parseInt(slider.value, 10) + delta));
    window.strudelApp?.applyBpm?.(next);
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}

export const commandPalette = new CommandPalette();
(window as any).commandPalette = commandPalette;
