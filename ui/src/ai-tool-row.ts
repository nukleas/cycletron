/**
 * The minimal tool row in the AI chat: one collapsed `<details>` per tool
 * call — glyph, tool name, the outcome's one-line summary, a category chip on
 * failure, and the wall time — with the input JSON and the full result text
 * inside. Built here as pure DOM so the live stream (ai-bridge) and the
 * session replay (boot) render the exact same row.
 */

import type {ToolOutcome, ToolTrace} from './types/tauri-commands.js';

/** Open a pending row for a tool the model just called. */
export function createToolRow(id: string, name: string, input: unknown): HTMLDetailsElement {
    const row = document.createElement('details');
    row.className = 'ai-tool ai-tool-pending';
    row.dataset.toolId = id;

    const head = document.createElement('summary');
    head.innerHTML =
        '<span class="ai-tool-glyph">\u2026</span>' +
        '<span class="ai-tool-name"></span>' +
        '<span class="ai-tool-summary"></span>' +
        '<span class="ai-tool-cat" hidden></span>' +
        '<span class="ai-tool-ms"></span>';
    head.querySelector('.ai-tool-name')!.textContent = name;
    head.querySelector('.ai-tool-summary')!.textContent = 'running';
    row.appendChild(head);

    const inputEl = document.createElement('pre');
    inputEl.className = 'ai-tool-input';
    inputEl.textContent = formatInput(input);
    row.appendChild(inputEl);
    return row;
}

/** Close a row with its outcome. */
export function completeToolRow(row: HTMLDetailsElement, outcome: ToolOutcome, durationMs: number): void {
    row.classList.remove('ai-tool-pending');
    row.classList.add(outcome.ok ? 'ai-tool-ok' : 'ai-tool-err');
    const q = (sel: string) => row.querySelector(sel) as HTMLElement;
    q('.ai-tool-glyph').textContent = outcome.ok ? '\u2713' : '\u2717';
    q('.ai-tool-summary').textContent = outcome.summary || (outcome.ok ? 'ok' : 'failed');
    const cat = q('.ai-tool-cat');
    if (!outcome.ok && outcome.category) {
        cat.textContent = outcome.category;
        cat.hidden = false;
    }
    q('.ai-tool-ms').textContent = formatMs(durationMs);

    if (outcome.text) {
        const text = document.createElement('pre');
        text.className = 'ai-tool-text';
        text.textContent = outcome.text;
        row.appendChild(text);
    }
}

/** A finished row from a persisted trace (session restore). */
export function toolRowFromTrace(t: ToolTrace): HTMLDetailsElement {
    const row = createToolRow(t.id, t.name, t.input);
    completeToolRow(row, t.outcome, t.duration_ms);
    return row;
}

function formatInput(input: unknown): string {
    try {
        const s = JSON.stringify(input, null, 1) ?? '{}';
        return s.length > 2000 ? s.slice(0, 2000) + '\u2026' : s;
    } catch {
        return String(input);
    }
}

function formatMs(ms: number): string {
    if (!Number.isFinite(ms)) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
