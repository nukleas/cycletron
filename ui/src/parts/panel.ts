/**
 * Parts tab of the left panel: single voices to add to the open song.
 *
 * Click a part to add it at the cursor (into the `stack(…)` the cursor is in,
 * else as a new track at the end). Drag it onto the editor to choose the spot.
 *
 * Dragging uses pointer events. The native file-drop handler owns HTML5 drops
 * in the desktop shell, so those never reach the page on every platform.
 */

import {isTauri, listen} from '../tauri.js';
import {VirtualList, readRowHeight} from '../virtual-list.js';
import {loadParts, type Part} from './catalog.js';
import {planInsert, type Insert} from './insert.js';
import {shelfRows, type Row} from './groups.js';
import {tempoOf} from './split.js';
import {fitted} from './key.js';
import {saveTrackAsPart} from './save.js';
import {mixer} from '../mixer.js';
import {currentBpm} from '../bpm.js';
import {auditionPart, onAuditionChange, playingKey} from '../audition.js';

const TAB_KEY = 'files-panel-tab';
/** Pointer travel, in px, before a press on a row counts as a drag. */
const DRAG_SLOP = 5;
/** Rating from which a part gets a star. */
const GOOD = 4;
/** Debounce delay in ms while typing in the parts filter input. */
const FILTER_DEBOUNCE_MS = 60;

interface Drag {
    part: Part;
    startX: number;
    startY: number;
    ghost: HTMLElement | null;
    plan: Insert | null;
}

class PartsPanel {
    private panel: HTMLElement | null = null;
    private pane: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private list: VirtualList<Row> | null = null;

    private parts: Part[] = [];
    /** Precomputed lowercased search strings aligned by index with `parts`. */
    private haystacks: string[] = [];
    private rows: Row[] = [];
    /** Ids of the open groups, e.g. `drums/groove-midi`. */
    private open = new Set<string>();
    private query = '';
    private drag: Drag | null = null;
    private downGroupId: string | null = null;
    private activeIdx = -1;
    private emptyEl: HTMLElement | null = null;
    private visible = false;
    private loaded = false;
    private dirty = false;
    private loading: Promise<void> | null = null;
    private filterTimer: ReturnType<typeof setTimeout> | null = null;

    async init(): Promise<void> {
        this.panel = document.getElementById('filesPanel');
        this.pane = document.getElementById('partsPane');
        this.listEl = document.getElementById('partsList');
        if (!this.panel || !this.pane || !this.listEl) return;

        this.listEl.tabIndex = 0;
        this.listEl.setAttribute('role', 'listbox');
        this.emptyEl = document.createElement('div');
        this.emptyEl.className = 'parts-empty';
        this.emptyEl.hidden = true;
        this.pane.insertBefore(this.emptyEl, this.listEl.nextSibling);

        document.getElementById('filesTabFiles')?.addEventListener('click', () => this.show(false));
        document.getElementById('filesTabParts')?.addEventListener('click', () => this.show(true));

        const filter = document.getElementById('partsFilter') as HTMLInputElement | null;
        filter?.addEventListener('input', () => {
            this.query = filter.value;
            this.activeIdx = -1;
            if (this.filterTimer !== null) {
                clearTimeout(this.filterTimer);
                this.filterTimer = null;
            }
            if (!this.query.trim()) {
                this.rebuild();
            } else {
                this.filterTimer = setTimeout(() => {
                    this.filterTimer = null;
                    this.rebuild();
                }, FILTER_DEBOUNCE_MS);
            }
        });
        filter?.addEventListener('keydown', (e) => this.onKeyDown(e, true));
        this.listEl.addEventListener('keydown', (e) => this.onKeyDown(e, false));

        this.listEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        this.listEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
        this.listEl.addEventListener('pointerup', (e) => this.onPointerUp(e));
        this.listEl.addEventListener('lostpointercapture', () => this.endDrag());
        document.addEventListener('density:changed', () => this.list?.setRowHeight(readRowHeight()));
        onAuditionChange(() => this.list?.refresh());

        this.list = new VirtualList<Row>({
            viewport: this.listEl,
            rowHeight: readRowHeight(),
            renderRow: (row, i) => this.renderRow(row, i),
        });

        if (isTauri) {
            void listen('library-changed', () => this.onLibraryChanged());
            mixer.onSave = (track) => void saveTrackAsPart(track);
        }
        // Defer loading until the Parts tab is actually shown so startup pays zero cost.
        if (localStorage.getItem(TAB_KEY) === 'parts') this.show(true);
    }

    /** Switch the left panel to Parts (or back to Files). */
    show(parts: boolean): void {
        if (!this.panel || !this.pane) return;
        this.visible = parts;
        this.panel.classList.toggle('show-parts', parts);
        if (parts) this.panel.classList.remove('collapsed');
        this.pane.hidden = !parts;
        for (const [id, on] of [['filesTabFiles', !parts], ['filesTabParts', parts]] as const) {
            const tab = document.getElementById(id);
            tab?.classList.toggle('active', on);
            tab?.setAttribute('aria-selected', String(on));
        }
        localStorage.setItem(TAB_KEY, parts ? 'parts' : 'files');
        if (!parts) return;

        if (!this.loaded || this.dirty) {
            if (!this.loaded && this.emptyEl && this.listEl) {
                this.emptyEl.textContent = 'Loading parts…';
                this.emptyEl.hidden = false;
                this.listEl.hidden = true;
            }
            void this.refresh();
            return;
        }
        // The list measured itself while hidden.
        this.list?.setItems(this.rows);
    }

    private onLibraryChanged(): void {
        if (!this.visible) {
            this.dirty = true;
            return;
        }
        if (this.loading) {
            this.dirty = true;
            return;
        }
        void this.refresh();
    }

    async refresh(): Promise<void> {
        if (this.loading) {
            this.dirty = true;
            return this.loading;
        }
        const task = (async () => {
            try {
                do {
                    this.dirty = false;
                    const parts = await loadParts();
                    this.parts = parts;
                    this.haystacks = parts.map(searchHaystack);
                    this.loaded = true;
                    this.rebuild();
                } while (this.dirty && this.visible);
            } finally {
                this.loading = null;
            }
        })();
        this.loading = task;
        return task;
    }

    private rebuild(): void {
        if (!this.loaded) return;
        const q = this.query.trim().toLowerCase();
        let rows: Row[] = [];

        if (q) {
            const words = q.split(/\s+/);
            for (let i = 0; i < this.parts.length; i++) {
                const hay = this.haystacks[i];
                if (words.every((w) => hay.includes(w))) rows.push({t: 'part', part: this.parts[i], depth: 0});
            }
        } else {
            rows = shelfRows(this.parts, this.open);
        }

        this.rows = rows;
        if (this.activeIdx >= rows.length) this.activeIdx = rows.length - 1;
        this.list?.setItems(rows);
        if (this.emptyEl && this.listEl) {
            const empty = rows.length === 0;
            this.emptyEl.hidden = !empty;
            this.listEl.hidden = empty;
            if (empty) {
                this.emptyEl.textContent = q ? `No parts matching "${this.query.trim()}".` : 'No parts available.';
            }
        }
    }

    private onKeyDown(e: KeyboardEvent, inFilter: boolean): void {
        if (this.rows.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.activeIdx = Math.min(this.rows.length - 1, this.activeIdx + 1);
            this.list?.scrollToIndex(this.activeIdx);
            this.list?.refresh();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.activeIdx = Math.max(0, this.activeIdx - 1);
            this.list?.scrollToIndex(this.activeIdx);
            this.list?.refresh();
        } else if (e.key === 'Enter' && this.activeIdx >= 0) {
            e.preventDefault();
            const row = this.rows[this.activeIdx];
            if (row.t === 'group') {
                if (!this.open.delete(row.id)) this.open.add(row.id);
                this.rebuild();
            } else {
                this.insertPart(row.part);
            }
        } else if (!inFilter && e.key === ' ' && this.activeIdx >= 0) {
            e.preventDefault();
            const row = this.rows[this.activeIdx];
            if (row.t === 'part') preview(row.part);
            else if (row.kit) previewKit(row.id, row.kit);
        } else if (!inFilter && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && this.activeIdx >= 0) {
            const row = this.rows[this.activeIdx];
            if (row.t === 'group') {
                e.preventDefault();
                const wantOpen = e.key === 'ArrowRight';
                if (wantOpen && !this.open.has(row.id)) {
                    this.open.add(row.id);
                    this.rebuild();
                } else if (!wantOpen && this.open.delete(row.id)) {
                    this.rebuild();
                }
            }
        }
    }

    private insertPart(part: Part): void {
        const editor = window.strudelApp?.editor;
        if (!editor) return;
        const code = editor.getCode();
        const fittedPart = inKey(part, code);
        const at = planInsert(code, editor.view.state.selection.main.head, fittedPart);
        apply(at.kind === 'stack' ? at : planInsert(code, null, fittedPart));
    }

    private renderRow(row: Row, index: number): HTMLElement {
        const el = document.createElement('div');
        el.dataset.idx = String(index);
        el.style.setProperty('--depth', String(row.depth));

        if (row.t === 'group') {
            el.className = 'snd-row snd-row--group';
            if (index === this.activeIdx) el.classList.add('is-active');
            el.setAttribute('role', 'presentation');
            el.setAttribute('aria-expanded', String(row.open));
            el.append(
                span('snd-row-caret', row.open ? '▾' : '▸'),
                span('snd-row-name', row.label),
                span('snd-row-meta', String(row.count)),
            );
            if (row.kit) {
                if (isTauri) {
                    el.append(button('snd-audition', '▶', 'Preview the kit'));
                    if (playingKey() === row.id) el.classList.add('is-playing');
                }
                el.append(button('snd-audition part-add-kit', '+', 'Add the kit as tracks'));
            }
            return el;
        }

        const p = row.part;
        // Inside the tree the groups above already say collection and key.
        const where = p.source !== 'mine' ? [p.genre] : row.depth === 0 ? [p.collection ?? 'mine', p.key] : [];
        const meta = [(p.rating ?? 0) >= GOOD ? '★' : null, ...where, p.bars ? `${p.bars} bar` : null, p.bpm ? String(Math.round(p.bpm)) : null]
            .filter(Boolean).join(' · ');
        el.className = 'snd-row snd-row--bank';
        if (index === this.activeIdx) el.classList.add('is-active');
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', String(index === this.activeIdx));
        el.setAttribute('aria-setsize', String(this.rows.length));
        el.setAttribute('aria-posinset', String(index + 1));
        el.dataset.part = p.id;
        const about = [p.tags?.join(', '), p.song ? `from ${p.song}` : ''].filter(Boolean).join(' · ');
        const code = p.code.length > 160 ? `${p.code.slice(0, 160)}…` : p.code;
        el.dataset.tooltip = about ? `${about}\n${code}` : code;
        el.append(span('snd-row-caret', ''), span('snd-row-name', p.title), span('snd-row-meta', meta));
        // Previews are rendered by the backend.
        if (isTauri) {
            el.append(button('snd-audition', '▶', 'Preview'));
            if (playingKey() === p.id) el.classList.add('is-playing');
        }
        return el;
    }

    private rowAt(target: EventTarget | null): Row | null {
        const el = (target as Element | null)?.closest<HTMLElement>('.snd-row');
        return el?.dataset.idx ? this.rows[Number(el.dataset.idx)] ?? null : null;
    }

    private onPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        this.downGroupId = null;
        const row = this.rowAt(e.target);
        if (!row) return;
        if (row.t === 'group') {
            this.downGroupId = row.id;
            return;
        }
        if ((e.target as Element).closest('.snd-audition')) {
            preview(row.part);
            return;
        }
        this.drag = {part: row.part, startX: e.clientX, startY: e.clientY, ghost: null, plan: null};
        this.listEl?.setPointerCapture(e.pointerId);
    }

    private onPointerMove(e: PointerEvent): void {
        const drag = this.drag;
        if (!drag) return;
        if (!drag.ghost) {
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_SLOP) return;
            drag.ghost = document.createElement('div');
            drag.ghost.className = 'part-ghost';
            drag.ghost.textContent = drag.part.title;
            document.body.append(drag.ghost);
            document.body.classList.add('is-dragging-part');
        }
        drag.ghost.style.left = `${e.clientX + 12}px`;
        drag.ghost.style.top = `${e.clientY + 12}px`;

        const editor = window.strudelApp?.editor;
        if (!editor) return;
        const box = editor.view.dom.getBoundingClientRect();
        const inside = e.clientX >= box.left && e.clientX <= box.right
            && e.clientY >= box.top && e.clientY <= box.bottom;
        if (!inside) {
            drag.plan = null;
            editor.setDropLine(null);
            return;
        }
        const code = editor.getCode();
        const pos = editor.view.posAtCoords({x: e.clientX, y: e.clientY}, false);
        drag.plan = planInsert(code, pos, inKey(drag.part, code));
        editor.setDropLine(dropMark(drag.plan, code.length));
    }

    private onPointerUp(e: PointerEvent): void {
        const drag = this.drag;
        if (!drag) {
            const started = this.downGroupId;
            this.downGroupId = null;
            const row = this.rowAt(e.target);
            if (row?.t === 'group' && started === row.id) {
                const pressed = (e.target as Element).closest('.snd-audition');
                if (row.kit && pressed) {
                    if (pressed.classList.contains('part-add-kit')) addKit(row.kit);
                    else previewKit(row.id, row.kit);
                    return;
                }
                if (!this.open.delete(row.id)) this.open.add(row.id);
                this.rebuild();
            }
            return;
        }
        const editor = window.strudelApp?.editor;
        if (editor) {
            if (!drag.ghost) {
                // A click: into the stack under the cursor, else a new track at the end.
                this.insertPart(drag.part);
            } else if (drag.plan) {
                apply(drag.plan);
            }
        }
        this.endDrag();
    }

    private endDrag(): void {
        this.drag?.ghost?.remove();
        this.drag = null;
        document.body.classList.remove('is-dragging-part');
        window.strudelApp?.editor?.setDropLine(null);
    }
}

/** Lowercased search haystack for a part, precomputed once per catalog load. */
function searchHaystack(part: Part): string {
    return `${part.title} ${part.role} ${part.genre ?? ''} ${part.collection ?? ''} ${part.key ?? ''} ${(part.tags ?? []).join(' ')} ${part.song ?? ''} ${part.kit ?? ''} ${part.code}`
        .toLowerCase();
}

/** The part moved into the song's key. */
function inKey(part: Part, song: string): Part {
    return {...part, code: fitted(part, song)};
}

/** Play the part in the song's key and tempo, or its own when the song has none. */
function preview(part: Part): void {
    const song = window.strudelApp?.editor?.getCode() ?? '';
    const bpm = tempoOf(song) ?? part.bpm ?? currentBpm();
    auditionPart(part.id, fitted(part, song), bpm).catch((e) => console.warn('[parts] preview failed:', e));
}

/** Play the kit's main parts together. */
function previewKit(id: string, parts: Part[]): void {
    const song = window.strudelApp?.editor?.getCode() ?? '';
    const voices = parts.map((p) => fitted(p, song)).join(',\n');
    const bpm = tempoOf(song) ?? parts[0]?.bpm ?? currentBpm();
    auditionPart(id, `stack(\n${voices}\n)`, bpm).catch((e) => console.warn('[parts] preview failed:', e));
}

/** Add each of the kit's main parts as a track at the end, in one undo step. */
function addKit(parts: Part[]): void {
    const editor = window.strudelApp?.editor;
    if (!editor) return;
    const song = editor.getCode();
    let code = song;
    let first: Insert | null = null;
    for (const part of parts) {
        const plan = planInsert(code, null, inKey(part, song));
        first ??= plan;
        code = code.slice(0, plan.from) + plan.insert + code.slice(plan.to);
    }
    if (first) editor.insertPart(first.from, first.to, code.slice(first.from), 0, code.length - first.from);
}

function button(className: string, text: string, tooltip: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = text;
    el.dataset.tooltip = tooltip;
    return el;
}

function span(className: string, text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

function apply(plan: Insert): void {
    window.strudelApp?.editor?.insertPart(plan.from, plan.to, plan.insert, plan.partFrom, plan.partTo);
}

/** The line edge that shows where `plan` would put the part. */
function dropMark(plan: Insert, docLength: number): {pos: number; below: boolean} {
    if (plan.kind === 'track') {
        const append = plan.from >= docLength && docLength > 0;
        return {pos: plan.from, below: append};
    }
    return {pos: plan.from, below: plan.partFrom > 0};
}

export const partsPanel = new PartsPanel();
