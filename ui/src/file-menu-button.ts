/**
 * Header "File ▾" dropdown — discoverable in-window affordance for file
 * operations. Most macOS users miss the system menubar at the top of the
 * screen, so we mirror its File submenu inside the window.
 *
 * Items mirror src-tauri/src/menu.rs and ui/src/menu-events.ts so behavior
 * is consistent regardless of which entry point the user picks.
 */

import {fileManager} from './file-manager.js';
import {midiLab} from './midi-lab.js';
import {diag} from './diagnostics.js';
import {basename} from './paths.js';

interface MenuItem {
    label: string;
    hint?: string;
    run?: () => void | Promise<void>;
    submenu?: () => Promise<MenuItem[]>;
    disabled?: boolean;
    separator?: boolean;
}

class FileMenuButton {
    private btn: HTMLButtonElement | null = null;
    private popover: HTMLElement | null = null;
    private subPopover: HTMLElement | null = null;
    private openCleanup: (() => void) | null = null;

    init(): void {
        this.btn = document.getElementById('fileMenuBtn') as HTMLButtonElement | null;
        this.popover = document.getElementById('fileMenuPopover');
        if (!this.btn || !this.popover) return;

        this.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.isOpen()) this.close();
            else void this.open();
        });
    }

    private isOpen(): boolean {
        return !!this.popover && !this.popover.hidden;
    }

    private async open(): Promise<void> {
        if (!this.btn || !this.popover) return;
        void diag('info', 'file-menu', 'opened');

        const items = await this.buildTopLevel();
        this.popover.innerHTML = '';
        this.popover.appendChild(this.renderList(items, 'top'));
        this.popover.hidden = false;
        this.btn.setAttribute('aria-expanded', 'true');

        const onDocClick = (ev: MouseEvent) => {
            if (!this.popover) return;
            const target = ev.target as Node;
            if (this.popover.contains(target)) return;
            if (this.subPopover?.contains(target)) return;
            if (this.btn?.contains(target)) return;
            this.close();
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                this.close();
            }
        };
        document.addEventListener('mousedown', onDocClick, true);
        document.addEventListener('keydown', onKey, true);

        this.openCleanup = () => {
            document.removeEventListener('mousedown', onDocClick, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }

    private close(): void {
        if (this.popover) this.popover.hidden = true;
        this.closeSubmenu();
        if (this.btn) this.btn.setAttribute('aria-expanded', 'false');
        this.openCleanup?.();
        this.openCleanup = null;
    }

    private closeSubmenu(): void {
        if (this.subPopover && this.subPopover.parentNode) {
            this.subPopover.parentNode.removeChild(this.subPopover);
        }
        this.subPopover = null;
    }

    private renderList(items: MenuItem[], variant: 'top' | 'sub'): HTMLElement {
        const list = document.createElement('div');
        list.className = `file-menu-list ${variant === 'sub' ? 'file-menu-list--sub' : ''}`;
        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'file-menu-separator';
                list.appendChild(sep);
                continue;
            }
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'file-menu-row';
            if (item.disabled) row.classList.add('is-disabled');
            row.disabled = !!item.disabled;
            row.setAttribute('role', 'menuitem');

            const label = document.createElement('span');
            label.className = 'file-menu-row-label';
            label.textContent = item.label;
            row.appendChild(label);

            if (item.hint) {
                const hint = document.createElement('span');
                hint.className = 'file-menu-row-hint';
                hint.textContent = item.hint;
                row.appendChild(hint);
            }
            if (item.submenu) {
                const caret = document.createElement('span');
                caret.className = 'file-menu-row-caret';
                caret.textContent = '▸';
                row.appendChild(caret);
            }

            if (item.submenu) {
                row.addEventListener('mouseenter', () => void this.openSubmenu(item, row));
                row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void this.openSubmenu(item, row);
                });
            } else if (item.run && !item.disabled) {
                row.addEventListener('click', () => {
                    this.close();
                    void diag('info', 'file-menu', `run: ${item.label}`);
                    void item.run!();
                });
            }
            list.appendChild(row);
        }
        return list;
    }

    private async openSubmenu(item: MenuItem, anchor: HTMLElement): Promise<void> {
        if (!item.submenu || !this.popover) return;
        this.closeSubmenu();
        const items = await item.submenu();
        const sub = document.createElement('div');
        sub.className = 'file-menu-popover file-menu-popover--sub';
        sub.appendChild(this.renderList(items, 'sub'));

        const anchorRect = anchor.getBoundingClientRect();
        sub.style.position = 'fixed';
        sub.style.top = `${anchorRect.top}px`;
        sub.style.left = `${anchorRect.right + 4}px`;
        document.body.appendChild(sub);
        this.subPopover = sub;
    }

    private async buildTopLevel(): Promise<MenuItem[]> {
        return [
            {label: 'New', hint: '⌘N', run: () => fileManager.newFile()},
            {label: 'Open File…', hint: '⌘O', run: () => fileManager.openFile()},
            {
                label: 'Open Recent',
                submenu: async () => this.buildRecentSubmenu(),
            },
            {separator: true, label: ''},
            {label: 'Save', hint: '⌘S', run: () => { void fileManager.saveCurrent(); }},
            {label: 'Save As…', hint: '⌘⇧S', run: () => { void fileManager.saveAs(); }},
            {separator: true, label: ''},
            {label: 'Import MIDI…', run: () => { void midiLab.openWithPicker(); }},
            {label: 'Export Audio…', hint: '⌘⇧E', run: () => { void fileManager.exportAudio(); }},
            {label: 'Export MIDI…', run: () => { void fileManager.exportMidi(); }},
            {label: 'Open MIDI Lab…', run: () => { void midiLab.openEmpty(); }},
        ];
    }

    private async buildRecentSubmenu(): Promise<MenuItem[]> {
        const recents = await fileManager.getRecents();
        if (recents.length === 0) {
            return [
                {label: 'No recent files', disabled: true},
                {separator: true, label: ''},
                {label: 'Open File…', hint: '⌘O', run: () => fileManager.openFile()},
            ];
        }
        const items: MenuItem[] = recents.slice(0, 10).map((path) => ({
            label: basename(path),
            hint: shortDir(path),
            run: () => fileManager.openPath(path),
        }));
        items.push({separator: true, label: ''});
        items.push({
            label: 'Clear Recent Files',
            run: async () => {
                try {
                    await window.__TAURI__?.core?.invoke('clear_recents');
                } catch (e) {
                    void diag('warn', 'file-menu', `clear_recents failed: ${e}`);
                }
            },
        });
        return items;
    }
}


function shortDir(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) return '';
    return parts[parts.length - 2];
}

export const fileMenuButton = new FileMenuButton();
