/**
 * Sound Browser — search, audition and insert any playable bank.
 *
 * The sidebar panel it replaces rendered every bank as a chip in one
 * `innerHTML` blast into a 220px box; with the `strudel-cc` set active that is
 * 1000+ nodes, no search, and no way to hear anything.
 *
 * Banks expand **inline** rather than into a detail pane, so bank rows and
 * sample rows share one row pitch and one virtualizer handles the whole tree.
 * A third pane would need its own selection model and ~300px the modal does
 * not have.
 */

import {dismissibleModal} from './modal-utils.js';
import {escapeHtml} from './html.js';
import {samplesModal} from './samples-modal.js';
import {VirtualList, readRowHeight} from './virtual-list.js';
import {auditionSample, stopAudition, onAuditionChange, refKey, playingKey} from './audition.js';
import {insertSound} from './sound-insert.js';
import {loadCatalog, filterBanks, CATEGORIES, type Bank, type Catalog, type SampleRef} from './sound-catalog.js';

/** A rendered line: a bank, or one of its samples while it is expanded. */
type Row =
    | {t: 'bank'; bank: Bank}
    | {t: 'sample'; bank: Bank; ref: SampleRef; index: number};

export class SoundBrowser {
    private root: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private railEl: HTMLElement | null = null;
    private searchEl: HTMLInputElement | null = null;
    private countEl: HTMLElement | null = null;
    private emptyEl: HTMLElement | null = null;

    private list: VirtualList<Row> | null = null;
    private catalog: Catalog | null = null;
    private rows: Row[] = [];
    private expanded = new Set<string>();
    private category = 'all';
    private query = '';
    private selected = 0;
    private dirty = true;
    private inited = false;
    private cleanup: (() => void) | null = null;
    private unsubscribeAudition: (() => void) | null = null;

    init(): void {
        if (this.inited) return;
        this.root = document.getElementById('soundBrowser');
        if (!this.root) return;
        this.listEl = document.getElementById('sndList');
        this.railEl = document.getElementById('sndRail');
        this.searchEl = document.getElementById('sndSearch') as HTMLInputElement | null;
        this.countEl = document.getElementById('sndCount');
        this.emptyEl = document.getElementById('sndEmpty');

        this.searchEl?.addEventListener('input', () => {
            this.query = this.searchEl?.value ?? '';
            this.selected = 0;
            this.rebuild();
        });

        this.railEl?.addEventListener('click', (e) => {
            const item = (e.target as Element).closest('.snd-rail-item') as HTMLElement | null;
            if (!item?.dataset.cat) return;
            this.category = item.dataset.cat;
            this.selected = 0;
            this.renderRail();
            this.rebuild();
        });

        this.listEl?.addEventListener('click', (e) => this.onListClick(e));
        this.listEl?.addEventListener('keydown', (e) => this.onKeydown(e));
        this.searchEl?.addEventListener('keydown', (e) => this.onKeydown(e));

        document.getElementById('sndManage')?.addEventListener('click', () => {
            this.close();
            void samplesModal.open();
        });

        // The catalog is rebuilt on sounds:changed; only re-read it while open.
        document.addEventListener('sounds:changed', () => {
            this.dirty = true;
            if (this.root && !this.root.hidden) void this.refresh();
        });
        document.addEventListener('density:changed', () => {
            this.list?.setRowHeight(readRowHeight());
        });

        this.inited = true;
    }

    async open(query?: string): Promise<void> {
        this.init();
        if (!this.root) return;
        if (query !== undefined && this.searchEl) {
            this.searchEl.value = query;
            this.query = query;
        }
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
        this.unsubscribeAudition = onAuditionChange(() => this.list?.refresh());
        // The catalog only changes on sounds:changed, so a reopen with nothing
        // dirty just re-filters what is already in hand.
        if (this.dirty || !this.catalog) await this.refresh();
        else this.rebuild();
        queueMicrotask(() => this.searchEl?.focus());
    }

    close(): void {
        if (!this.root) return;
        stopAudition();
        this.unsubscribeAudition?.();
        this.unsubscribeAudition = null;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async refresh(): Promise<void> {
        if (!this.listEl) return;
        try {
            this.catalog = await loadCatalog();
            this.dirty = false;
        } catch (e) {
            this.listEl.replaceChildren();
            if (this.emptyEl) {
                this.emptyEl.hidden = false;
                this.emptyEl.className = 'snd-error';
                this.emptyEl.textContent = `Could not read the sound catalog: ${e}`;
            }
            return;
        }
        this.list ??= new VirtualList<Row>({
            viewport: this.listEl,
            rowHeight: readRowHeight(),
            renderRow: (row, i) => this.renderRow(row, i),
        });
        this.renderRail();
        this.rebuild();
    }

    private visibleBanks(): Bank[] {
        const all = this.catalog?.banks ?? [];
        const inCat = this.category === 'all' ? all : all.filter((b) => b.category === this.category);
        return filterBanks(inCat, this.query);
    }

    private rebuild(): void {
        const banks = this.visibleBanks();
        const rows: Row[] = [];
        for (const bank of banks) {
            rows.push({t: 'bank', bank});
            if (this.expanded.has(bank.name)) {
                bank.samples.forEach((ref, index) => rows.push({t: 'sample', bank, ref, index}));
            }
        }
        this.rows = rows;
        this.list?.setItems(rows);

        const total = this.catalog?.banks.length ?? 0;
        if (this.countEl) {
            this.countEl.textContent = this.query || this.category !== 'all'
                ? `${banks.length} of ${total}`
                : `${total}`;
        }
        if (this.emptyEl) {
            this.emptyEl.className = 'snd-empty';
            this.emptyEl.hidden = rows.length > 0;
            this.emptyEl.textContent = this.query
                ? `No bank matches “${this.query}”.`
                : 'No sounds in this category.';
        }
        this.select(Math.min(this.selected, Math.max(0, rows.length - 1)), false);
    }

    private renderRail(): void {
        if (!this.railEl || !this.catalog) return;
        const counts = this.catalog.counts;
        this.railEl.innerHTML = CATEGORIES
            .filter((c) => c.id === 'all' || (counts[c.id] ?? 0) > 0)
            .map((c) => {
                const active = c.id === this.category;
                return `<button class="snd-rail-item${active ? ' is-active' : ''}" type="button" ` +
                    `data-cat="${c.id}" aria-current="${active}">` +
                    `<span class="snd-rail-label">${escapeHtml(c.label)}</span>` +
                    `<span class="snd-rail-count">${counts[c.id] ?? 0}</span></button>`;
            })
            .join('');
    }

    private renderRow(row: Row, index: number): HTMLElement {
        const el = document.createElement('div');
        el.className = 'snd-row';
        el.setAttribute('role', 'option');
        el.setAttribute('aria-setsize', String(this.rows.length));
        el.setAttribute('aria-posinset', String(index + 1));
        el.dataset.idx = String(index);
        if (index === this.selected) el.classList.add('is-selected');

        if (row.t === 'bank') {
            const b = row.bank;
            const open = this.expanded.has(b.name);
            el.classList.add('snd-row--bank');
            el.setAttribute('aria-selected', String(index === this.selected));
            if (b.auditionable) el.setAttribute('aria-expanded', String(open));
            el.dataset.bank = b.name;
            const tags = [
                b.disabled ? '<span class="snd-row-tag" data-flag="disabled">pack off</span>' : '',
                b.shadowed ? '<span class="snd-row-tag" data-flag="shadowed">shadowed</span>' : '',
                b.source === 'pack' ? '<span class="snd-row-tag" data-flag="live">live only</span>' : '',
            ].join('');
            el.innerHTML =
                `<span class="snd-row-caret">${b.auditionable ? (open ? '▾' : '▸') : ''}</span>` +
                `<span class="snd-row-name">${escapeHtml(b.name)}</span>` +
                `<span class="snd-row-kind">${escapeHtml(b.kind)}</span>${tags}` +
                `<span class="snd-row-meta">${b.count || ''}</span>` +
                `<span class="snd-row-origin">${escapeHtml(b.origin)}</span>` +
                (b.auditionable
                    ? `<button class="snd-audition" type="button" data-audition="0" data-tooltip="Audition">▶</button>`
                    : '<span class="snd-audition-spacer"></span>');
            if (b.samples[0] && playingKey() === refKey(b.samples[0])) {
                el.classList.add('is-playing');
                el.querySelector('.snd-audition')?.classList.add('is-playing');
            }
            // A pack bank plays live but is not yet resolved during export.
            if (b.source === 'pack') {
                el.dataset.tooltip = 'Pack bank — plays live; not yet included in audio export';
            }
            return el;
        }

        el.classList.add('snd-row--sample');
        el.style.setProperty('--depth', '1');
        el.dataset.bank = row.bank.name;
        el.dataset.sample = String(row.index);
        el.setAttribute('aria-selected', String(index === this.selected));
        const token = row.index === 0 ? row.bank.name : `${row.bank.name}:${row.index}`;
        el.innerHTML =
            '<span class="snd-row-caret"></span>' +
            `<span class="snd-row-name">${escapeHtml(token)}</span>` +
            `<span class="snd-row-meta">${escapeHtml(row.ref.label)}</span>` +
            (row.ref.note ? `<span class="snd-row-tag">${escapeHtml(row.ref.note)}</span>` : '') +
            `<button class="snd-audition" type="button" data-audition="${row.index}" data-tooltip="Audition">▶</button>`;
        if (playingKey() === refKey(row.ref)) {
            el.classList.add('is-playing');
            el.querySelector('.snd-audition')?.classList.add('is-playing');
        }
        return el;
    }

    private onListClick(e: MouseEvent): void {
        const rowEl = (e.target as Element).closest('.snd-row') as HTMLElement | null;
        if (!rowEl?.dataset.idx) return;
        const index = Number(rowEl.dataset.idx);
        const row = this.rows[index];
        if (!row) return;

        this.select(index, false);

        // The audition button previews without changing what is inserted.
        if ((e.target as Element).closest('.snd-audition')) {
            const ref = row.t === 'sample' ? row.ref : row.bank.samples[0];
            if (ref) void this.play(ref);
            return;
        }

        if (row.t === 'sample') {
            insertSound(row.bank, row.index);
            void this.play(row.ref);
            return;
        }

        // Clicking a bank expands it and previews it, so you hear what you are
        // about to write before you commit to it.
        if (row.bank.auditionable) {
            if (this.expanded.has(row.bank.name)) this.expanded.delete(row.bank.name);
            else this.expanded.add(row.bank.name);
            this.rebuild();
            const first = row.bank.samples[0];
            if (first) void this.play(first);
        } else {
            insertSound(row.bank);
        }
    }

    private onKeydown(e: KeyboardEvent): void {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.select(this.selected + (e.key === 'ArrowDown' ? 1 : -1), true);
            return;
        }
        const row = this.rows[this.selected];
        if (!row) return;
        if (e.key === ' ' && document.activeElement !== this.searchEl) {
            e.preventDefault();
            const ref = row.t === 'sample' ? row.ref : row.bank.samples[0];
            if (ref) void this.play(ref);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (row.t === 'sample') insertSound(row.bank, row.index);
            else insertSound(row.bank);
            this.close();
        }
    }

    private select(index: number, scroll: boolean): void {
        const clamped = Math.max(0, Math.min(index, this.rows.length - 1));
        if (clamped === this.selected && !scroll) {
            this.list?.refresh();
            return;
        }
        this.selected = clamped;
        if (scroll) this.list?.scrollToIndex(clamped);
        this.list?.refresh();
    }

    private async play(ref: SampleRef): Promise<void> {
        try {
            await auditionSample(ref);
        } catch (e) {
            console.warn('[sound-browser] audition failed:', e);
        }
    }
}

export const soundBrowser = new SoundBrowser();
