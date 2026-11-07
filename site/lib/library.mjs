// The library the app opens in the browser (ui/src/web-library.ts reads it):
// Demos/ exactly as the app seeds it, and Packs/<id>/ with each pack's songs,
// shows and built visualizers. Files are copied as they are in the repos.

import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, normalize} from 'node:path';
import {ROOT} from './content.mjs';

/** The packs repo; a sibling checkout unless CYCLETRON_PACKS says otherwise. */
const PACKS_REPO = process.env.CYCLETRON_PACKS ?? join(ROOT, '..', 'cycletron-packs');

/**
 * Every pack in the packs repo whose visualizers are built, read from its
 * pack.json (the same lists its zip carries).
 */
export function loadPacks() {
    const dir = join(PACKS_REPO, 'packs');
    if (!existsSync(dir)) return [];
    const packs = [];
    for (const id of readdir(dir)) {
        const manifestPath = join(dir, id, 'pack.json');
        if (!existsSync(manifestPath)) continue;
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const viz = (m.viz ?? []).map((v) => ({
            id: JSON.parse(readFileSync(join(dir, id, v, 'pack.json'), 'utf8')).id,
            dir: v,
            bundle: join(dir, id, v, 'dist', 'index.js'),
        }));
        if (viz.some((v) => !existsSync(v.bundle))) {
            console.warn(`site: pack ${id} has an unbuilt visualizer (run cycpack build ${id}); left out`);
            continue;
        }
        const probe = existsSync(join(dir, id, 'probe', 'probe.show.toml')) ? 'probe/probe.show.toml' : null;
        packs.push({
            id: m.id, name: m.name, version: m.version, description: m.description, license: m.license,
            dir: join(dir, id), songs: m.songs ?? [], shows: m.shows ?? [], viz, probe,
        });
    }
    return packs;
}

/** A pack song's name (frontmatter) and credit (its first comment line), as written. */
export function songMeta(text, file) {
    const name = text.match(/^---\r?\n[\s\S]*?^name:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const credit = body.match(/^\/\/\s?(.+)$/m)?.[1] ?? null;
    return {name: name ?? file.replace(/\.strudel$/, ''), credit};
}

/** A show's title from its `[show]` table. */
export function showTitle(text, file) {
    return text.match(/^title\s*=\s*"(.+)"/m)?.[1] ?? file.replace(/\.show\.toml$/, '');
}

/** Folder names, without `_` staging folders. */
function readdir(dir) {
    return readdirSync(dir).filter((n) => !n.startsWith('_') && !n.startsWith('.')).sort();
}

/** Write the library under `out` and its index.json; returns counts. */
export function writeLibrary(out, examples, packs) {
    const files = [];
    const put = (rel, from) => {
        mkdirSync(dirname(join(out, rel)), {recursive: true});
        cpSync(from, join(out, rel));
    };

    for (const e of examples) {
        put(e.demosPath, join(ROOT, e.source));
        files.push(e.demosPath);
    }

    const vizIndex = [];
    for (const p of packs) {
        for (const rel of [...p.songs, ...p.shows]) {
            put(`Packs/${p.id}/${rel}`, join(p.dir, rel));
            files.push(`Packs/${p.id}/${rel}`);
        }
    }
    // A pack's probe show (every mode, two bars each) is its mode tour. It
    // goes in only when the songs it plays are in the library: a probe may
    // borrow a song another pack doesn't ship.
    for (const p of packs) {
        if (!p.probe) continue;
        const show = readFileSync(join(p.dir, p.probe), 'utf8');
        const sources = [...show.matchAll(/^source\s*=\s*"([^"]+)"/gm)].map((m) => normalize(`Packs/${p.id}/probe/${m[1]}`));
        if (sources.every((s) => files.includes(s))) {
            put(`Packs/${p.id}/${p.probe}`, join(p.dir, p.probe));
            files.push(`Packs/${p.id}/${p.probe}`);
        } else {
            console.warn(`site: ${p.id} probe left out; it plays ${sources.filter((s) => !files.includes(s)).join(', ')}, which no pack ships`);
            p.probe = null;
        }
    }
    for (const p of packs) {
        for (const v of p.viz) {
            const rel = `Packs/${p.id}/${v.dir}/index.js`;
            put(rel, v.bundle);
            vizIndex.push({id: v.id, path: rel});
        }
    }

    writeFileSync(join(out, 'index.json'), JSON.stringify({files: files.sort(), packs: vizIndex}));
    return {files: files.length, packs: vizIndex.length};
}
