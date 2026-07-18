/**
 * Headless JS/Strudel syntax highlighting for chat code blocks.
 *
 * Reuses the same @lezer/javascript parser + @lezer/highlight tagging the
 * CodeMirror editor uses (see theme.ts), run against a plain string with no
 * EditorView/DOM involved, so chat code blocks get the same token colors as
 * the main editor without pulling in a separate highlighting library.
 */
import {parser} from '@lezer/javascript';
import {highlightCode, tagHighlighter} from '@lezer/highlight';
import {escapeHtml} from './html.js';
import {syntaxTagMap} from './syntax-palette.js';

const highlighter = tagHighlighter(
    syntaxTagMap.map(({tag, key}) => ({tag, class: `ai-tok-${key}`}))
);

const HIGHLIGHTABLE_LANGS = new Set(['', 'js', 'javascript', 'jsx', 'ts', 'typescript']);

export function isHighlightableLang(lang: string | undefined | null): boolean {
    return HIGHLIGHTABLE_LANGS.has((lang || '').trim().toLowerCase());
}

export function highlightJsToHtml(code: string): string {
    try {
        const tree = parser.parse(code);
        const parts: string[] = [];
        highlightCode(
            code,
            tree,
            highlighter,
            (text, classes) => {
                parts.push(classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text));
            },
            () => { parts.push('\n'); }
        );
        return parts.join('');
    } catch (_e) {
        return escapeHtml(code);
    }
}
