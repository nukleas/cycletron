// The demo library the app seeds into Demos/, mirroring
// src-tauri/src/demos.rs: ui/songs → Songs, ui/shows → Shows, the corpus
// technique folders → Techniques/<Category>, corpus/genres → Genres. If that
// mapping changes, change this too.

import {execFileSync} from 'node:child_process';
import {ROOT, read} from './content.mjs';

export const SECTIONS = ['Songs', 'Shows', 'Techniques', 'Genres'];

export const SECTION_INTROS = {
    Songs: 'Full tracks, including the Agency OST album.',
    Shows: 'Show files: songs played as music videos, section by section.',
    Techniques: 'Short patterns, one musical idea each.',
    Genres: 'A generated sketch for each genre recipe, and a few curated examples.',
};

const TECHNIQUES = ['rhythm', 'melody', 'harmony', 'form', 'timbre', 'motion'];
const titleCase = (s) => s.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
// demos.rs skips underscore folders (local staging).
const hidden = (rel) => rel.split('/').some((p) => p.startsWith('_'));

/**
 * Title and description from the header comment. Shapes in the library:
 *   // AGENCY OST — 01 · Legacy System
 *   // Last Train — late-night 2-step garage · G minor · 130 BPM
 *   // Chicago / deep house · A minor · 124 BPM      (description only)
 * Only songs are named in the header. Techniques keep their file name, as the
 * app lists them; genres use the folder name the app gives them.
 */
function describe(code, fallbackTitle, named) {
    const comment = [];
    for (const line of code.split('\n')) {
        if (!line.startsWith('//')) break;
        comment.push(line.replace(/^\/\/\s?/, '').trim());
    }
    const first = comment[0] ?? '';
    const bpm = Number(code.match(/setbpm\((\d+(?:\.\d+)?)\)/)?.[1]) || null;
    const album = first.match(/^AGENCY OST — \d+ · (.+)$/);
    if (album) return {title: album[1], description: null, bpm};
    // Only songs put their name before the dash; elsewhere it's prose.
    const split = named && first.match(/^(.+?) — (.+)$/);
    if (split) return {title: split[1], description: split[2], bpm};
    // A bare name on its own line ("// FLESH / FIRMWARE").
    if (named && first && first.length < 40 && !/[.:]$/.test(first)) return {title: first, description: null, bpm};
    // Songs: only the header line describes them; the rest is notes.
    return {title: fallbackTitle, description: (named ? first : comment.join(' ')) || null, bpm};
}

function example({path, section, folder, slug, title, demosPath}) {
    // Some songs carry frontmatter the app wrote on save; it isn't part of the pattern.
    const code = read(path).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimEnd() + '\n';
    const kind = path.endsWith('.show.toml') ? 'show' : 'pattern';
    const meta = kind === 'show'
        ? {title: code.match(/^title\s*=\s*"(.+)"/m)?.[1] ?? title, description: null, bpm: null}
        : describe(code, title, section === 'Songs');
    return {slug, section, folder, file: path.split('/').pop(), source: path, demosPath, kind, ...meta, code};
}

/** Every example, ordered by section, then folder, then slug. */
export function loadExamples() {
    // Tracked files only: what a release tag contains.
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'ui/songs', 'ui/shows', 'corpus'], {encoding: 'utf8'})
        .split('\n').filter(Boolean);

    const examples = [];
    for (const path of files) {
        if (hidden(path)) continue;
        const name = path.split('/').pop();
        const base = name.replace(/\.(strudel|show\.toml)$/, '');
        let m;
        if ((m = path.match(/^ui\/songs\/(.+)\.strudel$/))) {
            const rel = m[1];
            const parts = rel.split('/');
            examples.push(example({path, section: 'Songs', folder: parts.length > 1 ? titleCase(parts[0]) : null,
                slug: `songs/${rel}`, title: titleCase(base.replace(/^\d+-/, '')), demosPath: `Demos/Songs/${rel}.strudel`}));
        } else if (path.startsWith('ui/shows/') && name.endsWith('.show.toml')) {
            examples.push(example({path, section: 'Shows', folder: null, slug: `shows/${base}`, title: titleCase(base),
                demosPath: `Demos/Shows/${name}`}));
        } else if ((m = path.match(/^corpus\/([^/]+)\/([^/]+)\.strudel$/)) && TECHNIQUES.includes(m[1])) {
            examples.push(example({path, section: 'Techniques', folder: titleCase(m[1]),
                slug: `techniques/${m[1]}/${m[2]}`, title: m[2],
                demosPath: `Demos/Techniques/${titleCase(m[1])}/${m[2]}.strudel`}));
        } else if ((m = path.match(/^corpus\/genres\/([^/]+)\/([^/]+)\.strudel$/))) {
            const [, genre, file] = m;
            const generated = file.startsWith('generated-');
            const exampleName = file.replace(/^example-/, '').replace(/\.strudel$/, '');
            examples.push(example({path, section: 'Genres', folder: titleCase(genre),
                slug: generated ? `genres/${genre}` : `genres/${genre}/${exampleName}`,
                title: generated ? titleCase(genre) : titleCase(exampleName),
                demosPath: generated
                    ? `Demos/Genres/${titleCase(genre)}.strudel`
                    : `Demos/Genres/${titleCase(genre)}/${titleCase(exampleName)}.strudel`}));
        }
    }
    return examples.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section)
        || (a.folder ?? '').localeCompare(b.folder ?? '')
        || a.slug.localeCompare(b.slug));
}
