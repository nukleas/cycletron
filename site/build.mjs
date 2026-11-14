#!/usr/bin/env node
/**
 * Build cycletron.naderlabs.io into site/dist from this repo and the GitHub
 * release it describes (SITE_TAG, or the latest published release).
 * Plan and rules: docs/CYCLETRON_SITE_PLAN.md.
 *
 *   npm run build        build into dist/
 *   npm run dev          build, then serve dist/ with the production headers
 */

import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {REPO_URL, ROOT, installers, loadChangelog, loadRelease, read, section} from './lib/content.mjs';
import {SITE_URL, esc, formatDate, formatSize, layout} from './lib/layout.mjs';
import {CHANNEL_URL, demos, playlists} from './lib/demos.mjs';
import {loadPacks, showTitle, songMeta, writeLibrary} from './lib/library.mjs';
import {SECTION_INTROS, SITE_SECTIONS, loadExamples, onSite} from './lib/examples.mjs';
import {outline, renderMarkdown} from './lib/markdown.mjs';

const DIST = join(import.meta.dirname, 'dist');
const release = await loadRelease();
const changelog = loadChangelog(release);

rmSync(DIST, {recursive: true, force: true});
mkdirSync(DIST, {recursive: true});

/** Every page's path, for the sitemap. */
const pages = [];

/** Write a page; `/guide/shows` → dist/guide/shows.html (served without .html). */
function emit(path, html) {
    if (path !== '/404') pages.push(path);
    const file = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
    mkdirSync(dirname(join(DIST, file)), {recursive: true});
    writeFileSync(join(DIST, file), html);
}

const page = (opts) => emit(opts.path, layout({release, ...opts}));

// ---- shared pieces --------------------------------------------------------

const DEMO = {id: '1m3TWwgyf8Y', title: 'Cycletron: Desktop Strudel-RS Demo'};

/**
 * A YouTube video that loads only when clicked (site.js swaps in the player);
 * with `list`, the player goes on through that playlist.
 */
const youtube = ({id, title, poster, list}) => `
<button type="button" class="yt" data-yt="${id}"${list ? ` data-yt-list="${list}"` : ''} aria-label="Play ${esc(title)}">
  <img src="${poster ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`}" alt="" loading="lazy">
  <span class="yt__play" aria-hidden="true"></span>
</button>`;

function downloadButtons() {
    const list = installers(release);
    return `
<div class="downloads" data-downloads>
  <p class="downloads__phone">Cycletron is a desktop app for macOS, Linux and Windows.</p>
  <ul class="downloads__list">
    ${list.map((i) => `<li><a class="button" data-os="${i.os}" href="${i.asset.url}">${i.platform} <span>${i.label}</span></a></li>`).join('\n    ')}
  </ul>
  <p class="downloads__meta">
    Version ${esc(release.version)}, released ${formatDate(release.date)}.
    <a href="/changelog#${release.tag}">What changed</a> · <a href="/download">All downloads and requirements</a>
  </p>
</div>`;
}

/** What search engines read as the app: on the home and download pages. */
const appData = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Cycletron',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'macOS, Windows, Linux',
    softwareVersion: release.version,
    url: `${SITE_URL}/`,
    downloadUrl: `${SITE_URL}/download`,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    offers: {'@type': 'Offer', price: '0', priceCurrency: 'USD'},
    publisher: {'@type': 'Organization', name: 'NaderLabs', url: 'https://www.naderlabs.io/'},
})}</script>`;

/** A meta description: about the length a search result shows, cut at a word. */
function summary(text, max = 155) {
    if (text.length <= max) return text;
    return `${text.slice(0, text.lastIndexOf(' ', max - 1))}…`;
}

const STAGE_SHOTS = [
    {file: 'stage-neon-circuit.png', caption: 'Stage mode with the Neon Circuit visualizer.'},
    {file: 'stage-forest-drive.png', caption: 'Forest Drive: each note is a tree on the verge, and it reaches the windshield on the beat.'},
    {file: 'stage-cockpit.png', caption: 'Cockpit: each note is a target, hit on its onset. The panel under the view shows each track\'s activity, the transport, the audio bands and the cycle.'},
];

// ---- / --------------------------------------------------------------------

page({
    path: '/',
    title: 'Cycletron — live coding music on a Rust engine',
    description:
        'A desktop app for live coding music on macOS, Linux and Windows: Strudel-style patterns on the strudel-rs engine, with visualizers that follow the pattern.',
    head: appData,
    scripts: ['/site.js'],
    body: `
<section class="hero">
  <h1 class="hero__title" data-text="Cycletron">Cycle<span class="hero__tron">tron</span></h1>
  <p class="hero__lede">
    A desktop app for live coding music, on macOS, Linux and Windows.
    Write Strudel-style patterns and press Cmd+Enter (Ctrl+Enter on Windows
    and Linux) to play them. While a pattern plays, each edit is applied as
    you type, with no compile step.
  </p>
  ${downloadButtons()}
</section>

<section class="demo">
  ${youtube(DEMO)}
  <p class="caption">
    The demo from the first public release. Patterns run on strudel-rs, a
    Rust engine compiled to WebAssembly; Cycletron is not affiliated with the
    Strudel project. <a href="/demos">More recordings</a>
  </p>
</section>

<section class="band">
  <h2>Visualizers that follow the pattern</h2>
  <p>
    Most fullscreen modes draw each scheduled note, so they show which voices
    are playing; a few draw from the audio signal. A show file sets the mode,
    camera, cuts and text for each section of a song, behind the editor or
    full-frame in Stage. <a href="/guide/shows">How show files work</a>
  </p>
  <div class="shots">
    ${STAGE_SHOTS.map((s) => `
    <figure>
      <img src="/media/${s.file}" alt="${esc(s.caption)}" loading="lazy">
      <figcaption>${esc(s.caption)}</figcaption>
    </figure>`).join('')}
  </div>
</section>

<section class="links">
  <a class="link-card" href="/examples#featured">
    <h2>Examples</h2>
    <p>Shows and songs that play in your browser, with their code.</p>
  </a>
  <a class="link-card" href="/guide">
    <h2>Guide</h2>
    <p>The editor, transport, samples, MIDI, Ableton Link, OSC, the visualizer and Stage.</p>
  </a>
  <a class="link-card" href="/changelog">
    <h2>Changelog</h2>
    <p>What changed in every release.</p>
  </a>
</section>`,
});

// ---- /download ------------------------------------------------------------

const readme = read('README.md');
const guide = read('docs/USER_GUIDE.md');

page({
    path: '/download',
    title: 'Download',
    description: `Cycletron ${release.version} for macOS, Windows and Linux, with requirements, updates and privacy.`,
    head: appData,
    scripts: ['/site.js'],
    body: `
<h1>Download</h1>
<p class="lede">
  Version ${esc(release.version)}, released ${formatDate(release.date)}.
  <a href="/changelog#${release.tag}">What changed</a> ·
  <a href="${release.url}">Release on GitHub</a>
</p>

<table class="installers">
  <thead><tr><th>Platform</th><th>File</th><th>Size</th><th>Notes</th></tr></thead>
  <tbody>
  ${installers(release).map((i) => `
    <tr data-os="${i.os}">
      <td>${i.platform}</td>
      <td><a href="${i.asset.url}">${esc(i.label)}</a></td>
      <td>${formatSize(i.asset.size)}</td>
      <td>${esc(i.note)}</td>
    </tr>`).join('')}
  </tbody>
</table>

<p>
  <strong>Arch Linux:</strong> a PKGBUILD is in the repo under
  <a href="${REPO_URL}/tree/${release.tag}/packaging/aur"><code>packaging/aur</code></a>;
  build it with <code>makepkg -si</code>.
  <strong>From source:</strong> see the <a href="${REPO_URL}#requirements-dev">README</a>.
</p>

<h2 id="updates">Updates</h2>
${renderMarkdown(section(guide, 'Updates').replace(/\n---\s*$/, ''), release.tag)}

<h2 id="privacy">Privacy</h2>
${renderMarkdown(section(readme, 'Privacy'), release.tag)}
<p>This website, not the app, counts page views with Vercel Web Analytics and Speed Insights.</p>

<h2 id="troubleshooting">Troubleshooting</h2>
<p>The guide's <a href="/guide#troubleshooting">Troubleshooting</a> section covers no sound, silent patterns, AI setup and where the logs are.</p>`,
});

// ---- /changelog -----------------------------------------------------------

page({
    path: '/changelog',
    title: 'Changelog',
    description: 'What changed in every published Cycletron release, newest first.',
    body: `
<h1>Changelog</h1>
<p class="lede">Every release, newest first. Each published one links to its GitHub release, which has the installers.</p>
${changelog.map((e) => `
<section class="release" id="v${e.version}">
  <h2><a href="#v${e.version}">${esc(e.version)}</a></h2>
  <p class="release__meta"><time datetime="${e.date}">${formatDate(e.date)}</time>${e.released ? ` · <a href="${REPO_URL}/releases/tag/v${e.version}">release</a>` : ''}</p>
  <div class="prose">${renderMarkdown(e.body, release.tag, {anchors: false, headingShift: 0})}</div>
</section>`).join('')}`,
});

// ---- /guide and the docs it links to -------------------------------------

const GUIDE_PAGES = [
    {path: '/guide', file: 'docs/USER_GUIDE.md', title: 'User guide',
        description: 'The Cycletron user guide: the editor, transport, samples, MIDI, Ableton Link, OSC, the visualizer and Stage Mode.'},
    {path: '/guide/shows', file: 'docs/SHOW_FILES.md', title: 'Show files',
        description: 'How Cycletron show files compose a music video from songs: modes, cameras, cuts, transitions and text.'},
    {path: '/guide/dialect', file: 'docs/DIALECT.md', title: 'Dialect',
        description: 'Where the strudel-rs dialect in Cycletron differs from browser Strudel.'},
];

for (const g of GUIDE_PAGES) {
    const source = read(g.file).replace(/^# .*\n+/, '');
    const toc = outline(source);
    page({
        path: g.path,
        title: g.title,
        description: g.description,
        body: `
<div class="doc">
  <nav class="doc__nav" aria-label="Guide">
    ${GUIDE_PAGES.map((p) => p.path === g.path
        ? `<a href="${p.path}" aria-current="page">${p.title}</a>
    <ol class="doc__toc">${toc.map((h) => `<li><a href="#${h.id}">${esc(h.title)}</a></li>`).join('')}</ol>`
        : `<a href="${p.path}">${p.title}</a>`).join('\n    ')}
  </nav>
  <article class="prose">
    <h1>${g.title}</h1>
    ${renderMarkdown(source, release.tag)}
    <p class="doc__source">From <a href="${REPO_URL}/blob/${release.tag}/${g.file}"><code>${g.file}</code></a>${release.local ? ' in the working tree (local build)' : ` at ${esc(release.tag)}`}.</p>
  </article>
</div>`,
    });
}

// ---- /demos ---------------------------------------------------------------

const playlistUrl = (list) => `https://www.youtube.com/playlist?list=${list}`;
const watchUrl = (id, list) => `https://www.youtube.com/watch?v=${id}&list=${list}`;

page({
    path: '/demos',
    title: 'Demos',
    description: 'Recordings of Cycletron: releases, visualizers, Stage mode and live coding.',
    scripts: ['/site.js'],
    body: `
<h1>Demos</h1>
<p class="lede">Recordings of Cycletron from the <a href="${CHANNEL_URL}">NaderLabs channel</a> on YouTube, newest first.</p>
${playlists.map((l) => `
<section class="playlist" id="${l.pack}-playlist">
  <h2>${esc(l.title)}</h2>
  <p class="video__meta"><time datetime="${l.date}">${formatDate(l.date)}</time> · ${l.videos.length} videos · <a href="${playlistUrl(l.id)}">Playlist on YouTube</a></p>
  <p>${esc(l.about)} <a href="/packs#${l.pack}">The pack</a> plays in your browser.</p>
  ${youtube({...l.videos[0], list: l.id})}
  <ol class="playlist__list">
    ${l.videos.map((v) => `<li><a href="${watchUrl(v.id, l.id)}" title="${esc(v.title)}">${esc(v.name)}</a> <span class="note">${v.duration}</span></li>`).join('\n    ')}
  </ol>
</section>`).join('')}
<div class="videos">
${demos.map((v) => `
  <article class="video">
    ${youtube(v)}
    <h2>${esc(v.title)}</h2>
    <p class="video__meta"><time datetime="${v.date}">${formatDate(v.date)}</time> · ${v.duration}</p>
    <p>${esc(v.about)}${v.cover ? ` ${esc(v.cover)}` : ''}</p>
  </article>`).join('')}
</div>`,
});

// ---- /examples ------------------------------------------------------------

/** The app in the browser (/play), opening a file from its library. */
const playUrl = (libraryPath) => `/play?open=${libraryPath.split('/').map(encodeURIComponent).join('/')}`;

const examples = loadExamples();
const listed = examples.filter(onSite);
const packs = loadPacks();

function groupBy(items, key) {
    const groups = new Map();
    for (const item of items) groups.set(item[key], [...(groups.get(item[key]) ?? []), item]);
    return [...groups];
}

/**
 * What leads /examples: the show files and songs that show what the app does,
 * each with a frame of it playing in Stage (site/src/media/featured, captured
 * from /play at 1280×720 and saved at 800×450).
 */
const FEATURED = [
    {id: 'trailer', open: 'Demos/Shows/cycletron-trailer.show.toml', page: '/examples/shows/cycletron-trailer',
        title: 'Cycletron Trailer', kind: 'Show',
        about: 'The trailer as a show file: a different visualizer mode for each section, with camera moves, cuts, strobes and title cards.'},
    {id: 'tour', open: 'Demos/Shows/feature-tour.show.toml', page: '/examples/shows/feature-tour',
        title: 'Feature Tour', kind: 'Show',
        about: 'Most show-file settings on two Agency tracks, with a comment above each section saying which settings it uses. Edit a value while it plays.'},
    {id: 'agency', open: 'Demos/Shows/agency-ost.show.toml', page: '/examples/shows/agency-ost',
        title: 'Agency OST', kind: 'Show',
        about: 'A thirteen-track album played back to back as one set; each track sets its own modes.'},
    {id: 'danse', open: 'Packs/halloween/shows/danse-macabre.show.toml', page: '/packs#halloween',
        title: 'Danse Macabre', kind: 'Halloween pack',
        about: 'Saint-Saëns in 3/4, on the pack\'s own modes: the graveyard, the haunted house and the monster band.'},
    {id: 'jingle', open: 'Packs/christmas/shows/jingle-bells.show.toml', page: '/packs#christmas',
        title: 'Jingle Bells', kind: 'Christmas pack',
        about: 'Five of the Christmas pack\'s modes, from the sleigh road to the snow globe, on one arrangement.'},
    {id: 'flesh', open: 'Demos/Songs/flesh-firmware.strudel', page: '/examples/songs/flesh-firmware',
        title: 'FLESH / FIRMWARE', kind: 'Song',
        about: 'A full song in one file. Press Play and edit any line: the change is heard as you type, and the visualizer follows each voice.'},
];

const featuredCard = (f) => `
  <article class="feature">
    <a class="feature__shot" href="${playUrl(f.open)}" aria-label="Play ${esc(f.title)} in Cycletron">
      <img src="/media/featured/${f.id}.jpg" alt="" width="800" height="450" loading="lazy">
      <span class="feature__play" aria-hidden="true"></span>
    </a>
    <p class="feature__kind">${esc(f.kind)}</p>
    <h3><a href="${f.page}">${esc(f.title)}</a></h3>
    <p>${esc(f.about)}</p>
  </article>`;

const exampleRow = (e) => `
      <li class="example">
        <a href="/examples/${e.slug}">${esc(e.title)}</a>
        ${e.bpm && !e.description?.includes('BPM') ? `<span class="example__bpm">${e.bpm} BPM</span>` : ''}
        ${e.description ? `<span class="example__about">${esc(e.description)}</span>` : ''}
      </li>`;

function exampleSection(section) {
    const items = listed.filter((e) => e.section === section);
    const body = groupBy(items, 'folder').map(([folder, entries]) => `
    ${folder ? `<h3>${esc(folder)}</h3>` : ''}
    <ul class="examples">${entries.map(exampleRow).join('')}
    </ul>`).join('');
    return `
<section class="example-section" id="${section.toLowerCase()}">
  <h2>${section}</h2>
  <p class="example-section__intro">${SECTION_INTROS[section]}</p>
  ${body}
</section>`;
}

page({
    path: '/examples',
    title: 'Examples',
    description: 'Show files and songs that play in the browser on Cycletron\'s engine, with their code.',
    body: `
<h1>Examples</h1>
<p class="lede">
  Each of these opens in the app in your browser, on its own engine and
  samples, with the visualizers. Shows play a song as a music video, section
  by section; the desktop app does the same and can render it to a video file.
</p>

<section class="featured" id="featured" aria-labelledby="featured-title">
  <h2 id="featured-title">Watch it play</h2>
  <div class="features">${FEATURED.map(featuredCard).join('')}
  </div>
  <p class="note">More shows and songs on the <a href="/packs">Packs</a> page. In the app, Cmd+Shift+F (Ctrl+Shift+F on Windows and Linux) switches to Stage.</p>
</section>

<p class="lede">
  These come with the app, in your library's Demos folder, along with short
  technique patterns and a sketch for each genre, which you can open from the
  library in the app.
</p>
${SITE_SECTIONS.map(exampleSection).join('')}`,
});

/** The example's own line, and what the page is when that leaves room. */
function exampleDescription(e) {
    const own = `${e.title}${e.description ? `: ${e.description.replace(/\.$/, '')}` : ''}.`;
    const what = e.kind === 'show'
        ? 'A Cycletron show file, with its source.'
        : 'A Strudel-style pattern from the Cycletron demo library, with its code.';
    return `${own} ${what}`.length <= 155 ? `${own} ${what}` : summary(own);
}

for (const e of listed) {
    const siblings = listed.filter((x) => x.section === e.section);
    const at = siblings.indexOf(e);
    const prev = siblings[at - 1];
    const next = siblings[at + 1];
    page({
        path: `/examples/${e.slug}`,
        title: `${e.title}${e.kind === 'show' ? ' (show)' : ''} — Examples`,
        description: exampleDescription(e),
        body: `
<p class="crumbs"><a href="/examples">Examples</a> / ${e.section}${e.folder ? ` / ${esc(e.folder)}` : ''}</p>
<h1>${esc(e.title)}</h1>
${e.description ? `<p class="lede">${esc(e.description)}</p>` : ''}
<p class="example-meta"><code>${esc(e.demosPath)}</code>${e.bpm && !e.description?.includes('BPM') ? ` · ${e.bpm} BPM` : ''}</p>
<p class="play-cta">
  <a class="button button--primary" href="${playUrl(e.demosPath)}">Play in Cycletron</a>
  <span class="note">${e.kind === 'show'
        ? 'Opens the show in the app in your browser. Press Play to start it, then Cmd+Shift+F (Ctrl+Shift+F) for Stage. Made for desktop browsers.'
        : 'Opens it in the app in your browser, with the visualizers. Made for desktop browsers.'}</span>
</p>
<pre class="code"><code>${esc(e.code)}</code></pre>
<nav class="pager" aria-label="More examples">
  ${prev ? `<a href="/examples/${prev.slug}">← ${esc(prev.title)}</a>` : '<span></span>'}
  ${next ? `<a href="/examples/${next.slug}">${esc(next.title)} →</a>` : ''}
</nav>`,
    });
}

// ---- /packs ---------------------------------------------------------------
// After the library is written: a pack's mode tour is included only when
// the songs it plays are (writeLibrary decides).

function packsPage() {
    const card = (p) => {
        const shows = p.shows.map((rel) => ({rel, title: showTitle(readFileSync(join(p.dir, rel), 'utf8'), rel)}));
        const songs = p.songs.map((rel) => ({rel, ...songMeta(readFileSync(join(p.dir, rel), 'utf8'), rel.split('/').pop())}));
        const play = (rel) => playUrl(`Packs/${p.id}/${rel}`);
        const playlist = playlists.find((l) => l.pack === p.id);
        return `
<section class="pack" id="${p.id}">
  <h2>${esc(p.name)} <span class="pack__version">${esc(p.version)}</span></h2>
  <p>${esc(p.description)}</p>
  ${playlist ? `<p><a href="${playlistUrl(playlist.id)}">${esc(playlist.title)}</a> <span class="note">its shows on YouTube, ${playlist.videos.length} videos</span> · <a href="/demos#${p.id}-playlist">on the Demos page</a></p>` : ''}
  ${p.probe ? `<p><a class="button" href="${play(p.probe)}">Tour its modes</a> <span class="note">every visualizer in the pack, two bars each</span></p>` : ''}
  ${shows.length ? `<h3>Shows</h3><ul class="pack__list">${shows.map((s) => `<li><a href="${play(s.rel)}">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}
  ${songs.length ? `<h3>Songs</h3><ul class="pack__list">${songs.map((s) => `<li><a href="${play(s.rel)}">${esc(s.name)}</a>${s.credit ? `<span class="pack__credit">${esc(s.credit)}</span>` : ''}</li>`).join('')}</ul>` : ''}
  ${!shows.length && !songs.length ? `<p class="note">Visualizers only: open any song and pick the pack's modes from the Visuals menu.</p>` : ''}
</section>`;
    };
    page({
        path: '/packs',
        title: 'Packs',
        description: 'Visualizer packs for Cycletron: modes, songs and shows that travel together, playable in the browser.',
        body: `
<h1>Packs</h1>
<p class="lede">
  A pack is a folder of visualizer modes, and the songs and shows made for
  them, that installs into Cycletron as one unit. Each one here opens in the
  app in your browser. <a href="${REPO_URL}/blob/${release.tag}/docs/PACKS.md">How packs are made</a>
</p>
${packs.map(card).join('')}`,
    });
}

// ---- /404 ------------------------------------------------------------------
// Vercel serves dist/404.html, with a 404 status, for any path it has no file for.

page({
    path: '/404',
    title: 'Page not found',
    description: 'This page does not exist.',
    body: `
<h1>Page not found</h1>
<p class="lede">There is no page at this address.</p>
<p><a href="/">Cycletron home</a> · <a href="/download">Download</a> · <a href="/examples">Examples</a> · <a href="/guide">Guide</a></p>`,
});

// ---- static files ---------------------------------------------------------

cpSync(join(import.meta.dirname, 'src'), DIST, {recursive: true});
mkdirSync(join(DIST, 'media'), {recursive: true});
for (const file of STAGE_SHOTS.map((s) => s.file)) {
    cpSync(join(ROOT, 'docs/media/screenshots', file), join(DIST, 'media', file));
}
cpSync(join(ROOT, 'src-tauri/icons/128x128.png'), join(DIST, 'icon.png'));
cpSync(join(ROOT, 'src-tauri/icons/icon.ico'), join(DIST, 'favicon.ico'));

// The app itself at /play (ui, `npm run build:web`), with the samples and
// soundfonts it loads and its library: Demos/ as the app seeds it, and the
// packs. SKIP_APP=1 reuses the last app build.
if (!process.env.SKIP_APP) {
    execFileSync('npm', ['run', 'build:web'], {cwd: join(ROOT, 'ui'), stdio: ['ignore', 'ignore', 'inherit']});
}
cpSync(join(ROOT, 'ui', 'dist-web'), join(DIST, 'play'), {recursive: true});
const library = writeLibrary(join(DIST, 'play', 'library'), examples, packs);
packsPage();

// /play is the app, not a page to index (vercel.json sends it noindex); the
// examples carry the same code as text.
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((path) => `  <url><loc>${SITE_URL}${path}</loc></url>`).join('\n')}
</urlset>
`);
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml
`);

if (release.local) console.log('site: local build — docs and examples from the working tree; set SITE_TAG for a release build');
console.log(`site: ${release.tag} (${formatDate(release.date)}), changelog ${changelog.length} releases, ${listed.length} of ${examples.length} examples listed, library ${library.files} files, packs: ${packs.map((p) => p.id).join(', ') || 'none'} → ${DIST}`);
