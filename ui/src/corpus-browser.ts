/**
 * Corpus browser panel.
 * Only strudel-rs compatible entries are ever shown (the Rust loader in
 * robostrudel-corpus drops "js-song", "tidal", etc. at load time because this
 * app is built on the strudel-rs WASM engine, not the full web-strudel JS runtime).
 * Backed by `search_corpus` / `get_corpus_source`.
 */

import {fileManager} from './file-manager.js';
import type {CorpusEntry, CorpusQuery} from './types/tauri-commands.js';

const isTauri = !!(window as any).__TAURI__;

export class CorpusBrowser {
    private searchEl: HTMLInputElement | null = null;
    private resultsEl: HTMLDivElement | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private results: CorpusEntry[] = [];

    async init(): Promise<void> {
        const panel = document.getElementById('corpusPanel');
        if (!panel) return;

        this.searchEl = panel.querySelector('#corpusSearch') as HTMLInputElement | null;
        this.resultsEl = panel.querySelector('#corpusResults') as HTMLDivElement | null;

        if (!this.searchEl || !this.resultsEl) return;

        this.searchEl.addEventListener('input', () => this.scheduleSearch());

        this.resultsEl.addEventListener('click', (e) => {
            const card = (e.target as Element).closest('.corpus-entry') as HTMLElement | null;
            if (!card) return;
            const idx = parseInt(card.dataset.idx ?? '-1', 10);
            const entry = this.results[idx];
            if (entry) void this.loadEntry(entry);
        });

        if (isTauri) {
            this.resultsEl.innerHTML = '<div class="corpus-empty">Loading corpus…</div>';
            await this.runSearch(); // initial populate with no filters
        } else {
            this.resultsEl.innerHTML = '<div class="corpus-empty">Corpus only available in desktop build.</div>';
        }
    }

    private scheduleSearch(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.runSearch(), 180);
    }

    private currentQuery(): CorpusQuery {
        const keyword = this.searchEl?.value.trim() || null;
        return {
            tags: [],
            role: null,
            tempo_min: null,
            tempo_max: null,
            complexity: null,
            sounds: [],
            keyword,
            limit: 100,
        };
    }

    private async runSearch(): Promise<void> {
        if (!this.resultsEl) return;
        try {
            this.results = await invoke<CorpusEntry[]>('search_corpus', {
                query: this.currentQuery(),
            });
            this.render();
        } catch (e: any) {
            this.resultsEl.innerHTML = `<div class="corpus-error">${escapeHtml(String(e))}</div>`;
        }
    }

    private render(): void {
        if (!this.resultsEl) return;
        const countEl = document.getElementById('corpusCount');
        if (countEl) countEl.textContent = `${this.results.length}`;
        if (this.results.length === 0) {
            this.resultsEl.innerHTML = '<div class="corpus-empty">No matches.</div>';
            return;
        }
        this.resultsEl.innerHTML = this.results.map((entry, idx) => {
            const rawTitle = entry.title ?? entry.filename;
            // Light client-side trim for extremely long noisy metadata titles (CSS truncation is primary)
            const title = rawTitle.length > 78 ? rawTitle.slice(0, 75) + '…' : rawTitle;
            const tags = entry.tags.slice(0, 3)
                .map(t => `<span class="corpus-tag">${escapeHtml(t)}</span>`)
                .join('');
            const tempo = entry.tempo ? `<span class="corpus-tempo">${Math.round(entry.tempo)} bpm</span>` : '';
            const isCurated = entry.tags.includes('curated') ? 'true' : 'false';
            const ft = (entry.file_type || '').toLowerCase();
            // All entries that reach the UI are now guaranteed strudel-rs compatible
            // (js-song / tidal etc. are filtered at load time in the Rust corpus loader).
            const sourceLabel = isCurated === 'true' ? 'curated' : 'rs';
            return `
                <button class="corpus-entry" data-idx="${idx}" data-curated="${isCurated}" data-source="${ft || (isCurated==='true'?'curated':'strudel')}">
                    <span class="corpus-entry-title">${escapeHtml(title)}</span>
                    <span class="corpus-entry-meta"><span class="corpus-source good">${sourceLabel}</span>${tags}${tempo}</span>
                </button>
            `;
        }).join('');
    }

    private async loadEntry(entry: CorpusEntry): Promise<void> {
        if (fileManager.isDirty) {
            const {ask} = await import('@tauri-apps/plugin-dialog');
            const ok = await ask(
                `Load "${entry.title ?? entry.filename}"? Unsaved changes will be lost.`,
                {title: 'Robostrudel', kind: 'warning'},
            );
            if (!ok) return;
        }
        try {
            const code = await invoke<string>('get_corpus_source', {id: entry.id});
            const app = window.strudelApp;
            if (app?.isInitialized) {
                await app.replaceCodeAndPlay(code);
            } else {
                app?.editor?.setCode(code);
            }
            // Corpus entries aren't backed by a local file — so from the
            // file-manager's perspective this is now an unsaved buffer
            // derived from corpus. Clear the current file reference.
            document.dispatchEvent(new CustomEvent('corpus:loaded', {
                detail: {title: entry.title ?? entry.filename, tempo: entry.tempo},
            }));
        } catch (e: any) {
            console.error('[corpus] get_corpus_source failed:', e);
        }
    }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return (window as any).__TAURI__.core.invoke(cmd, args);
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const corpusBrowser = new CorpusBrowser();
