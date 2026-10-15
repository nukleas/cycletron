#!/usr/bin/env node
// Render a Cycletron visualizer mode offline to video, frame-exact and synced
// to a song's mix. Reads a `performance-export` directory (performance.json,
// which carries the song's code, + mix.wav), cuts between modes on section boundaries
// (`--cuts section:mode,…`; unlisted sections show `--mode`), steps the mode on a fixed clock in headless
// Chromium (viz-render.html), and pipes frames to ffmpeg with the audio.
//
// Usage:
//   node scripts/render-viz.mjs <performance-dir> <out.mp4>
//     [--mode cockpit] [--cuts payload:cockpit,purge:neon-circuit] [--from 0] [--to 40] [--fps 60] [--size 1920x1080]
//     [--sensitivity 1] [--gain-db 0] [--code off|fold|solo] [--camera on] [--titles on] [--jobs n]
//
// `--code` overlays the pattern the way Stage Mode draws it, with the playing
// notes lit and the given follow mode; omit it for visuals only. `--camera on`
// moves over the mode with the song (drifting through each section, slamming
// out on its downbeat, bumping on kicks); `--titles on` cards each section.
//
// `--jobs` renders that many chunks at once, each in its own browser, and
// joins them losslessly; every frame replays from the song's start, so the
// result matches one job bit for bit (trail modes may differ by one level on
// a few pixels for a moment after a seam). For quick looks, `--size 960x540 --fps 30`.

import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = {
    mode: 'cockpit', cuts: '', code: '', from: '0', to: '', fps: '60', size: '1920x1080', sensitivity: '1',
    // Rendering saturates the CPU at about eight jobs on a 14-core machine; more only contend.
    'gain-db': '0', camera: 'off', titles: 'off', jobs: String(Math.max(1, Math.min(8, availableParallelism() - 2))),
};
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].slice(2);
        if (!(key in flags)) throw new Error(`unknown flag --${key}`);
        flags[key] = args[++i];
    } else positional.push(args[i]);
}
if (positional.length !== 2) {
    console.error('usage: render-viz.mjs <performance-dir> <out.mp4> [--mode id] [--cuts section:mode,…] [--from s] [--to s] [--fps n] [--size WxH] [--sensitivity x] [--gain-db db] [--code off|fold|solo] [--camera on|off] [--titles on|off] [--jobs n]');
    process.exit(2);
}
const [perfDir, outPath] = positional.map((p) => path.resolve(p));

const performance = JSON.parse(await readFile(path.join(perfDir, 'performance.json'), 'utf8'));
const audioPath = path.join(perfDir, performance.audio);
const fps = Number(flags.fps);
const [width, height] = flags.size.split('x').map(Number);
const first = Math.round(Number(flags.from) * fps);
const last = Math.round((flags.to ? Number(flags.to) : performance.duration_ns / 1e9) * fps);
const frames = last - first;
const cuts = sectionCuts(performance.sections, flags.mode, flags.cuts);
const sections = performance.sections.map((s) => ({label: s.label, at: s.start_ns / 1e9, end: s.end_ns / 1e9}));
// Layered voices ([bd,cr]) share an onset: one kick each.
const kicks = [...new Set(performance.events.filter((e) => e.sound === 'bd').map((e) => e.at_ns))]
    .sort((a, b) => a - b).map((ns) => ns / 1e9);
const setup = {
    code: performance.code, bpm: performance.bpm, cuts, width, height, fps, sensitivity: Number(flags.sensitivity),
    audio: '/__render/mix.wav', code_follow: flags.code || null,
    sections, kicks, camera: onOff('camera'), titles: onOff('titles'),
};
// At least a second per chunk: each pays a browser launch and a warm-up.
const jobs = Math.max(1, Math.min(Number(flags.jobs), Math.floor(frames / fps)));
const bounds = Array.from({length: jobs + 1}, (_, k) => Math.round((k * frames) / jobs));

const server = await createServer({root: UI, mode: 'render', logLevel: 'error', server: {port: 0}});
await server.listen();
const url = new URL('viz-render.html', server.resolvedUrls.local[0]).href;
const parts = await mkdtemp(path.join(path.dirname(outPath), '.render-viz-'));
const label = cuts.map((c) => c.mode).join('→');
const done = new Array(jobs).fill(0);
let failure = null;
const started = Date.now();
try {
    // One failure stops the rest; every chunk settles before its parts are removed.
    await Promise.allSettled(bounds.slice(0, -1).map((from, k) =>
        renderChunk(k, first + from, bounds[k + 1] - from).catch((e) => {
            failure ??= e;
        })));
    if (failure) throw failure;
    const list = path.join(parts, 'parts.txt');
    await writeFile(list, bounds.slice(0, -1).map((_, k) => `file '${chunkPath(k)}'\n`).join(''));
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', list,
        '-ss', String(first / fps), '-t', String(frames / fps), '-i', audioPath,
        '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
        '-af', `volume=${flags['gain-db']}dB`, '-c:a', 'aac', '-b:a', '256k',
        outPath,
    ]);
    console.error(`\n${label}: ${frames} frames → ${outPath} in ${((Date.now() - started) / 1000).toFixed(1)}s (${jobs} jobs)`);
} finally {
    await rm(parts, {recursive: true, force: true});
    await server.close();
}

/** Render `count` frames from song frame `start` to a video-only part. */
async function renderChunk(k, start, count) {
    const browser = await chromium.launch();
    let ffmpeg = null;
    try {
        const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
        page.on('pageerror', (e) => console.error('[page]', e.message));
        await page.route('**/__render/mix.wav', (route) => route.fulfill({path: audioPath, contentType: 'audio/wav'}));
        await page.goto(url);
        await page.waitForFunction(() => 'vizRender' in window);
        await page.evaluate((opts) => window.vizRender.setup(opts), {...setup, startFrame: start});

        ffmpeg = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
            // veryfast, not medium: a quarter less render time with every core busy, for a
            // slightly lower-quality encode at crf 16 — fine for video that is re-encoded on upload.
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
            chunkPath(k),
        ], {stdio: ['pipe', 'inherit', 'inherit']});
        const encoded = exited(ffmpeg);
        // Awaited below on success; on a failure the frame loop's error is the one to report.
        encoded.catch(() => {});
        // An early ffmpeg exit surfaces through `encoded`, not as EPIPE on the next write.
        ffmpeg.stdin.on('error', () => {});
        for (let i = 0; i < count; i++) {
            if (failure) throw failure;
            const png = Buffer.from(await page.evaluate(() => window.vizRender.frame()), 'base64');
            if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
            done[k] = i + 1;
            if (done[k] % fps === 0) {
                const sum = done.reduce((a, b) => a + b, 0);
                process.stderr.write(`\r${label}: ${(sum / fps).toFixed(0)}/${(frames / fps).toFixed(0)}s`);
            }
        }
        ffmpeg.stdin.end();
        await encoded;
    } finally {
        if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill();
        await browser.close();
    }
}

function chunkPath(k) {
    return path.join(parts, `${String(k).padStart(3, '0')}.mp4`);
}

function run(cmd, argv) {
    return exited(spawn(cmd, argv, {stdio: ['ignore', 'inherit', 'inherit']}));
}

function exited(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${child.spawnfile} exited ${c}`))));
    });
}

// One cut per section, merging neighbours that show the same mode.
function sectionCuts(sections, fallback, spec) {
    const bySection = new Map();
    for (const pair of spec.split(',').filter(Boolean)) {
        const [label, mode] = pair.split(':');
        if (!sections.some((s) => s.label === label)) {
            throw new Error(`--cuts: no section '${label}' (have: ${sections.map((s) => s.label).join(', ')})`);
        }
        bySection.set(label, mode);
    }
    const cuts = [];
    for (const section of sections) {
        const mode = bySection.get(section.label) ?? fallback;
        if (cuts.at(-1)?.mode !== mode) cuts.push({at: cuts.length ? section.start_ns / 1e9 : 0, mode});
    }
    return cuts;
}

function onOff(flag) {
    if (flags[flag] !== 'on' && flags[flag] !== 'off') throw new Error(`--${flag}: on or off, not '${flags[flag]}'`);
    return flags[flag] === 'on';
}
