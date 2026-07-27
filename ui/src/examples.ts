/**
 * Examples Browser — progressive lessons, patterns, and showcase.
 * All entries target the strudel-rs dialect (see docs/DIALECT.md).
 */

import {EXAMPLES, SECTION_LABELS, SECTION_ORDER, type Example} from './examples-data.js';

type LoadCodeFn = (code: string) => void;

export class ExamplesBrowser {
    private modal: HTMLDivElement | null = null;
    private visible = false;
    private loadCode: LoadCodeFn;

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

        const sectionsHtml = SECTION_ORDER.map((section) => {
            const entries = EXAMPLES
                .map((ex, idx) => ({ex, idx}))
                .filter(({ex}) => ex.section === section);
            if (entries.length === 0) return '';

            const cards = entries.map(({ex, idx}) => this.cardHtml(ex, idx)).join('');
            return `
                <div class="ex-section">
                    <div class="ex-section-label">${this.esc(SECTION_LABELS[section])}</div>
                    ${cards}
                </div>
            `;
        }).join('');

        modal.innerHTML = `
            <div class="ex-modal">
                <div class="ex-header">
                    <span class="ex-title">Examples</span>
                    <span class="ex-subtitle">${EXAMPLES.length} validated · Play first, then load</span>
                    <button class="ex-close" type="button" aria-label="Close">&times;</button>
                </div>
                <p class="ex-tip">Tip: press <kbd>⌘↩</kbd> (Play) so audio is armed, then pick a lesson.</p>
                <div class="ex-grid">${sectionsHtml}</div>
            </div>
        `;

        modal.querySelector('.ex-grid')!.addEventListener('click', (e) => {
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
    }

    private cardHtml(ex: Example, idx: number): string {
        const tagsHtml = ex.tags.slice(0, 3)
            .map((t) => `<span class="ex-tag">${this.esc(t)}</span>`)
            .join('');
        const lessonBadge = ex.lesson != null
            ? `<span class="ex-lesson">L${ex.lesson}</span>`
            : '';
        const title = ex.lesson != null
            ? `Lesson ${ex.lesson} · ${ex.title}`
            : ex.title;

        return `
            <button class="ex-card" type="button" data-idx="${idx}" title="${this.esc(ex.blurb ?? ex.title)}">
                ${lessonBadge}
                <span class="ex-card-title">${this.esc(title)}</span>
                <span class="ex-complexity">${this.esc(ex.complexity)}</span>
                <div class="ex-card-meta">
                    ${tagsHtml}
                    ${ex.tempo ? `<span class="ex-tempo">${ex.tempo} bpm</span>` : ''}
                </div>
            </button>
        `;
    }

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
