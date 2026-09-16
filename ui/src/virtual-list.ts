/**
 * Fixed-height windowed list — the app's first virtualizer.
 *
 * The Sounds panel used to render every bank as a DOM node; with the
 * `strudel-cc` sample set active that is 1000+ nodes rebuilt on every refresh.
 * This keeps ~30 nodes alive regardless of item count.
 *
 * Deliberately minimal: one fixed row height, no recycling, no variable
 * heights. Rows are recreated per window change (~30 `createElement` calls per
 * scroll frame, which is nothing) rather than recycled, because recycling is a
 * bug farm for no measurable gain at this size. Clicks are delegated on the
 * viewport, so recreating rows leaks no listeners.
 *
 * Row height is load-bearing: it must equal the CSS `--row-h` token. Use
 * `readRowHeight()` rather than hardcoding, and call `setRowHeight()` when the
 * density ladder changes.
 */

export interface VirtualListOptions<T> {
    /** Bounded-height, `overflow-y: auto` element. The list owns its children. */
    viewport: HTMLElement;
    /** Row pitch in px. Must match the rendered row's border-box height. */
    rowHeight: number;
    /** Rows rendered beyond each edge of the viewport. */
    overscan?: number;
    renderRow(item: T, index: number): HTMLElement;
}

/** Read the `--row-h` token the CSS density ladder sets. */
export function readRowHeight(fallback = 30): number {
    if (typeof getComputedStyle !== 'function') return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class VirtualList<T> {
    private readonly viewport: HTMLElement;
    private readonly spacer: HTMLElement;
    private readonly window: HTMLElement;
    private readonly overscan: number;
    private readonly renderRow: (item: T, index: number) => HTMLElement;

    private rowHeight: number;
    private _items: T[] = [];
    private first = -1;
    private last = -1;
    private frame = 0;
    private resizeObserver: ResizeObserver | null = null;
    private checkedPitch = false;

    constructor(opts: VirtualListOptions<T>) {
        this.viewport = opts.viewport;
        this.rowHeight = opts.rowHeight;
        this.overscan = opts.overscan ?? 6;
        this.renderRow = opts.renderRow;

        this.spacer = document.createElement('div');
        this.spacer.className = 'vlist-spacer';
        this.window = document.createElement('div');
        this.window.className = 'vlist-window';
        this.spacer.appendChild(this.window);
        this.viewport.replaceChildren(this.spacer);

        this.onScroll = this.onScroll.bind(this);
        this.viewport.addEventListener('scroll', this.onScroll, {passive: true});

        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => this.render(true));
            this.resizeObserver.observe(this.viewport);
        }
    }

    get items(): readonly T[] {
        return this._items;
    }

    setItems(items: T[]): void {
        this._items = items;
        this.viewport.scrollTop = 0;
        this.spacer.style.height = `${items.length * this.rowHeight}px`;
        this.render(true);
    }

    /** Re-render the live window in place (selection changed, a row's data moved). */
    refresh(): void {
        this.render(true);
    }

    /** Density changed — re-pitch without losing the items. */
    setRowHeight(rowHeight: number): void {
        if (rowHeight <= 0 || rowHeight === this.rowHeight) return;
        this.rowHeight = rowHeight;
        this.checkedPitch = false;
        this.spacer.style.height = `${this._items.length * rowHeight}px`;
        this.render(true);
    }

    /** Scroll `index` into view by the shortest move. Used by keyboard nav. */
    scrollToIndex(index: number): void {
        if (index < 0 || index >= this._items.length) return;
        const top = index * this.rowHeight;
        const bottom = top + this.rowHeight;
        const viewTop = this.viewport.scrollTop;
        const viewBottom = viewTop + this.viewport.clientHeight;
        if (top < viewTop) this.viewport.scrollTop = top;
        else if (bottom > viewBottom) this.viewport.scrollTop = bottom - this.viewport.clientHeight;
    }

    destroy(): void {
        this.viewport.removeEventListener('scroll', this.onScroll);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.viewport.replaceChildren();
    }

    private onScroll(): void {
        // Coalesce to one render per frame; scroll fires far more often.
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.render(false);
        });
    }

    private render(force: boolean): void {
        const count = this._items.length;
        const height = this.viewport.clientHeight || this.rowHeight * 10;
        const visible = Math.ceil(height / this.rowHeight);
        const first = Math.max(0, Math.floor(this.viewport.scrollTop / this.rowHeight) - this.overscan);
        const last = Math.min(count, first + visible + this.overscan * 2);

        if (!force && first === this.first && last === this.last) return;
        this.first = first;
        this.last = last;

        const rows: HTMLElement[] = [];
        for (let i = first; i < last; i++) rows.push(this.renderRow(this._items[i], i));
        this.window.style.transform = `translateY(${first * this.rowHeight}px)`;
        this.window.replaceChildren(...rows);

        this.assertPitch(rows[0]);
    }

    /**
     * The CSS `--row-h` token and the JS row height must agree or the window
     * drifts from the scrollbar. Checked once per pitch — one forced layout per
     * density change, which is cheap enough to leave on in release builds.
     */
    private assertPitch(row: HTMLElement | undefined): void {
        if (this.checkedPitch || !row) return;
        this.checkedPitch = true;
        requestAnimationFrame(() => {
            const actual = row.offsetHeight;
            if (actual && Math.abs(actual - this.rowHeight) > 0.5) {
                console.warn(
                    `[virtual-list] row pitch mismatch: CSS renders ${actual}px, ` +
                    `virtualizer assumes ${this.rowHeight}px. Check --row-h.`,
                );
            }
        });
    }
}
