/**
 * Custom Strudel Dark Theme for CodeMirror 6
 */
import {EditorView} from '@codemirror/view';
import {HighlightStyle, syntaxHighlighting} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import type {Extension} from '@codemirror/state';

// Neo-retro cyberpunk palette shared with style.css.
const colors = {
    bg: 'var(--bg)',
    bgLight: 'var(--bg-light)',
    bgLighter: 'var(--bg-lighter)',
    border: 'var(--border)',
    text: 'var(--text)',
    textMuted: 'var(--text-muted)',
    accent: 'var(--neon)',           // electric cyan
    greenBright: '#52ff9f',
    purple: '#9d7cff',
    pink: '#ff4fd8',
    red: '#ff456c',
    orange: '#ffb000',
    yellow: '#f7ff5a',
    cyan: '#47f6ff',
    magenta: '#ff2bd6',
    selection: 'var(--selection)',
    accentSubtle: 'var(--accent-subtle)'
} as const;

// Editor chrome styling
export const strudelTheme = EditorView.theme({
    '&': {
        color: colors.text,
        backgroundColor: colors.bg,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
        height: '100%',
        textShadow: '0 0 3px rgba(71, 246, 255, 0.14)',
    },
    '.cm-content': {
        caretColor: colors.accent,
        padding: '12px 0',
        lineHeight: '1.6',
    },
    '&.cm-focused .cm-cursor': {
        borderLeftColor: colors.accent,
        borderLeftWidth: '2px',
        boxShadow: `0 0 4px ${colors.accent}`,
    },
    '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: colors.selection,
    },
    '.cm-selectionBackground': {
        backgroundColor: colors.selection,
    },
    '.cm-gutters': {
        backgroundColor: colors.bgLight,
        color: colors.textMuted,
        border: 'none',
        borderRight: `1px solid ${colors.border}`,
        paddingRight: '8px',
        boxShadow: 'inset -2px 0 0 rgba(71, 246, 255, 0.05)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 16px',
        minWidth: '40px',
    },
    '.cm-activeLineGutter': {
        backgroundColor: colors.bgLighter,
        color: colors.text,
    },
    '.cm-activeLine': {
        backgroundColor: colors.accentSubtle,
    },
    '.cm-foldPlaceholder': {
        backgroundColor: colors.bgLighter,
        color: colors.textMuted,
        border: `1px solid ${colors.border}`,
        borderRadius: '0',
        padding: '0 6px',
    },
    '.cm-matchingBracket': {
        backgroundColor: 'rgba(125, 249, 255, 0.18)',
        outline: `1px solid ${colors.accent}`,
    },
    '.cm-tooltip': {
        backgroundColor: colors.bgLight,
        border: `1px solid ${colors.border}`,
        borderRadius: '2px',
    },
    '.cm-tooltip-autocomplete': {
        '& > ul > li': {
            padding: '4px 8px',
        },
        '& > ul > li[aria-selected]': {
            backgroundColor: colors.bgLighter,
        },
    },
    '.cm-panels': {
        backgroundColor: colors.bgLight,
        borderTop: `1px solid ${colors.border}`,
    },
    '.cm-panel.cm-search': {
        padding: '8px',
    },
    '.cm-searchMatch': {
        backgroundColor: 'rgba(255, 45, 212, 0.30)',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 45, 212, 0.50)',
    },
    // Scrollbar styling
    '&::-webkit-scrollbar': {
        width: '10px',
        height: '10px',
    },
    '&::-webkit-scrollbar-track': {
        backgroundColor: colors.bg,
    },
    '&::-webkit-scrollbar-thumb': {
        backgroundColor: colors.bgLighter,
        borderRadius: '5px',
    },
    '&::-webkit-scrollbar-thumb:hover': {
        backgroundColor: colors.border,
    },
}, {dark: true});

// Syntax highlighting: hot operators, phosphor strings, cyan function calls.
export const strudelHighlight = HighlightStyle.define([
    // Keywords (note, s, sound, etc.) — hot magenta
    {tag: tags.keyword, color: colors.magenta, fontWeight: 'bold'},

    // Strings (patterns, sounds) — aurora mint
    {tag: tags.string, color: colors.greenBright},

    // Numbers (frequencies, gains, etc.) — yellow readouts
    {tag: tags.number, color: colors.yellow},

    // Booleans
    {tag: tags.bool, color: colors.purple},

    // Comments — muted
    {tag: tags.comment, color: colors.textMuted, fontStyle: 'italic'},
    {tag: tags.lineComment, color: colors.textMuted, fontStyle: 'italic'},
    {tag: tags.blockComment, color: colors.textMuted, fontStyle: 'italic'},

    // Functions — electric cyan
    {tag: tags.function(tags.variableName), color: colors.cyan},
    {tag: tags.definition(tags.function(tags.variableName)), color: colors.cyan},

    // Variables
    {tag: tags.variableName, color: colors.text},
    {tag: tags.definition(tags.variableName), color: colors.cyan},

    // Method calls like .s(), .gain() — bubblegum pink
    {tag: tags.propertyName, color: colors.pink},

    // Operators
    {tag: tags.operator, color: colors.magenta},
    {tag: tags.punctuation, color: colors.text},

    // Brackets — cool gradient
    {tag: tags.bracket, color: colors.text},
    {tag: tags.squareBracket, color: colors.cyan},
    {tag: tags.paren, color: colors.text},
    {tag: tags.brace, color: colors.magenta},

    // Types — italic cyan
    {tag: tags.typeName, color: colors.cyan, fontStyle: 'italic'},
    {tag: tags.className, color: colors.cyan, fontStyle: 'italic'},

    // Special
    {tag: tags.regexp, color: colors.pink},
    {tag: tags.escape, color: colors.red},
    {tag: tags.invalid, color: colors.red, textDecoration: 'underline wavy'},
    {tag: tags.null, color: colors.purple},
]);

export const strudelThemeExtension: Extension[] = [
    strudelTheme,
    syntaxHighlighting(strudelHighlight),
];
