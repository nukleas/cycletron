// The repo's own docs, rendered as they are written. Headings get ids for
// anchors; links between docs point at the site's pages where the site has
// one, and at GitHub (at the release tag) where it doesn't.

import {Marked} from 'marked';
import {REPO_URL} from './content.mjs';

/** Docs the site renders, by file name in docs/. */
export const SITE_DOCS = {
    'USER_GUIDE.md': '/guide',
    'SHOW_FILES.md': '/guide/shows',
    'DIALECT.md': '/guide/dialect',
};

export function slugify(text) {
    return text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z]+;/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param {string} tag  release tag, for links into the repo
 * @param {{anchors?: boolean, headingShift?: number}} options
 *   anchors: give headings ids (off where the same heading repeats, as in the changelog)
 *   headingShift: render `##` as `h(2 + shift)`
 */
export function renderMarkdown(source, tag, {anchors = true, headingShift = 0} = {}) {
    const marked = new Marked({gfm: true});
    marked.use({
        renderer: {
            heading({tokens, depth}) {
                const text = this.parser.parseInline(tokens);
                const level = Math.min(6, depth + headingShift);
                if (!anchors) return `<h${level}>${text}</h${level}>\n`;
                const id = slugify(text);
                return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${level}>\n`;
            },
            link({href, title, tokens}) {
                const text = this.parser.parseInline(tokens);
                const t = title ? ` title="${escapeHtml(title)}"` : '';
                if (/^(https?:|mailto:)/.test(href)) {
                    return `<a href="${escapeHtml(href)}"${t} rel="noopener">${text}</a>`;
                }
                if (href.startsWith('#')) return `<a href="${escapeHtml(href)}"${t}>${text}</a>`;
                const [path, hash = ''] = href.replace(/^\.\//, '').split('#');
                const local = SITE_DOCS[path];
                const target = local
                    ? local + (hash ? `#${hash}` : '')
                    : `${REPO_URL}/blob/${tag}/docs/${path}${hash ? `#${hash}` : ''}`;
                return `<a href="${escapeHtml(target)}"${t}>${text}</a>`;
            },
            image({href, title, text}) {
                const src = /^https?:/.test(href)
                    ? href
                    : `https://raw.githubusercontent.com/${REPO_URL.split('github.com/')[1]}/${tag}/docs/${href.replace(/^\.\//, '')}`;
                return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
            },
        },
    });
    return marked.parse(source);
}

/** `## ` headings of a markdown file, for a page's table of contents. */
export function outline(source) {
    return [...source.matchAll(/^## (.+)$/gm)].map((m) => ({
        title: m[1].replace(/`/g, ''),
        id: slugify(new Marked().parseInline(m[1])),
    }));
}
