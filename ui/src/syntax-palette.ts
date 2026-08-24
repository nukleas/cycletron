/**
 * Shared @lezer/highlight tag -> semantic token key mapping.
 *
 * Mirrors the tag list in theme.ts's strudelHighlight (the CodeMirror editor's
 * syntax colors) so the headless chat code highlighter (code-highlight.ts)
 * produces the same token semantics, just as CSS classes (ai-tok-<key>)
 * instead of CodeMirror's runtime-injected styles.
 */
import {tags} from '@lezer/highlight';
import type {Tag} from '@lezer/highlight';

export interface SyntaxTagEntry {
    tag: Tag;
    key: string;
}

export const syntaxTagMap: SyntaxTagEntry[] = [
    {tag: tags.keyword, key: 'keyword'},
    {tag: tags.string, key: 'string'},
    {tag: tags.number, key: 'number'},
    {tag: tags.bool, key: 'bool'},
    {tag: tags.comment, key: 'comment'},
    {tag: tags.lineComment, key: 'comment'},
    {tag: tags.blockComment, key: 'comment'},
    {tag: tags.function(tags.variableName), key: 'function'},
    {tag: tags.definition(tags.function(tags.variableName)), key: 'function'},
    {tag: tags.variableName, key: 'variable'},
    {tag: tags.definition(tags.variableName), key: 'function'},
    {tag: tags.propertyName, key: 'property'},
    {tag: tags.operator, key: 'operator'},
    {tag: tags.punctuation, key: 'variable'},
    {tag: tags.bracket, key: 'bracket'},
    {tag: tags.squareBracket, key: 'squareBracket'},
    {tag: tags.paren, key: 'paren'},
    {tag: tags.brace, key: 'brace'},
    {tag: tags.typeName, key: 'type'},
    {tag: tags.className, key: 'type'},
    {tag: tags.regexp, key: 'regexp'},
    {tag: tags.escape, key: 'escape'},
    {tag: tags.invalid, key: 'invalid'},
    {tag: tags.null, key: 'null'},
];

/** Token key used for text no highlighter rule claimed. */
export const DEFAULT_TOKEN_KEY = 'variable';

/**
 * Resolve each token key to a concrete CSS color string.
 *
 * Canvas cannot resolve `var(--magenta)` — assigning one to `fillStyle` fails
 * silently and paints black — so a canvas renderer needs real values. Rather
 * than keep a third copy of the palette (theme.ts has one, the `.ai-tok-*`
 * rules in style.css have another), probe the live stylesheet through those
 * same classes. That way the stage tracks theme changes for free and can never
 * drift from the editor.
 *
 * Costs one layout pass over ~18 throwaway spans; call it from `layout()`,
 * not per frame.
 */
export function resolveSyntaxColors(): Record<string, string> {
    const keys = [...new Set(syntaxTagMap.map((entry) => entry.key))];
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute; visibility:hidden; pointer-events:none;';

    const spans = keys.map((key) => {
        const span = document.createElement('span');
        span.className = `ai-tok-${key}`;
        probe.appendChild(span);
        return span;
    });

    document.body.appendChild(probe);
    const colors: Record<string, string> = {};
    keys.forEach((key, i) => {
        colors[key] = getComputedStyle(spans[i]).color;
    });
    probe.remove();

    return colors;
}
