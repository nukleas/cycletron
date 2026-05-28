/**
 * Logs modal — surfaces the Rust ring buffer of `tracing` events.
 *
 * "Copy Diagnostic Dump" composes the buffer with app/Tauri/OS metadata
 * into a clipboard payload designed for pasting into a bug report.
 */

import {dismissibleModal} from './modal-utils.js';

const isTauri = !!(window as any).__TAURI__;

interface LogEntry {
    ts_ms: number;
    level: string;
    target: string;
    message: string;
}

class LogsModal {
    private root: HTMLElement | null = null;
    private content: HTMLPreElement | null = null;
    private countEl: HTMLElement | null = null;
    private cleanup: (() => void) | null = null;
    private copyBtn: HTMLButtonElement | null = null;

    init(): void {
        this.root = document.getElementById('logsModal');
        if (!this.root) return;
        this.content = document.getElementById('logsContent') as HTMLPreElement | null;
        this.countEl = document.getElementById('logsCount');
        this.copyBtn = document.getElementById('logsCopyDump') as HTMLButtonElement | null;

        document.getElementById('logsRefresh')?.addEventListener('click', () => void this.refresh());
        document.getElementById('logsClear')?.addEventListener('click', () => void this.clear());
        this.copyBtn?.addEventListener('click', () => void this.copyDump());
    }

    async open(): Promise<void> {
        if (!this.root) return;
        await this.refresh();
        this.root.hidden = false;
        this.cleanup = dismissibleModal(this.root, () => this.close());
    }

    private close(): void {
        if (!this.root) return;
        this.root.hidden = true;
        this.cleanup?.();
        this.cleanup = null;
    }

    private async refresh(): Promise<void> {
        if (!isTauri) {
            if (this.content) this.content.textContent = 'Logs are only collected in the desktop build.';
            return;
        }
        try {
            const entries = await invoke<LogEntry[]>('get_logs');
            if (this.countEl) this.countEl.textContent = `${entries.length} entries`;
            this.render(entries);
        } catch (e) {
            if (this.content) this.content.textContent = `Could not read logs: ${e}`;
        }
    }

    private render(entries: LogEntry[]): void {
        if (!this.content) return;
        if (entries.length === 0) {
            this.content.textContent = '(no entries yet)';
            return;
        }
        this.content.innerHTML = entries.map((entry) => {
            const ts = new Date(entry.ts_ms).toISOString().slice(11, 23); // HH:MM:SS.mmm
            const cls = classForLevel(entry.level);
            return `<span class="${cls}">${ts} ${entry.level.padEnd(5)} ${escapeHtml(entry.target)} - ${escapeHtml(entry.message)}</span>`;
        }).join('\n');
        // Scroll to bottom (most recent).
        this.content.scrollTop = this.content.scrollHeight;
    }

    private async clear(): Promise<void> {
        if (!isTauri) return;
        try {
            await invoke<void>('clear_logs');
            await this.refresh();
        } catch (e) {
            console.warn('[logs] clear failed:', e);
        }
    }

    private async copyDump(): Promise<void> {
        if (!isTauri) return;
        const original = this.copyBtn?.textContent ?? 'Copy Diagnostic Dump';
        try {
            const dump = await invoke<string>('diagnostic_dump');
            await navigator.clipboard.writeText(dump);
            if (this.copyBtn) {
                this.copyBtn.textContent = 'Copied!';
                this.copyBtn.disabled = true;
                setTimeout(() => {
                    if (this.copyBtn) {
                        this.copyBtn.textContent = original;
                        this.copyBtn.disabled = false;
                    }
                }, 1200);
            }
        } catch (e) {
            console.warn('[logs] copy dump failed:', e);
        }
    }
}

function classForLevel(level: string): string {
    const upper = level.toUpperCase();
    if (upper === 'ERROR') return 'log-error';
    if (upper === 'WARN') return 'log-warn';
    if (upper === 'DEBUG' || upper === 'TRACE') return 'log-debug';
    return '';
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const api = (window as any).__TAURI__?.core;
    if (!api) throw new Error('Tauri not available');
    return api.invoke(cmd, args);
}

export const logsModal = new LogsModal();
(window as any).logsModal = logsModal;
