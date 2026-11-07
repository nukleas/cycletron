// The page shell every page shares: head, header, nav, footer.

import {REPO_URL} from './content.mjs';

export const SITE_URL = 'https://cycletron.naderlabs.io';

export const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NAV = [
    {href: '/download', label: 'Download'},
    {href: '/play', label: 'Play'},
    {href: '/examples', label: 'Examples'},
    {href: '/packs', label: 'Packs'},
    {href: '/guide', label: 'Guide'},
    {href: '/changelog', label: 'Changelog'},
    {href: '/demos', label: 'Demos'},
];

const dateFormat = new Intl.DateTimeFormat('en-US', {year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
export const formatDate = (iso) => dateFormat.format(new Date(iso));

export const formatSize = (bytes) => `${Math.round(bytes / 1e6)} MB`;

/**
 * @param {object} page
 * @param {string} page.path        the page's URL path, for the canonical link and the current nav item
 * @param {string} page.title       <title>; the site name is appended except on the home page
 * @param {string} page.description meta description
 * @param {string} page.body        the page's HTML
 * @param {object} page.release
 * @param {string[]} [page.scripts] module scripts to load
 */
export function layout({path, title, description, body, release, scripts = []}) {
    const fullTitle = path === '/' ? title : `${title} · Cycletron`;
    const nav = NAV.map(({href, label}) => {
        const current = path === href || path.startsWith(`${href}/`);
        return `<a href="${href}"${current ? ' aria-current="page"' : ''}>${label}</a>`;
    }).join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE_URL}${path}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE_URL}${path}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE_URL}/media/stage-neon-circuit.png">
<meta name="theme-color" content="#05060a">
<link rel="icon" href="/icon.png">
<link rel="stylesheet" href="/style.css">
${scripts.map((s) => `<script type="module" src="${s}"></script>`).join('\n')}
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">Cycletron</a>
  <nav class="site-nav" aria-label="Site">${nav}</nav>
  <a class="site-version" href="/changelog#${release.tag}" title="Released ${formatDate(release.date)}">${esc(release.version)}</a>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <p>
    Cycletron is free software under the <a href="${REPO_URL}/blob/${release.tag}/LICENSE">AGPL-3.0-or-later</a>.
    <a href="${REPO_URL}">Source on GitHub</a>.
    A <a href="https://www.naderlabs.io/">NaderLabs</a> project.
  </p>
  <p>Patterns run on <a href="https://codeberg.org/nukleas/strudel-rs">strudel-rs</a>. Cycletron is not affiliated with Strudel or strudel.cc.</p>
</footer>
</body>
</html>
`;
}
