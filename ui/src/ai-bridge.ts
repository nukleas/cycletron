/**
 * AI Bridge — connects the Tauri backend (Claude API, corpus) to the WASM REPL.
 *
 * When the AI generates a pattern, this module:
 * 1. Primes the existing audio lifecycle during the user's chat submit gesture
 * 2. Reuses the REPL's own code-replacement + evaluate path for playback
 *
 * The WASM REPL handles all audio — the Tauri backend never touches audio.
 */

import {escapeHtml} from './html.js';
import {notify} from './notifications.js';
import {addTask, removeTask} from './dock-badge.js';

const isTauri = !!(window as any).__TAURI__;

// --- Minimal Markdown Renderer ---

function renderMarkdown(text: string): string {
    let html = escapeHtml(text);

    // Fenced code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g,
        (_m, _lang, code) => `<pre class="ai-code-block"><code>${code.trim()}</code></pre>`);

    // Inline code: `code`
    html = html.replace(/`([^`\n]+)`/g, '<code class="ai-inline-code">$1</code>');

    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic: *text*
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

    // Bullet lists: lines starting with - or *
    html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Numbered lists: lines starting with 1. 2. etc
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs: double newlines
    html = html.replace(/\n\n+/g, '</p><p>');
    html = `<p>${html}</p>`;

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Single newlines → <br> (but not inside pre/code)
    html = html.replace(/<\/p><p>/g, '</p>\n<p>');

    return html;
}

// --- Main Init ---

async function initAiBridge() {
    if (!isTauri) {
        console.log('[ai-bridge] Not running in Tauri — AI features disabled');
        document.getElementById('aiPanel')?.classList.add('collapsed');
        return;
    }

    const { invoke } = (window as any).__TAURI__.core;
    const { listen } = (window as any).__TAURI__.event;

    const messagesEl = document.getElementById('aiMessages')!;
    const form = document.getElementById('aiForm') as HTMLFormElement;
    const input = document.getElementById('aiInput') as HTMLInputElement;
    const toggleBtn = document.getElementById('aiToggle')!;
    const clearBtn = document.getElementById('aiClear')!;
    const panel = document.getElementById('aiPanel')!;
    const quickPromptsEl = document.getElementById('aiQuickPrompts')!;

    let streamingEl: HTMLDivElement | null = null;
    let streamingText = '';
    let isProcessing = false;

    // --- Helpers ---

    function addMessage(role: 'user' | 'assistant' | 'system', content: string): HTMLDivElement {
        const div = document.createElement('div');
        div.className = `ai-msg ai-msg-${role}`;

        if (role === 'assistant') {
            div.innerHTML = renderMarkdown(content);
        } else {
            div.textContent = content;
        }

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    function getApp(): any {
        return (window as any).strudelApp;
    }

    function setProcessing(busy: boolean) {
        isProcessing = busy;
        input.disabled = busy;
        form.querySelector('button')!.disabled = busy;
        if (busy) {
            input.placeholder = 'Thinking...';
        } else {
            input.placeholder = 'Describe the music you want...';
        }
    }

    // --- Submit message (shared by form + quick prompts) ---

    async function submitMessage(text: string) {
        if (!text || isProcessing) return;

        addMessage('user', text);
        input.value = '';
        setProcessing(true);

        streamingText = '';
        streamingEl = addMessage('assistant', '');
        streamingEl.innerHTML = '<span class="ai-loading">Thinking</span>';

        try {
            const app = getApp();
            if (app && !app.isInitialized && typeof app.ensureAudioInitialized === 'function') {
                try { await app.ensureAudioInitialized(); } catch (_e) { /* ok */ }
            }

            const editorCode = app?.editor?.getCode?.() ?? '';
            const startedAt = performance.now();
            addTask('ai-response');
            const response: string = await invoke('send_message', {
                message: text,
                editorCode: editorCode || null,
            });
            removeTask('ai-response');
            if (streamingEl) {
                streamingEl.innerHTML = renderMarkdown(response || streamingText);
            }
            // If the AI took more than ~6s and the user has switched away,
            // ping them with a system notification so they don't miss it.
            const elapsedMs = performance.now() - startedAt;
            if (elapsedMs > 6000 && !document.hasFocus()) {
                const preview = (response || '').replace(/\s+/g, ' ').slice(0, 120);
                void notify('AI response ready', preview || 'Open Robostrudel to see the result.');
            }
        } catch (err: any) {
            removeTask('ai-response');
            if (streamingEl) {
                streamingEl.textContent = `Error: ${err}`;
                streamingEl.classList.add('ai-msg-error');
            }
        } finally {
            streamingEl = null;
            streamingText = '';
            setProcessing(false);
            input.focus();
        }
    }

    // --- Panel Toggle ---

    toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        toggleBtn.textContent = panel.classList.contains('collapsed') ? '\u25B6' : '\u25C0';
    });

    // --- Clear / New Song ---

    clearBtn.addEventListener('click', async () => {
        try {
            await invoke('clear_session');
        } catch (_e) { /* ok */ }

        // Clear chat UI
        messagesEl.innerHTML = '';
        addMessage('assistant', 'Fresh start! Describe what you want to create.');
    });

    // --- Form Submit ---

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitMessage(input.value.trim());
    });

    // --- Quick Prompt Buttons ---

    quickPromptsEl.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('.ai-quick') as HTMLElement | null;
        if (!btn) return;
        const prompt = btn.dataset.prompt;
        if (prompt) {
            await submitMessage(prompt);
        }
    });

    // --- Streaming Agent Events ---

    await listen('agent-event', (event: any) => {
        const data = event.payload;
        if (!data) return;

        switch (data.type) {
            case 'text_delta':
                streamingText += data.text;
                if (streamingEl) {
                    streamingEl.innerHTML = renderMarkdown(streamingText);
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                }
                break;

            case 'tool_call':
                addMessage('system', `\u{2699} ${data.name}`);
                break;

            case 'tool_result':
                if (data.name === '__set_code_and_play') {
                    void injectCodeAndPlay(data.result);
                } else if (data.name === '__stop_playback') {
                    stopPlayback();
                } else if (data.name === '__set_tempo') {
                    setTempo(parseFloat(data.result));
                }
                break;
        }
    });

    // --- Bridge: Inject code into WASM REPL ---

    async function injectCodeAndPlay(code: string) {
        const app = getApp();
        if (!app) {
            addMessage('system', 'WASM REPL not ready yet \u2014 press Play first');
            return;
        }

        try {
            if (!app.isInitialized) {
                if (app.editor) app.editor.setCode(code);
                addMessage('system', '\u{270F} Code ready \u2014 press Play (Ctrl+Enter)');
                return;
            }

            if (typeof app.replaceCodeAndPlay === 'function') {
                await app.replaceCodeAndPlay(code);
            } else {
                if (app.editor) app.editor.setCode(code);
                await app.evaluate?.(code);
            }

            if (app.playbackState === 1) {
                addMessage('system', '\u{25B6} Pattern updated');
            } else {
                addMessage('system', '\u{270F} Code ready \u2014 press Play (Ctrl+Enter)');
            }
        } catch (e: any) {
            console.error('[ai-bridge] injectCodeAndPlay error:', e);
            addMessage('system', `Error: ${e.message || e}`);
        }
    }

    function stopPlayback() {
        const app = getApp();
        if (!app) return;
        try { app.stop?.(); } catch (_e) { /* ok */ }
    }

    function setTempo(bpm: number) {
        const app = getApp();
        if (!app) return;
        try {
            const slider = document.getElementById('bpmSlider') as HTMLInputElement;
            const value = document.getElementById('bpmValue') as HTMLInputElement;
            if (slider) slider.value = String(Math.round(bpm));
            if (value) value.value = String(Math.round(bpm));
            app.applyBpm?.(bpm);
        } catch (_e) { /* ok */ }
    }

    // --- Welcome ---
    // Skip the welcome when boot.ts is about to replay a restored session;
    // signaled by the `session:restored` event before ai-bridge has finished.
    let suppressWelcome = false;
    document.addEventListener('session:restored', () => {
        suppressWelcome = true;
        // Also scrub any welcome that slipped in before this event fired.
        const first = messagesEl.firstElementChild;
        if (first && first.textContent?.startsWith('Welcome to Robostrudel')) {
            first.remove();
        }
    });

    // Delay the welcome briefly so restore has a chance to run first.
    setTimeout(() => {
        if (suppressWelcome || messagesEl.children.length > 0) return;
        addMessage('assistant',
            '**Welcome to Robostrudel!**\n\n' +
            'Describe the music you want, or use the quick buttons below.\n\n' +
            'Press **Play** first to arm audio, then I can update patterns live.'
        );
    }, 150);
}

document.addEventListener('DOMContentLoaded', initAiBridge);
