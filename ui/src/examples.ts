/**
 * Examples Browser — progressive lessons, patterns, showcase, techniques,
 * full songs, and genre sketches. All entries target the strudel-rs dialect
 * (see docs/DIALECT.md). The same material is seeded into the user library
 * under `Demos/` for File Explorer browsing.
 */

import {EXAMPLES, SECTION_LABELS, SECTION_ORDER, type Example} from './examples-data.js';
import {escapeHtml} from './html.js';

type LoadCodeFn = (code: string) => void;

export class ExamplesBrowser {
    private modal: HTMLDivElement | null = null;
    private visible = false;
    private loadCode: LoadCodeFn;
    private filter = '';

    constructor(loadCode: LoadCodeFn) {
        this.loadCode = loadCode;
        const countEl = document.getElementById('examplesCount');
        if (countEl) countEl.textContent = `${EXAMPLES.length} patterns`;
    }

    toggle(): void {
        this.visible ? this.hide() : this.show();
    }

    show(): void {
        if (!this.modal) this.buildModal();
        this.modal!.classList.add('ex-visible');
        this.visible = true;
        document.addEventListener('keydown', this.onKey);
    }

    hide(): void {
        this.modal?.classList.remove('ex-visible');
        this.visible = false;
        document.removeEventListener('keydown', this.onKey);
    }

    private onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            this.hide();
        }
    };

    private buildModal(): void {
        const modal = document.createElement('div');
        modal.className = 'ex-overlay';

        modal.innerHTML = `
            <div class="ex-modal">
                <div class="ex-header">
                    <span class="ex-title">Examples</span>
                    <span class="ex-subtitle">${EXAMPLES.length} patterns · Play first, then load</span>
                    <button class="ex-close" type="button" aria-label="Close">&times;</button>
                </div>
                <p class="ex-tip">Tip: press <kbd>⌘↩</kbd> (Play) so audio is armed, then pick a lesson.
                  Full files also land in your library under <strong>Demos/</strong>.</p>
                <div class="ex-toolbar">
                    <input type="search" class="ex-search" placeholder="Filter by title or tag…" autocomplete="off" spellcheck="false">
                    <span class="ex-filter-count"></span>
                </div>
                <div class="ex-grid"></div>
            </div>
        `;

        const grid = modal.querySelector('.ex-grid') as HTMLElement;
        const search = modal.querySelector('.ex-search') as HTMLInputElement;
        const filterCount = modal.querySelector('.ex-filter-count') as HTMLElement;
        this.renderGrid(grid, filterCount);

        search.addEventListener('input', () => {
            this.filter = search.value.trim().toLowerCase();
            this.renderGrid(grid, filterCount);
        });

        grid.addEventListener('click', (e) => {
            const card = (e.target as Element).closest('.ex-card') as HTMLElement | null;
            if (card) {
                const idx = parseInt(card.dataset.idx!, 10);
                this.loadCode(EXAMPLES[idx].code);
                this.hide();
            }
        });

        modal.querySelector('.ex-close')!.addEventListener('click', () => this.hide());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hide();
        });

        document.body.appendChild(modal);
        this.modal = modal;
        // Focus search when opened.
        queueMicrotask(() => search.focus());
    }

    private renderGrid(grid: HTMLElement, filterCount: HTMLElement): void {
        const q = this.filter;
        let visible = 0;
        const sectionsHtml = SECTION_ORDER.map((section) => {
            const entries = EXAMPLES
                .map((ex, idx) => ({ex, idx}))
                .filter(({ex}) => {
                    if (ex.section !== section) return false;
                    if (!q) return true;
                    const hay = `${ex.title} ${ex.tags.join(' ')} ${ex.blurb ?? ''} ${ex.complexity}`.toLowerCase();
                    return hay.includes(q);
                });
            if (entries.length === 0) return '';
            visible += entries.length;
            const cards = entries.map(({ex, idx}) => this.cardHtml(ex, idx)).join('');
            return `
                <div class="ex-section">
                    <div class="ex-section-label">${escapeHtml(SECTION_LABELS[section])}
                      <span class="ex-section-count">${entries.length}</span>
                    </div>
                    ${cards}
                </div>
            `;
        }).join('');

        grid.innerHTML = sectionsHtml || `<p class="ex-empty">No examples match “${escapeHtml(q)}”.</p>`;
        filterCount.textContent = q
            ? `${visible} of ${EXAMPLES.length}`
            : `${EXAMPLES.length} total`;
    }

    private cardHtml(ex: Example, idx: number): string {
        const tagsHtml = ex.tags.slice(0, 3)
            .map((t) => `<span class="ex-tag">${escapeHtml(t)}</span>`)
            .join('');
        const lessonBadge = ex.lesson != null
            ? `<span class="ex-lesson">L${ex.lesson}</span>`
            : '';
        const title = ex.lesson != null
            ? `Lesson ${ex.lesson} · ${ex.title}`
            : ex.title;

        return `
            <button class="ex-card" type="button" data-idx="${idx}" data-tooltip="${escapeHtml(ex.blurb ?? ex.title)}">
                ${lessonBadge}
                <span class="ex-card-title">${escapeHtml(title)}</span>
                <span class="ex-complexity">${escapeHtml(ex.complexity)}</span>
                <div class="ex-card-meta">
                    ${tagsHtml}
                    ${ex.tempo ? `<span class="ex-tempo">${ex.tempo} bpm</span>` : ''}
                </div>
            </button>
        `;
    }
}
