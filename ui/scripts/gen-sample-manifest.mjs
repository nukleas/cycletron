#!/usr/bin/env node
/**
 * Build-time generator: derive `ui/public/cycletron.strudel.json` — a
 * strudel.json manifest of the bundled Cycletron sample set — from the
 * tables in `ui/sample-tables.ts` (the same tables live playback loads).
 *
 * The offline export renderer (src-tauri/src/export.rs) registers this
 * manifest, so an export resolves `bd`, `RolandTR808_bd`, `perc`, `flbass:2`,
 * … to the exact files live playback uses. Regenerated on every dev/build run
 * (checked in; regenerate with `npm run gen:manifest`), so it can never drift
 * from the tables.
 *
 * Paths are relative to the manifest's own directory (the engine resolves a
 * local manifest against its parent dir): `samples/...` and `machines/...`,
 * matching both `ui/public/` and the bundled Tauri resource layout. Streamed
 * kit voices (TR-909, DR-55 — no redistributable license) keep their absolute
 * upstream URLs, which the engine fetches over HTTP exactly like live does.
 *
 * Node ≥22.18 strips the type annotations from the imported .ts module.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    ESSENTIAL_DRUMS,
    INSTRUMENT_BANKS,
    MACHINE_KITS,
    PERCUSSION_COLORS,
} from '../sample-tables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../public/cycletron.strudel.json');

/** Map a sample-loader URL to a manifest path (relative or absolute-remote). */
function manifestPath(url) {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return url.slice(1); // '/machines/x.wav' → 'machines/x.wav'
    return `samples/${url}`; // table paths are relative to /samples/
}

const banks = {};

for (const {name, sub} of ESSENTIAL_DRUMS) {
    banks[name] = [manifestPath(sub)];
}
for (const [name, sub] of PERCUSSION_COLORS) {
    banks[name] = [manifestPath(sub)];
}
for (const [name, files] of INSTRUMENT_BANKS) {
    banks[name] = files.map(manifestPath); // array order = `:n` sample index
}
for (const [machine, , voices] of MACHINE_KITS) {
    for (const [voice, url] of voices) {
        banks[`${machine}_${voice}`] = [manifestPath(url)];
    }
}

const json = `${JSON.stringify(banks, null, 2)}\n`;
let previous = null;
try {
    previous = readFileSync(OUT, 'utf8');
} catch {
    // first generation
}
if (previous !== json) {
    writeFileSync(OUT, json);
    console.log(`[gen-sample-manifest] wrote ${OUT} (${Object.keys(banks).length} banks)`);
} else {
    console.log(`[gen-sample-manifest] up to date (${Object.keys(banks).length} banks)`);
}
