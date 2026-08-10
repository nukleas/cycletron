/**
 * AI Bridge — connects the Tauri backend (Claude API, corpus) to the WASM REPL.
 *
 * When the AI generates a pattern, this module:
 * 1. Primes the existing audio lifecycle during the user's chat submit gesture
 * 2. Reuses the REPL's own code-replacement + evaluate path for playback
 *
 * The WASM REPL handles all audio — the Tauri backend never touches audio.
 */

import {notify} from './notifications.js';
import {addTask, removeTask} from './dock-badge.js';
import {renderMarkdownToHtml, enhanceCodeBlocks} from './markdown.js';
import {openExternal} from './external-link.js';
import {aiConsent} from './ai-consent.js';
import {invoke as ipc, isTauri} from './tauri.js';
import type {UserSettings} from './types/tauri-commands.js';


// The chat UI + agent-event stream are wired at most once, and only after the
// user consents. Toggling AI back off later leaves the (harmless, Rust-gated)
// listeners in place and simply hides the chat behind the Enable CTA.
let chatWired = false;

// --- Main Init ---

async function initAiBridge() {
    const panel = document.getElementById('aiPanel');
    // Start collapsed on every launch — the AI panel is opt-in surface, opened
    // via the arrow, the View menu (Cmd+Shift+A), or the Command Palette.
    panel?.classList.add('collapsed');
    // Collapsing is a pure layout control — wire it up front so it works whether
    // or not AI is enabled (the chat itself stays consent-gated).
    wirePanelToggle();
    if (!isTauri) {
        console.log('[ai-bridge] Not running in Tauri — AI features disabled');
        return;
    }
    aiConsent.init();
    document.getElementById('aiEnable')?.addEventListener('click', () => aiConsent.open());
    document.addEventListener('ai-consent:changed', () => void applyConsent());
    await applyConsent();
}

/** Read consent and reflect it: show the Enable CTA, or wire the chat once. */
async function applyConsent() {
    const panel = document.getElementById('aiPanel');
    if (!panel) return;
    let consent = false;
    try {
        const s = await ipc<UserSettings>('get_user_settings');
        consent = !!s.ai_consent;
    } catch {
        /* default off */
    }
    panel.classList.toggle('ai-off', !consent);
    if (consent && !chatWired) {
        chatWired = true;
        await wireAiChat();
    }
}

/** Wire the collapse/expand arrow. Independent of AI consent: hiding the panel
 *  must work even when AI is off. Re-open a collapsed panel via the View menu
 *  (Cmd+Shift+A) or the Command Palette ("Toggle AI Panel"). */
function wirePanelToggle(): void {
    const panel = document.getElementById('aiPanel');
    const toggleBtn = document.getElementById('aiToggle');
    if (!panel || !toggleBtn) return;
    // A collapsed panel is `display:none`, so the arrow is only ever visible
    // while expanded (where it means "collapse") — no glyph swap needed.
    toggleBtn.addEventListener('click', () => panel.classList.toggle('collapsed'));
}

/** Wire the chat form, quick prompts, and agent-event stream. Runs once. */
async function wireAiChat() {
    const tauri = window.__TAURI__;
    if (!tauri) return;
    const { invoke } = tauri.core;
    const { listen } = tauri.event;

    const messagesEl = document.getElementById('aiMessages')!;
    const form = document.getElementById('aiForm') as HTMLFormElement;
    const input = document.getElementById('aiInput') as HTMLInputElement;
    const clearBtn = document.getElementById('aiClear')!;
    const quickPromptsEl = document.getElementById('aiQuickPrompts')!;

    let streamingEl: HTMLDivElement | null = null;
    let streamingText = '';
    let isProcessing = false;

    // --- Helpers ---

    function addMessage(role: 'user' | 'assistant' | 'system', content: string): HTMLDivElement {
        const div = document.createElement('div');
        div.className = `ai-msg ai-msg-${role}`;

        if (role === 'assistant') {
            div.innerHTML = renderMarkdownToHtml(content);
            enhanceCodeBlocks(div);
        } else {
            div.textContent = content;
        }

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    function getApp(): any {
        return window.strudelApp;
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
                streamingEl.innerHTML = renderMarkdownToHtml(response || streamingText);
                enhanceCodeBlocks(streamingEl);
            }
            // If the AI took more than ~6s and the user has switched away,
            // ping them with a system notification so they don't miss it.
            const elapsedMs = performance.now() - startedAt;
            if (elapsedMs > 6000 && !document.hasFocus()) {
                const preview = (response || '').replace(/\s+/g, ' ').slice(0, 120);
                void notify('AI response ready', preview || 'Open Cycletron to see the result.');
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

    // --- Markdown Links (open externally) ---

    messagesEl.addEventListener('click', (e) => {
        const link = (e.target as HTMLElement).closest('.ai-msg-assistant a') as HTMLAnchorElement | null;
        if (!link) return;
        e.preventDefault();
        void openExternal(link.href);
    });

    // --- Streaming Agent Events ---

    await listen('agent-event', (event: any) => {
        const data = event.payload;
        if (!data) return;

        switch (data.type) {
            case 'text_delta':
                streamingText += data.text;
                if (streamingEl) {
                    streamingEl.innerHTML = renderMarkdownToHtml(streamingText);
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
                } else if (data.name === '__library_changed') {
                    // Agent wrote to the library — refresh the file tree + toast.
                    try {
                        window.__TAURI__?.event?.emit?.('library-changed', data.result);
                    } catch { /* non-tauri */ }
                    void notify('Library updated', data.result);
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
        if (first && first.textContent?.startsWith('Welcome to Cycletron')) {
            first.remove();
        }
    });

    // Delay the welcome briefly so restore has a chance to run first.
    setTimeout(() => {
        if (suppressWelcome || messagesEl.children.length > 0) return;
        addMessage('assistant',
            '**Welcome to Cycletron!**\n\n' +
            '1. Press **Play** to arm audio\n' +
            '2. Open **Examples → Lesson 1** (or describe a groove here)\n' +
            '3. Edit the code, Play again — I can rewrite the editor from chat\n\n' +
            'Help → **User Guide** / **Dialect** covers shortcuts and strudel-rs footguns.'
        );
    }, 150);
}

document.addEventListener('DOMContentLoaded', initAiBridge);
