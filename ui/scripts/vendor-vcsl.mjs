#!/usr/bin/env node
/**
 * Fetch and encode the bundled VCSL subset into `ui/public/samples/`.
 *
 * `vcsl-sources.json` is the provenance table: for every bundled bank, which
 * upstream VCSL recording each note (pitched) or index (one-shot) comes
 * from. `ui/sample-tables.ts` (VCSL_PITCHED / VCSL_ONESHOTS) is what the
 * app loads; the two must agree, and the check at the end enforces it.
 *
 * Each file is trimmed to its bank's cap, faded, peak-normalised to −4 dB,
 * downmixed to mono and encoded as MP3 (~130 kb/s VBR) — 125 recordings
 * come to ~3.5 MB instead of 200 MB of 24-bit WAV. Needs `sox` and
 * `ffmpeg` on PATH; upstream downloads are cached in `$TMPDIR/vcsl-raw/`.
 *
 *   node ui/scripts/vendor-vcsl.mjs
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {VCSL_ONESHOTS, VCSL_PITCHED} from '../sample-tables.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = resolve(HERE, '../public/samples');
const sources = JSON.parse(readFileSync(join(HERE, 'vcsl-sources.json'), 'utf8'));
const CACHE = process.env.VCSL_CACHE || join(tmpdir(), 'vcsl-raw');
const DEFAULT_CAP = 4;
mkdirSync(CACHE, {recursive: true});

function encodeUrl(rel) {
    // Manifests mix pre-encoded (`%20`) and literal spellings; encode only
    // what is not already a valid escape.
    return rel.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
}

async function fetchRaw(rel, dest) {
    if (existsSync(dest) && statSync(dest).size > 1000) return;
    const url = sources._base + encodeUrl(rel);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const {writeFileSync} = await import('node:fs');
    writeFileSync(dest, buf);
}

function duration(file) {
    return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {encoding: 'utf8'}));
}

function encode(raw, mp3, cap) {
    const len = Math.min(cap, duration(raw));
    const fade = Math.min(0.3, len * 0.25);
    const tmp = `${mp3}.tmp.wav`;
    execFileSync('sox', ['-q', raw, '-b', '16', '-r', '44100', '-c', '1', tmp,
        'trim', '0', len.toFixed(3), 'fade', 't', '0', len.toFixed(3), fade.toFixed(3), 'norm', '-4']);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-codec:a', 'libmp3lame', '-q:a', '4', mp3]);
    rmSync(tmp);
}

let done = 0;
let bytes = 0;
const jobs = [];
for (const [bank, notes] of VCSL_PITCHED) {
    const src = sources.banks[bank];
    for (const [note, sub] of Object.entries(notes)) {
        if (!src?.[note]) throw new Error(`vcsl-sources.json has no ${bank} ${note}`);
        jobs.push({bank, key: note, rel: src[note], sub});
    }
}
for (const [bank, files] of VCSL_ONESHOTS) {
    const src = sources.banks[bank];
    files.forEach((sub, i) => {
        if (!src?.[i]) throw new Error(`vcsl-sources.json has no ${bank}[${i}]`);
        jobs.push({bank, key: String(i), rel: src[i], sub});
    });
}
for (const {bank, key, rel, sub} of jobs) {
    const raw = join(CACHE, `${bank}__${key}.wav`);
    await fetchRaw(rel, raw);
    const dest = join(SAMPLES, sub);
    mkdirSync(dirname(dest), {recursive: true});
    encode(raw, dest, sources._caps_seconds[bank] ?? DEFAULT_CAP);
    bytes += statSync(dest).size;
    done++;
}
console.log(`[vendor-vcsl] ${done} files, ${(bytes / 1e6).toFixed(2)} MB → ${SAMPLES}`);
