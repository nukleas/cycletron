/**
 * Cyberpunk-themed markdown rendering for AI chat messages.
 *
 * Split into two passes so streaming stays cheap:
 * - renderMarkdownToHtml() is the plain CommonMark parse, safe to call on
 *   every streamed chunk (including incomplete/partial markdown).
 * - enhanceCodeBlocks() is a DOM post-pass (syntax highlighting + copy
 *   button) that should only run once, on settled/final content.
 */
import {Marked} from 'marked';
import {escapeHtml} from './html.js';
import {highlightJsToHtml, isHighlightableLang} from './code-highlight.js';

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function sanitizeHref(href: string): string | null {
    try {
        const url = new URL(href, window.location.href);
        return ALLOWED_LINK_PROTOCOLS.has(url.protocol) ? href : null;
    } catch {
        return null;
    }
}

const md = new Marked({
    renderer: {
        // Marked renders raw HTML found in the source verbatim by default —
        // assistant text is LLM output, not fully trusted, so escape it.
        html({text}) {
            return escapeHtml(text);
        },
        link({href, title, tokens}) {
            const label = this.parser.parseInline(tokens);
            const safeHref = sanitizeHref(href);
            if (!safeHref) return label;
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
            return `<a href="${escapeHtml(safeHref)}"${titleAttr} rel="noopener">${label}</a>`;
        },
        codespan({text}) {
            return `<code class="ai-inline-code">${escapeHtml(text)}</code>`;
        },
        code({text, lang}) {
            const language = (lang || '').trim();
            return `<pre class="ai-code-block" data-lang="${escapeHtml(language)}"><code>${escapeHtml(text)}</code></pre>`;
        },
    },
});

export function renderMarkdownToHtml(text: string): string {
    try {
        return md.parse(text, {async: false});
    } catch (_e) {
        return `<p>${escapeHtml(text)}</p>`;
    }
}

export function enhanceCodeBlocks(container: HTMLElement): void {
    container.querySelectorAll<HTMLPreElement>('pre.ai-code-block').forEach((pre) => {
        const codeEl = pre.querySelector('code');
        if (!codeEl) return;
        if (isHighlightableLang(pre.dataset.lang)) {
            codeEl.innerHTML = highlightJsToHtml(codeEl.textContent ?? '');
        }
        attachCopyButton(pre, codeEl);
    });
}

function attachCopyButton(pre: HTMLElement, codeEl: HTMLElement): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-code-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(codeEl.textContent ?? '');
            flashCopyBtn(btn, 'Copied!');
        } catch {
            flashCopyBtn(btn, 'Failed');
        }
    });
    pre.appendChild(btn);
}

function flashCopyBtn(btn: HTMLButtonElement, label: string): void {
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add('ai-code-copy-btn--flash');
    setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('ai-code-copy-btn--flash');
    }, 1500);
}
