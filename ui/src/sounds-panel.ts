/**
 * Sidebar Sounds panel — a compact, searchable view onto the same catalog the
 * Sound Browser uses.
 *
 * Replaces the chip grid, which rendered every bank of the active set into a
 * 220px box with no filter: ~1000 buttons with `strudel-cc` active. Groups are
 * collapsed by default here, so the panel opens with a dozen rows rather than a
 * thousand, and "Browse…" hands the current query to the full browser.
 *
 * Everything but group-collapse state comes from the shared modules, so the
 * panel and the browser cannot disagree about what exists or how it ranks.
 */

import {escapeHtml} from './html.js';
import {samplesModal} from './samples-modal.js';
import {soundBrowser} from './sound-browser.js';
import {VirtualList, readRowHeight} from './virtual-list.js';
import {auditionSample, refKey, playingKey, onAuditionChange} from './audition.js';
import {insertSound} from './sound-insert.js';
import {loadCatalog, filterBanks, CATEGORIES, type Bank, type Catalog} from './sound-catalog.js';

type Row =
    | {t: 'group'; id: string; label: string; count: number; open: boolean}
    | {t: 'bank'; bank: Bank}
    | {t: 'more'; total: number};

export class SoundsPanel {
    private listEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private filterEl: HTMLInputElement | null = null;

    private list: VirtualList<Row> | null = null;
    private catalog: Catalog | null = null;
    private rows: Row[] = [];
    /** Only `drums` starts open — the rest are one click away. */
    private open = new Set<string>(['drums']);
    private query = '';

    async init(): Promise<void> {
        this.listEl = document.getElementById('soundsList');
        this.countEl = document.getElementById('soundsCount');
        this.filterEl = document.getElementById('soundsFilter') as HTMLInputElement | null;
        if (!this.listEl) return;

        this.filterEl?.addEventListener('input', () => {
            this.query = this.filterEl?.value ?? '';
            this.rebuild();
        });
        this.listEl.addEventListener('click', (e) => this.onClick(e));

        document.getElementById('soundsManage')?.addEventListener('click', () => void samplesModal.open());
        document.getElementById('soundsBrowseAll')?.addEventListener('click', () => {
            void soundBrowser.open(this.query);
        });

        document.addEventListener('sounds:changed', () => void this.refresh());
        document.addEventListener('density:changed', () => this.list?.setRowHeight(readRowHeight()));
        onAuditionChange(() => this.list?.refresh());

        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.listEl) return;
        // No isTauri gate: the catalog's bundled branch is a plain fetch of the
        // generated manifest, so `npm run dev` in a browser shows the real
        // bundled kit (minus packs and synths, which need the backend). That
        // makes the panel and the browser verifiable without the desktop shell.
        try {
            this.catalog = await loadCatalog();
        } catch (e) {
            this.listEl.innerHTML = `<div class="snd-error">${escapeHtml(String(e))}</div>`;
            return;
        }
        this.list ??= new VirtualList<Row>({
            viewport: this.listEl,
            rowHeight: readRowHeight(),
            renderRow: (row, i) => this.renderRow(row, i),
        });
        this.rebuild();
    }

    private rebuild(): void {
        const cat = this.catalog;
        if (!cat) return;
        const rows: Row[] = [];
        const q = this.query.trim();

        if (q) {
            // Searching flattens: headers would just push results off screen.
            for (const bank of filterBanks(cat.banks, q)) rows.push({t: 'bank', bank});
        } else {
            for (const def of CATEGORIES) {
                if (def.id === 'all') continue;
                const banks = cat.banks.filter((b) => b.category === def.id);
                if (!banks.length) continue;
                const open = this.open.has(def.id);
                rows.push({t: 'group', id: def.id, label: def.label, count: banks.length, open});
                if (open) for (const bank of banks) rows.push({t: 'bank', bank});
            }
        }
        rows.push({t: 'more', total: cat.banks.length});

        this.rows = rows;
        this.list?.setItems(rows);
        if (this.countEl) {
            const shown = rows.filter((r) => r.t === 'bank').length;
            this.countEl.textContent = q ? `${shown} of ${cat.banks.length}` : String(cat.banks.length);
        }
    }

    private renderRow(row: Row, index: number): HTMLElement {
        const el = document.createElement('div');
        el.dataset.idx = String(index);

        if (row.t === 'group') {
            el.className = 'snd-row snd-row--group';
            el.setAttribute('role', 'presentation');
            el.dataset.group = row.id;
            el.setAttribute('aria-expanded', String(row.open));
            el.innerHTML =
                `<span class="snd-row-caret">${row.open ? '▾' : '▸'}</span>` +
                `<span class="snd-row-name">${escapeHtml(row.label)}</span>` +
                `<span class="snd-row-meta">${row.count}</span>`;
            return el;
        }

        if (row.t === 'more') {
            el.className = 'snd-row snd-row--more';
            el.dataset.more = '1';
            el.textContent = `Browse all ${row.total} sounds…`;
            return el;
        }

        const b = row.bank;
        el.className = 'snd-row snd-row--bank';
        el.setAttribute('role', 'option');
        el.setAttribute('aria-setsize', String(this.rows.length));
        el.setAttribute('aria-posinset', String(index + 1));
        el.dataset.bank = b.name;
        el.innerHTML =
            '<span class="snd-row-caret"></span>' +
            `<span class="snd-row-name">${escapeHtml(b.name)}</span>` +
            `<span class="snd-row-meta">${b.count || ''}</span>` +
            (b.auditionable
                ? '<button class="snd-audition" type="button" data-tooltip="Audition">▶</button>'
                : '<span class="snd-audition-spacer"></span>');
        if (b.samples[0] && playingKey() === refKey(b.samples[0])) el.classList.add('is-playing');
        return el;
    }

    private onClick(e: MouseEvent): void {
        const rowEl = (e.target as Element).closest('.snd-row') as HTMLElement | null;
        if (!rowEl?.dataset.idx) return;
        const row = this.rows[Number(rowEl.dataset.idx)];
        if (!row) return;

        if (row.t === 'more') {
            void soundBrowser.open(this.query);
            return;
        }
        if (row.t === 'group') {
            if (this.open.has(row.id)) this.open.delete(row.id);
            else this.open.add(row.id);
            this.rebuild();
            return;
        }

        const first = row.bank.samples[0];
        if ((e.target as Element).closest('.snd-audition')) {
            if (first) void auditionSample(first).catch(() => {});
            return;
        }
        insertSound(row.bank);
        if (first) void auditionSample(first).catch(() => {});
    }
}

export const soundsPanel = new SoundsPanel();
