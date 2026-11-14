/** Hover tooltip styling shared by the code editor and the show pane. */
import {EditorView} from '@codemirror/view';

export const hoverTheme = EditorView.baseTheme({
    '.cm-strudel-hover': {
        padding: '5px 8px',
        maxWidth: '340px',
        font: '12px/1.5 var(--font-mono, monospace)',
    },
    '.cm-strudel-hover-sig': {
        color: 'var(--accent, #ff2bd6)',
        fontWeight: '600',
    },
    '.cm-strudel-hover-info': {
        marginTop: '2px',
        color: 'var(--text-secondary, #aaa)',
        whiteSpace: 'normal',
    },
});
