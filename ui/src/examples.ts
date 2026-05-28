/**
 * Examples Browser — validated patterns from strudel-corpus.
 * All examples pass strudel-rs validation.
 */

import {EXAMPLES} from './examples-data.js';

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

        const list = EXAMPLES.map(entry => {
            const tagsHtml = entry.tags.slice(0, 3)
                .map(t => `<span class="ex-tag">${this.esc(t)}</span>`)
                .join('');

            return `
                <button class="ex-card" data-idx="${EXAMPLES.indexOf(entry)}">
                    <span class="ex-card-title">${this.esc(entry.title)}</span>
                    <span class="ex-complexity">${entry.complexity}</span>
                    <div class="ex-card-meta">
                        ${tagsHtml}
                        ${entry.tempo ? `<span class="ex-tempo">${entry.tempo} bpm</span>` : ''}
                    </div>
                </button>
            `;
        }).join('');

        modal.innerHTML = `
            <div class="ex-modal">
                <div class="ex-header">
                    <span class="ex-title">Examples</span>
                    <span class="ex-subtitle">${EXAMPLES.length} validated patterns</span>
                    <button class="ex-close">&times;</button>
                </div>
                <div class="ex-grid">${list}</div>
            </div>
        `;

        // Event delegation for cards
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

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
