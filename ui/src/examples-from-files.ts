/**
 * Auto-catalog of full songs + curated techniques + genre sketches.
 * Sourced from on-disk `.strudel` files so the Examples browser stays in
 * lockstep with `ui/songs/` and `corpus/` without hand-copying code.
 */

import type {Example, ExampleSection} from './examples-data.js';

// Vite raw imports — bundled into the UI so demos work offline / without the
// library seed. Paths are relative to this file under `ui/src/`.
const songModules = import.meta.glob('../songs/**/*.strudel', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const techniqueModules = import.meta.glob(
    '../../corpus/{rhythm,melody,harmony,form,timbre,motion}/*.strudel',
    {
        query: '?raw',
        import: 'default',
        eager: true,
    },
) as Record<string, string>;

const genreModules = import.meta.glob('../../corpus/genres/*/generated-*.strudel', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

// Progressive teaching set — was a hand-written TS array, now on-disk `.strudel`
// files so `corpus-check` validates them against strudel-rs like everything else.
const lessonModules = import.meta.glob('../../corpus/lessons/*.strudel', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const patternModules = import.meta.glob('../../corpus/patterns/*.strudel', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

const showcaseModules = import.meta.glob('../../corpus/showcase/*.strudel', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

function basename(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] ?? path;
}

function stripExt(name: string): string {
    return name.replace(/\.strudel$/i, '');
}

/** `four-on-the-floor` / `01-legacy-system` → readable title. */
function humanize(slug: string): string {
    return slug
        .replace(/^\d+-/, '') // drop track numbers for display (kept in path)
        .split(/[-_]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function extractTempo(code: string): number | null {
    const m = code.match(/setbpm\s*\(\s*(\d+(?:\.\d+)?)\s*\)/i)
        ?? code.match(/setbpm\s+(\d+(?:\.\d+)?)/i);
    return m ? Number(m[1]) : null;
}

function firstComment(code: string): string | undefined {
    const line = code.split('\n').find((l) => l.trim().startsWith('//'));
    if (!line) return undefined;
    return line.replace(/^\/\/\s?/, '').trim() || undefined;
}

function complexityFromPath(path: string, section: ExampleSection): string {
    if (section === 'songs') {
        if (path.includes('/agency/')) return 'advanced';
        return 'intermediate';
    }
    if (section === 'genres') return 'intermediate';
    // techniques by category
    if (path.includes('/form/') || path.includes('/motion/')) return 'advanced';
    if (path.includes('/harmony/') || path.includes('/timbre/')) return 'intermediate';
    return 'beginner';
}

function tagsFor(path: string, section: ExampleSection): string[] {
    const tags: string[] = [section];
    const p = path.replace(/\\/g, '/');
    if (p.includes('/agency/')) tags.push('agency', 'album');
    if (p.includes('/rhythm/')) tags.push('drums', 'rhythm');
    if (p.includes('/melody/')) tags.push('melody', 'tonal');
    if (p.includes('/harmony/')) tags.push('harmony', 'chords');
    if (p.includes('/form/')) tags.push('form', 'arrangement');
    if (p.includes('/timbre/')) tags.push('synth', 'sound-design');
    if (p.includes('/motion/')) tags.push('modulation', 'generative');
    if (p.includes('/genres/')) {
        const m = p.match(/\/genres\/([^/]+)\//);
        if (m) tags.push(m[1]);
    }
    // Song filenames as soft tags
    const base = stripExt(basename(p)).toLowerCase();
    if (base.includes('techno')) tags.push('techno');
    if (base.includes('ambient')) tags.push('ambient');
    if (base.includes('drum') || base.includes('dnb')) tags.push('dnb');
    if (base.includes('house') || base === 'opener') tags.push('house');
    return [...new Set(tags)].slice(0, 5);
}

function entryFromModule(
    path: string,
    code: string,
    section: ExampleSection,
    titlePrefix?: string,
): Example {
    const file = stripExt(basename(path));
    let title = humanize(file.replace(/^generated-/, ''));
    if (titlePrefix) title = `${titlePrefix} · ${title}`;
    // Agency: keep track number in title for album order.
    if (path.includes('/agency/')) {
        const num = file.match(/^(\d+)/)?.[1];
        title = num ? `Agency ${num} · ${humanize(file)}` : `Agency · ${humanize(file)}`;
    }
    const blurb = firstComment(code);
    return {
        title,
        code: code.trim() + '\n',
        tags: tagsFor(path, section),
        complexity: complexityFromPath(path, section),
        tempo: extractTempo(code),
        section,
        blurb,
    };
}

function sortSongs(a: Example, b: Example): number {
    // Agency tracks first in numeric order, then other songs A–Z.
    const aAg = a.title.startsWith('Agency');
    const bAg = b.title.startsWith('Agency');
    if (aAg && bAg) return a.title.localeCompare(b.title, undefined, {numeric: true});
    if (aAg) return -1;
    if (bAg) return 1;
    return a.title.localeCompare(b.title);
}

/** Full tracks from `ui/songs/`. */
export function loadSongExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(songModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        out.push(entryFromModule(path, code, 'songs'));
    }
    return out.sort(sortSongs);
}

/** Curated corpus techniques (rhythm/melody/…). */
export function loadTechniqueExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(techniqueModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        // Prefix with category for scannability in the grid.
        const cat = path.match(/\/(rhythm|melody|harmony|form|timbre|motion)\//)?.[1];
        const prefix = cat ? humanize(cat) : undefined;
        // Title is already humanized filename; show category as tag, not title prefix
        // (keeps cards short). Put category first in tags via tagsFor.
        void prefix;
        out.push(entryFromModule(path, code, 'techniques'));
    }
    // Stable: category then title
    return out.sort((a, b) => {
        const ca = a.tags.find((t) =>
            ['rhythm', 'melody', 'harmony', 'form', 'timbre', 'motion'].includes(t),
        ) ?? '';
        const cb = b.tags.find((t) =>
            ['rhythm', 'melody', 'harmony', 'form', 'timbre', 'motion'].includes(t),
        ) ?? '';
        if (ca !== cb) return ca.localeCompare(cb);
        return a.title.localeCompare(b.title);
    });
}

/** Progressive lessons (`corpus/lessons/NN-*.strudel`), ordered by prefix. */
export function loadLessonExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(lessonModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        const entry = entryFromModule(path, code, 'lessons');
        const num = stripExt(basename(path)).match(/^(\d+)/);
        if (num) entry.lesson = Number(num[1]);
        out.push(entry);
    }
    return out.sort((a, b) => (a.lesson ?? 0) - (b.lesson ?? 0));
}

/** Short single-technique patterns (`corpus/patterns/*.strudel`). */
export function loadPatternExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(patternModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        out.push(entryFromModule(path, code, 'patterns'));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Longer demo pieces (`corpus/showcase/*.strudel`). */
export function loadShowcaseExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(showcaseModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        out.push(entryFromModule(path, code, 'showcase'));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** One sketch per genre recipe. */
export function loadGenreExamples(): Example[] {
    const out: Example[] = [];
    for (const [path, code] of Object.entries(genreModules)) {
        if (typeof code !== 'string' || !code.trim()) continue;
        // Skip draft folders if any slip through.
        if (path.includes('/_')) continue;
        out.push(entryFromModule(path, code, 'genres'));
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}
