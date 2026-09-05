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
 *
 * Failure contract: a command's `run` is expected to *throw* when it can't do
 * its job — missing app object, missing DOM target, a rejected Tauri invoke.
 * `run()` catches that and surfaces it in a native error dialog (the same
 * channel file-manager uses), so nothing fails silently. Use `requireApp()` /
 * `requireEl()` for the guards rather than optional-chaining into a no-op.
 */

import {invoke, isTauri} from './tauri.js';
import {escapeHtml} from './html.js';
import {fileManager} from './file-manager.js';
import {aboutModal} from './about-modal.js';
import {samplesModal, switchSampleSet} from './samples-modal.js';
import {adjustBpm} from './bpm.js';
import {basename} from './paths.js';
import {clearSession, toggleAiPanel} from './ai-bridge.js';
import {fileExplorer} from './file-explorer.js';
import {helpModal} from './help-modal.js';
import {preferencesModal, persistEditorAssist} from './preferences.js';
import {midiLab} from './midi-lab.js';
import {audioRecorder} from './audio-recorder.js';
import {launchQuantum} from './launch-quantum.js';
import {checkForUpdates} from './updater.js';
import {dismissibleModal} from './modal-utils.js';
import {logsModal} from './logs-modal.js';
import {stage} from './stage.js';
import {errorDialog} from './dialog.js';
import type {SampleSetStatus, UserSettings} from './types/tauri-commands.js';


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
            console.warn('[command-palette] run failed:', item.id, e);
            await reportActionError(item.title, e);
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
        const q = (this.input?.value ?? '').trim();
        const headerHint = !q
            ? '<div class="cmd-palette-tip">Tip: drag files in, press ⌘O to open, or type to filter.</div>'
            : '';
        if (this.filtered.length === 0) {
            this.listEl.innerHTML = headerHint + '<div class="cmd-palette-empty">No matches.</div>';
            return;
        }
        // Group consecutive items by section.
        let lastSection: Item['section'] | null = null;
        let html = headerHint;
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

// Every `run` returns its promise (no fire-and-forget `void`) so a rejection
// reaches run()'s catch and surfaces as a dialog. Guards throw a friendly,
// user-facing message via requireApp()/requireEl() instead of no-op'ing.
const COMMANDS: Item[] = [
    {id: 'cmd.new',         title: 'New File',              section: 'Commands', hint: '⌘N',     run: () => fileManager.newFile()},
    {id: 'cmd.open',        title: 'Open File…',            section: 'Commands', hint: '⌘O',     run: () => fileManager.openFile()},
    {id: 'cmd.save',        title: 'Save',                  section: 'Commands', hint: '⌘S',     run: () => fileManager.saveCurrent()},
    {id: 'cmd.save_as',     title: 'Save As…',              section: 'Commands', hint: '⌘⇧S',    run: () => fileManager.saveAs()},
    {id: 'cmd.play_pause',  title: 'Play / Pause',          section: 'Commands', hint: '⌘↩',     run: () => requireApp().togglePlayPause()},
    {id: 'cmd.stop',        title: 'Stop Playback',         section: 'Commands', hint: 'Esc',    run: () => requireApp().stop()},
    {id: 'cmd.record',      title: 'Toggle Recording',      section: 'Commands',                 run: () => audioRecorder.toggle()},
    {id: 'cmd.launch_quantum', title: 'Launch Quantization: Next Grid', section: 'Commands',       run: () => launchQuantum.cycleNext()},
    {id: 'cmd.export_audio',title: 'Export Audio…',         section: 'Commands', hint: '⌘⇧E',    run: () => fileManager.exportAudio()},
    {id: 'cmd.export_midi', title: 'Export MIDI…',          section: 'Commands',                 run: () => fileManager.exportMidi()},
    {id: 'cmd.midi',        title: 'Open MIDI Lab…',        section: 'Commands',                 run: () => midiLab.openEmpty()},
    {id: 'cmd.load_samples',title: 'Load Sample Folder…',   section: 'Commands',                 run: () => requireApp().loadSampleFolder()},
    {id: 'cmd.samples',     title: 'Samples… (sets & packs)', section: 'Commands',               run: () => samplesModal.open()},
    {id: 'cmd.install_pack',title: 'Install Sample Pack…',  section: 'Commands',                 run: () => samplesModal.installFromFolder()},
    {id: 'cmd.preferences', title: 'Preferences…',          section: 'Commands', hint: '⌘,',     run: () => preferencesModal.open()},
    {id: 'cmd.examples',    title: 'Browse Examples…',      section: 'Commands',                 run: () => requireEl('browseExamples', 'The examples browser').click()},
    {id: 'cmd.help_guide',  title: 'User Guide…',           section: 'Commands',                 run: () => helpModal.open('guide')},
    {id: 'cmd.help_keys',   title: 'Keyboard Shortcuts…',   section: 'Commands',                 run: () => helpModal.open('shortcuts')},
    {id: 'cmd.help_dialect',title: 'Cycletron Dialect…',    section: 'Commands',                 run: () => helpModal.open('dialect')},
    {id: 'cmd.about',       title: 'About Cycletron',       section: 'Commands',                 run: () => aboutModal.open()},
    {id: 'cmd.updates',     title: 'Check for Updates',     section: 'Commands',                 run: () => checkForUpdates(true)},
    {id: 'cmd.logs',        title: 'Show Logs…',            section: 'Commands',                 run: () => logsModal.open()},
    {id: 'cmd.stage',       title: 'Stage Mode',            section: 'Commands', hint: '⌘⇧F',   run: () => { void stage.toggle(); }},
    {id: 'cmd.stage_follow',title: 'Stage: Follow the Music', section: 'Commands', hint: 'cycle',  run: () => { stage.cycleFollow(); }},
    {id: 'cmd.toggle_ai',   title: 'Toggle AI Panel',       section: 'Commands',                 run: () => { toggleAiPanel(); }},
    {id: 'cmd.toggle_files',title: 'Toggle Files Panel',    section: 'Commands',                 run: () => { fileExplorer.toggleCollapsed(); }},
    {id: 'cmd.toggle_assist',title: 'Toggle Editor Autocomplete', section: 'Commands',            run: async () => { const e = requireApp().editor; if (!e) throw new Error('The editor is still loading — try again in a moment.'); const on = !e.isAssistEnabled(); e.setAssistEnabled(on); await persistEditorAssist(on); }},
    {id: 'cmd.tempo_up',    title: 'Tempo +1 BPM',          section: 'Commands',                 run: () => adjustBpm(1)},
    {id: 'cmd.tempo_down',  title: 'Tempo −1 BPM',          section: 'Commands',                 run: () => adjustBpm(-1)},
    {id: 'cmd.clear_session', title: 'Clear AI Session',    section: 'Commands',                 run: () => clearSession()},
];

async function collectItems(): Promise<Item[]> {
    const out: Item[] = [...COMMANDS];

    if (!isTauri) return out;

    // Sample sets: one switch entry per downloaded set, a download entry for
    // the rest (the download UI with progress lives in Preferences).
    try {
        const [sets, settings] = await Promise.all([
            invoke<SampleSetStatus[]>('list_sample_sets'),
            invoke<UserSettings>('get_user_settings'),
        ]);
        const active = settings.samples?.active ?? 'cycletron';
        for (const set of sets) {
            if (set.ready) {
                out.push({
                    id: `sampleset:${set.id}`,
                    title: `Sample Set: ${set.label}`,
                    subtitle: set.id === active ? 'active' : 'switch — reloads the audio engine',
                    section: 'Commands',
                    run: () => switchSampleSet(set.id),
                });
            } else {
                out.push({
                    id: `sampleset:${set.id}`,
                    title: `Sample Set: Download ${set.label}…`,
                    section: 'Commands',
                    run: () => samplesModal.open(),
                });
            }
        }
    } catch (e) {
        console.debug('[command-palette] list_sample_sets failed:', e);
    }

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
    } catch (e) {
        // Best-effort enrichment: an empty Recent section is fine, but log so a
        // broken recents backend is diagnosable rather than invisible.
        console.debug('[command-palette] get_recents failed:', e);
    }

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
    } catch (e) {
        console.debug('[command-palette] library scan failed:', e);
    }

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

// ------------------------------------------------------------------
// Failure surfacing — a command throws, we tell the user
// ------------------------------------------------------------------

/** The live StrudelApp, or throw a user-facing error if it isn't up yet. */
function requireApp(): any {
    const app = window.strudelApp;
    if (!app) throw new Error('Cycletron is still starting up — try again in a moment.');
    return app;
}

/** An element by id, or throw a user-facing error naming what's missing. */
function requireEl(id: string, label: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`${label} isn't available right now.`);
    return el;
}

/** Report a failed command through the shared error dialog. */
async function reportActionError(title: string, e: unknown): Promise<void> {
    const detail = e instanceof Error ? e.message : String(e);
    await errorDialog(`Couldn't run "${title}".\n\n${detail}`);
}


export const commandPalette = new CommandPalette();
window.commandPalette = commandPalette;
