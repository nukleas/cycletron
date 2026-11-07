// Content read from the repo the site is built in, and from the GitHub
// release being deployed. Nothing here is copied or hand-maintained.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const REPO = 'nukleas/cycletron';
export const REPO_URL = `https://github.com/${REPO}`;

/** Repo root: the site lives in `site/`. */
export const ROOT = join(import.meta.dirname, '..', '..');

export const read = (path) => readFileSync(join(ROOT, path), 'utf8');

async function github(path) {
    const headers = {Accept: 'application/vnd.github+json'};
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {headers});
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
    return res.json();
}

/**
 * The release this build describes: `SITE_TAG` (the deploy workflow passes
 * the tag it checked out), else the latest published release. Plus the set
 * of published tags, so the changelog lists only releases people can get.
 */
export async function loadRelease() {
    const tag = process.env.SITE_TAG;
    const latest = await github(tag ? `/releases/tags/${tag}` : '/releases/latest');
    if (latest.draft) throw new Error(`${latest.tag_name} is a draft; the site describes published releases only`);
    const all = await github('/releases?per_page=100');
    return {
        tag: latest.tag_name,
        version: latest.tag_name.replace(/^v/, ''),
        date: latest.published_at.slice(0, 10),
        url: latest.html_url,
        assets: latest.assets.map((a) => ({name: a.name, url: a.browser_download_url, size: a.size})),
        published: new Set(all.filter((r) => !r.draft).map((r) => r.tag_name)),
        /** No SITE_TAG: docs come from the working tree, not the release's tag. */
        local: !tag,
    };
}

/** "0.1.0-alpha.25" → [0, 1, 0, 25]; a version without a prerelease sorts after its alphas. */
function versionKey(version) {
    const [core, pre] = version.split('-');
    const n = pre?.match(/(\d+)$/)?.[1];
    return [...core.split('.').map(Number), n === undefined ? Infinity : Number(n)];
}

function compareVersions(a, b) {
    const [x, y] = [versionKey(a), versionKey(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

/**
 * CHANGELOG.md entries up to the release being built, newest first. In a
 * release build that is every dated entry in the tag's file (all of it is in
 * the build, published on its own or not); a local build stops at the
 * release it describes. `Unreleased` never shows.
 */
export function loadChangelog(release) {
    return read('CHANGELOG.md')
        .split(/^## /m)
        .slice(1)
        .map((chunk) => {
            const [heading, ...rest] = chunk.split('\n');
            const m = heading.match(/^(\S+) \((\d{4}-\d{2}-\d{2})\)/);
            return m && {version: m[1], date: m[2], body: rest.join('\n').trim()};
        })
        .filter((e) => e && compareVersions(e.version, release.version) <= 0)
        .map((e) => ({...e, released: release.published.has(`v${e.version}`)}));
}

/** A `## Heading` section of a markdown file, without its heading line. */
export function section(markdown, heading) {
    const m = markdown.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    if (!m) throw new Error(`no "## ${heading}" section`);
    return m[1].trim();
}

/** The installers people pick between, from the release's assets. */
export function installers(release) {
    const find = (re) => release.assets.find((a) => re.test(a.name));
    return [
        {os: 'mac', platform: 'macOS', label: 'Universal .dmg', asset: find(/\.dmg$/),
            note: 'Intel and Apple Silicon. Signed and notarized. macOS 10.15 or newer.'},
        {os: 'windows', platform: 'Windows', label: 'Installer .exe', asset: find(/-setup\.exe$/),
            note: 'Not signed yet: in SmartScreen, choose More info → Run anyway.'},
        {os: 'linux', platform: 'Linux', label: 'AppImage', asset: find(/\.AppImage$/),
            note: 'Runs on most distributions. Make it executable, then run it.'},
        {os: 'linux', platform: 'Linux', label: '.deb', asset: find(/\.deb$/),
            note: 'Debian and Ubuntu. Needs libwebkit2gtk-4.1-0, libgtk-3-0 and libayatana-appindicator3-1.'},
    ].filter((i) => i.asset);
}
