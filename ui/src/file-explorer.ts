/**
 * Cursor-style file explorer for the user's strudel library.
 *
 * Talks to the Rust `list_library` / `create_library_*` / `delete_library_path`
 * / `rename_library_path` / `reveal_in_os` commands. Filesystem mutations
 * always go through the backend so the path-traversal guard is enforced.
 *
 * Files are opened via the existing `fileManager` so dirty checks, session
 * tracking, and recents stay consistent with Cmd+O / Cmd+S flows.
 */

import {fileManager} from './file-manager.js';

interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number | null;
    modified_ms: number | null;
}

const isTauri = !!(window as any).__TAURI__;
const EXPANDED_KEY = 'file-explorer-expanded';
const COLLAPSED_KEY = 'file-explorer-collapsed';

export class FileExplorer {
    private panel: HTMLElement | null = null;
    private treeEl: HTMLElement | null = null;
    private rootLabel: HTMLElement | null = null;
    private contextMenu: HTMLElement | null = null;

    private root: string = '';
    private childrenCache: Map<string, DirEntry[]> = new Map();
    private expanded: Set<string> = new Set();
    private activePath: string | null = null;
    private dirty: boolean = false;
    private recents: string[] = [];
    private recentsCollapsed: boolean = false;

    async init(): Promise<void> {
        this.panel = document.getElementById('filesPanel');
        this.treeEl = document.getElementById('fileTree');
        this.rootLabel = document.getElementById('filesRootLabel');
        this.contextMenu = document.getElementById('fileContextMenu');

        if (!this.panel || !this.treeEl) return;

        this.loadExpandedState();
        this.applyCollapsedState();
        this.bindControls();
        this.bindFileEvents();

        if (!isTauri) {
            this.treeEl.innerHTML = '<div class="file-tree-empty">File explorer only available in desktop build.</div>';
            return;
        }

        this.loadRecentsCollapsed();
        await this.refreshRoot();
        await this.refreshRecents();
        await this.listenLibraryChanged();

        document.addEventListener('file:changed', () => {
            void this.refreshRecents();
        });
    }

    private async refreshRecents(): Promise<void> {
        try {
            this.recents = await fileManager.getRecents();
        } catch {
            this.recents = [];
        }
        this.render();
    }

    private loadRecentsCollapsed(): void {
        try {
            this.recentsCollapsed = localStorage.getItem('file-explorer-recents-collapsed') === '1';
        } catch { /* ignore */ }
    }

    private persistRecentsCollapsed(): void {
        try {
            localStorage.setItem('file-explorer-recents-collapsed', this.recentsCollapsed ? '1' : '0');
        } catch { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    private async refreshRoot(): Promise<void> {
        try {
            this.root = await invoke<string>('get_library_root');
            this.setRootLabel(this.root);
            await this.refresh();
        } catch (e: any) {
            console.warn('[file-explorer] get_library_root failed:', e);
            this.renderError(String(e));
        }
    }

    async refresh(): Promise<void> {
        this.childrenCache.clear();
        await this.loadChildren(this.root);
        for (const p of Array.from(this.expanded)) {
            // Drop expansions outside the new root.
            if (!this.isUnderRoot(p)) {
                this.expanded.delete(p);
                continue;
            }
            await this.loadChildren(p);
        }
        this.persistExpanded();
        this.render();
    }

    private async loadChildren(path: string): Promise<DirEntry[]> {
        const arg = path === this.root ? undefined : path;
        try {
            const entries = await invoke<DirEntry[]>('list_library', {path: arg});
            this.childrenCache.set(path, entries);
            return entries;
        } catch (e: any) {
            console.warn('[file-explorer] list_library failed:', e);
            this.childrenCache.set(path, []);
            return [];
        }
    }

    private async listenLibraryChanged(): Promise<void> {
        const event = (window as any).__TAURI__?.event;
        if (!event?.listen) return;
        // Returns an unlisten fn — we keep it implicit since the explorer
        // lives for the lifetime of the app.
        await event.listen('library-changed', () => {
            void this.refresh();
        });
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    private render(): void {
        if (!this.treeEl) return;
        this.treeEl.innerHTML = '';

        // Recent section — Zed/VSCode style pseudo-folder at top of tree.
        if (this.recents.length > 0) {
            this.renderRecentSection(this.treeEl);
        }

        const entries = this.childrenCache.get(this.root) ?? [];
        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'file-tree-empty';
            empty.innerHTML = `
                Library is empty.<br>
                Create your first pattern.
                <br>
                <button id="fileEmptyNew">+ New File</button>
            `;
            this.treeEl.appendChild(empty);
            empty.querySelector('#fileEmptyNew')?.addEventListener('click', () => {
                void this.newFile(this.root);
            });
            return;
        }
        this.renderInto(this.treeEl, entries, 0);
    }

    private renderRecentSection(parent: HTMLElement): void {
        const header = document.createElement('div');
        header.className = 'file-tree-row file-tree-recent-header';
        if (!this.recentsCollapsed) header.classList.add('expanded');
        header.setAttribute('role', 'treeitem');
        header.title = 'Recently opened files';
        header.style.paddingLeft = '8px';

        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '▸';
        header.appendChild(chevron);

        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.textContent = '↻';
        icon.style.color = 'var(--neon)';
        header.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = 'Recent';
        header.appendChild(name);

        header.addEventListener('click', () => {
            this.recentsCollapsed = !this.recentsCollapsed;
            this.persistRecentsCollapsed();
            this.render();
        });
        parent.appendChild(header);

        if (this.recentsCollapsed) return;

        for (const path of this.recents.slice(0, 5)) {
            const row = document.createElement('div');
            row.className = 'file-tree-row is-file file-tree-recent-row';
            row.dataset.path = path;
            row.style.paddingLeft = '28px';
            row.title = path;
            row.setAttribute('role', 'treeitem');
            if (this.activePath === path) {
                row.classList.add('active');
                if (this.dirty) row.classList.add('dirty');
            }

            const iconEl = document.createElement('span');
            iconEl.className = 'file-tree-icon';
            iconEl.innerHTML = fileSvg();
            row.appendChild(iconEl);

            const nameEl = document.createElement('span');
            nameEl.className = 'file-tree-name';
            nameEl.textContent = basename(path);
            row.appendChild(nameEl);

            row.addEventListener('click', () => {
                void fileManager.openPath(path);
            });
            parent.appendChild(row);
        }

        // Visual separator between Recent and library tree.
        const sep = document.createElement('div');
        sep.className = 'file-tree-recent-separator';
        parent.appendChild(sep);
    }

    private renderInto(parent: HTMLElement, entries: DirEntry[], depth: number): void {
        for (const entry of entries) {
            const row = this.makeRow(entry, depth);
            parent.appendChild(row);
            if (entry.is_dir && this.expanded.has(entry.path)) {
                const children = this.childrenCache.get(entry.path) ?? [];
                this.renderInto(parent, children, depth + 1);
            }
        }
    }

    private makeRow(entry: DirEntry, depth: number): HTMLElement {
        const row = document.createElement('div');
        row.className = 'file-tree-row';
        row.classList.add(entry.is_dir ? 'is-dir' : 'is-file');
        row.dataset.path = entry.path;
        row.dataset.isDir = entry.is_dir ? '1' : '0';
        row.style.paddingLeft = `${8 + depth * 12}px`;
        row.title = entry.path;
        row.setAttribute('role', 'treeitem');
        if (entry.is_dir && this.expanded.has(entry.path)) row.classList.add('expanded');
        if (!entry.is_dir && this.activePath === entry.path) {
            row.classList.add('active');
            if (this.dirty) row.classList.add('dirty');
        }

        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '▸';
        row.appendChild(chevron);

        const icon = document.createElement('span');
        icon.className = 'file-tree-icon';
        icon.innerHTML = entry.is_dir ? folderSvg() : fileSvg();
        row.appendChild(icon);

        const name = document.createElement('span');
        name.className = 'file-tree-name';
        name.textContent = entry.name;
        row.appendChild(name);

        row.addEventListener('click', () => {
            void this.onRowClick(entry);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showContextMenu(entry, e.clientX, e.clientY);
        });

        return row;
    }

    private renderError(msg: string): void {
        if (!this.treeEl) return;
        this.treeEl.innerHTML = `<div class="file-tree-empty">Could not load library:<br>${escapeHtml(msg)}</div>`;
    }

    // ------------------------------------------------------------------
    // Interactions
    // ------------------------------------------------------------------

    private async onRowClick(entry: DirEntry): Promise<void> {
        if (entry.is_dir) {
            await this.toggleExpand(entry.path);
        } else {
            await this.openFileEntry(entry.path);
        }
    }

    private async toggleExpand(path: string): Promise<void> {
        if (this.expanded.has(path)) {
            this.expanded.delete(path);
        } else {
            this.expanded.add(path);
            if (!this.childrenCache.has(path)) {
                await this.loadChildren(path);
            }
        }
        this.persistExpanded();
        this.render();
    }

    private async openFileEntry(path: string): Promise<void> {
        await fileManager.openPath(path);
    }

    // ------------------------------------------------------------------
    // CRUD
    // ------------------------------------------------------------------

    private async newFile(parentDir: string): Promise<void> {
        const name = await this.promptInline(parentDir, 'untitled.strudel');
        if (!name) return;
        const path = join(parentDir, ensureStrudelExt(name));
        const bpm = currentBpm();
        try {
            await invoke('create_library_file', {path, bpm});
            this.expanded.add(parentDir);
            await this.refresh();
            await fileManager.openPath(path);
        } catch (e: any) {
            await showError(`Could not create file:\n${e}`);
        }
    }

    private async newFolder(parentDir: string): Promise<void> {
        const name = await this.promptInline(parentDir, 'new-folder');
        if (!name) return;
        const path = join(parentDir, name);
        try {
            await invoke('create_library_folder', {path});
            this.expanded.add(parentDir);
            this.expanded.add(path);
            await this.refresh();
        } catch (e: any) {
            await showError(`Could not create folder:\n${e}`);
        }
    }

    private async renameEntry(entry: DirEntry): Promise<void> {
        const newName = await this.promptInline(parentDirOf(entry.path), entry.name, entry.name);
        if (!newName || newName === entry.name) return;
        const parent = parentDirOf(entry.path);
        const target = join(parent, entry.is_dir ? newName : ensureStrudelExt(newName));
        try {
            await invoke('rename_library_path', {from: entry.path, to: target});
            // Migrate expanded paths.
            const next = new Set<string>();
            for (const p of this.expanded) {
                if (p === entry.path) next.add(target);
                else if (p.startsWith(entry.path + '/')) next.add(target + p.slice(entry.path.length));
                else next.add(p);
            }
            this.expanded = next;
            this.persistExpanded();
            await this.refresh();
        } catch (e: any) {
            await showError(`Could not rename:\n${e}`);
        }
    }

    private async deleteEntry(entry: DirEntry): Promise<void> {
        const {ask} = await import('@tauri-apps/plugin-dialog');
        const ok = await ask(
            `Delete ${entry.is_dir ? 'folder' : 'file'} "${entry.name}"? This cannot be undone.`,
            {title: 'Robostrudel', kind: 'warning'},
        );
        if (!ok) return;
        try {
            await invoke('delete_library_path', {path: entry.path});
            this.expanded.delete(entry.path);
            await this.refresh();
        } catch (e: any) {
            await showError(`Could not delete:\n${e}`);
        }
    }

    private async revealEntry(entry: DirEntry): Promise<void> {
        try {
            await invoke('reveal_in_os', {path: entry.path});
        } catch (e: any) {
            await showError(`Could not reveal:\n${e}`);
        }
    }

    private async changeRoot(): Promise<void> {
        const {open} = await import('@tauri-apps/plugin-dialog');
        const picked = await open({
            directory: true,
            multiple: false,
            defaultPath: this.root,
        });
        const path = typeof picked === 'string' ? picked : null;
        if (!path) return;
        try {
            await invoke('set_library_root', {path});
            this.expanded.clear();
            this.persistExpanded();
            await this.refreshRoot();
        } catch (e: any) {
            await showError(`Could not change library:\n${e}`);
        }
    }

    // ------------------------------------------------------------------
    // Inline prompt (rename / new) — replaces a row's label with an input
    // ------------------------------------------------------------------

    private promptInline(
        parentDir: string,
        placeholder: string,
        initial: string = '',
    ): Promise<string | null> {
        return new Promise(resolve => {
            // Expand parent so the inline row is visible.
            if (parentDir !== this.root) this.expanded.add(parentDir);
            this.render();

            // Walk DOM to find the parent row's position (or root container).
            const tree = this.treeEl;
            if (!tree) return resolve(null);

            const row = document.createElement('div');
            row.className = 'file-tree-row is-file';
            const depth = depthFromRoot(parentDir, this.root);
            row.style.paddingLeft = `${8 + (depth + 1) * 12}px`;

            const chevron = document.createElement('span');
            chevron.className = 'chevron';
            chevron.textContent = '▸';
            row.appendChild(chevron);

            const icon = document.createElement('span');
            icon.className = 'file-tree-icon';
            icon.innerHTML = fileSvg();
            row.appendChild(icon);

            const input = document.createElement('input');
            input.className = 'file-tree-input';
            input.type = 'text';
            input.value = initial;
            input.placeholder = placeholder;
            row.appendChild(input);

            // Insert after the parent row if any, else at top.
            if (parentDir === this.root) {
                tree.insertBefore(row, tree.firstChild);
            } else {
                const parentRow = tree.querySelector<HTMLElement>(`[data-path="${cssEscape(parentDir)}"]`);
                if (parentRow && parentRow.parentElement === tree) {
                    parentRow.insertAdjacentElement('afterend', row);
                } else {
                    tree.appendChild(row);
                }
            }

            input.focus();
            input.select();

            const commit = (val: string | null) => {
                row.remove();
                resolve(val);
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commit(input.value.trim() || null);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    commit(null);
                }
            });
            input.addEventListener('blur', () => commit(input.value.trim() || null));
        });
    }

    // ------------------------------------------------------------------
    // Context menu
    // ------------------------------------------------------------------

    private showContextMenu(entry: DirEntry, x: number, y: number): void {
        if (!this.contextMenu) return;
        const menu = this.contextMenu;
        const items: Array<{label: string; danger?: boolean; sep?: boolean; action: () => void}> = [];
        if (!entry.is_dir) {
            items.push({label: 'Open', action: () => void this.openFileEntry(entry.path)});
        } else {
            items.push({label: 'New File',   action: () => void this.newFile(entry.path)});
            items.push({label: 'New Folder', action: () => void this.newFolder(entry.path)});
        }
        items.push({label: 'Rename',          action: () => void this.renameEntry(entry)});
        items.push({label: 'Reveal in Finder', action: () => void this.revealEntry(entry)});
        items.push({label: 'Delete', danger: true, action: () => void this.deleteEntry(entry)});

        menu.innerHTML = '';
        for (const item of items) {
            const btn = document.createElement('button');
            btn.textContent = item.label;
            if (item.danger) btn.classList.add('danger');
            btn.addEventListener('click', () => {
                this.hideContextMenu();
                item.action();
            });
            menu.appendChild(btn);
        }
        // Position with a tiny clamp so it doesn't overflow the viewport.
        menu.hidden = false;
        const w = menu.offsetWidth;
        const h = menu.offsetHeight;
        const px = Math.min(x, window.innerWidth - w - 8);
        const py = Math.min(y, window.innerHeight - h - 8);
        menu.style.left = `${px}px`;
        menu.style.top = `${py}px`;

        const dismiss = (ev: Event) => {
            if (ev.target instanceof Node && menu.contains(ev.target)) return;
            this.hideContextMenu();
            document.removeEventListener('mousedown', dismiss, true);
            document.removeEventListener('keydown', escDismiss, true);
            window.removeEventListener('resize', dismiss, true);
        };
        const escDismiss = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') dismiss(ev);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', dismiss, true);
            document.addEventListener('keydown', escDismiss, true);
            window.addEventListener('resize', dismiss, true);
        }, 0);
    }

    private hideContextMenu(): void {
        if (!this.contextMenu) return;
        this.contextMenu.hidden = true;
        this.contextMenu.style.left = '-9999px';
    }

    // ------------------------------------------------------------------
    // State + persistence
    // ------------------------------------------------------------------

    private loadExpandedState(): void {
        try {
            const raw = localStorage.getItem(EXPANDED_KEY);
            if (raw) this.expanded = new Set(JSON.parse(raw));
        } catch { /* ignore */ }
    }

    private persistExpanded(): void {
        try {
            localStorage.setItem(EXPANDED_KEY, JSON.stringify([...this.expanded]));
        } catch { /* ignore */ }
    }

    private applyCollapsedState(): void {
        if (!this.panel) return;
        const collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
        this.panel.classList.toggle('collapsed', collapsed);
    }

    private toggleCollapsed(): void {
        if (!this.panel) return;
        const collapsed = !this.panel.classList.contains('collapsed');
        this.panel.classList.toggle('collapsed', collapsed);
        localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    }

    private setRootLabel(path: string): void {
        if (!this.rootLabel) return;
        this.rootLabel.textContent = path;
        this.rootLabel.title = path;
    }

    private isUnderRoot(path: string): boolean {
        return path === this.root || path.startsWith(this.root + '/') || path.startsWith(this.root + '\\');
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    private bindControls(): void {
        document.getElementById('filesToggle')?.addEventListener('click', () => this.toggleCollapsed());
        document.getElementById('filesNewFile')?.addEventListener('click', () => void this.newFile(this.activeDir()));
        document.getElementById('filesNewFolder')?.addEventListener('click', () => void this.newFolder(this.activeDir()));
        document.getElementById('filesRefresh')?.addEventListener('click', () => void this.refresh());
        document.getElementById('filesChangeRoot')?.addEventListener('click', () => void this.changeRoot());
    }

    /** Pick where new things should land — the active file's folder when
     *  open, else the library root. */
    private activeDir(): string {
        if (this.activePath && this.isUnderRoot(this.activePath)) {
            return parentDirOf(this.activePath);
        }
        return this.root;
    }

    private bindFileEvents(): void {
        document.addEventListener('file:changed', ((e: CustomEvent) => {
            this.activePath = e.detail?.path ?? null;
            this.dirty = !!e.detail?.dirty;
            this.updateActiveHighlight();
        }) as EventListener);
    }

    private updateActiveHighlight(): void {
        if (!this.treeEl) return;
        const rows = this.treeEl.querySelectorAll<HTMLElement>('.file-tree-row');
        rows.forEach(r => {
            r.classList.remove('active', 'dirty');
            if (r.dataset.path === this.activePath && r.dataset.isDir === '0') {
                r.classList.add('active');
                if (this.dirty) r.classList.add('dirty');
            }
        });
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cssEscape(s: string): string {
    if (typeof (window as any).CSS?.escape === 'function') {
        return (window as any).CSS.escape(s);
    }
    return s.replace(/["\\]/g, '\\$&');
}

function join(parent: string, name: string): string {
    const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
    return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function parentDirOf(path: string): string {
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx >= 0 ? path.slice(0, idx) : path;
}

function ensureStrudelExt(name: string): string {
    return /\.(strudel|js)$/i.test(name) ? name : `${name}.strudel`;
}

function depthFromRoot(path: string, root: string): number {
    if (!root || path === root) return 0;
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    return rel.split(/[\\/]/).filter(Boolean).length;
}

function currentBpm(): number | undefined {
    const el = document.getElementById('bpmSlider') as HTMLInputElement | null;
    const v = el ? parseInt(el.value, 10) : NaN;
    return Number.isNaN(v) ? undefined : v;
}

async function showError(msg: string): Promise<void> {
    if (!isTauri) {
        console.error(msg);
        return;
    }
    const {message} = await import('@tauri-apps/plugin-dialog');
    await message(msg, {title: 'Robostrudel', kind: 'error'});
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function folderSvg(): string {
    return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
}

function fileSvg(): string {
    return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

export const fileExplorer = new FileExplorer();
(window as any).fileExplorer = fileExplorer;
