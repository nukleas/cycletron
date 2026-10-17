#!/usr/bin/env node
// Render a show file (`*.show.toml`) offline to a music video: each song's
// sections show the visuals the show gives them — mode, camera, title cards,
// code — cut the same way the live show cuts them (`src/show/director.ts`),
// frame-exact and synced to the song's mix. Songs play back to back, each its
// form `passes` times, and the video ends with the last.
//
// Usage:
//   node scripts/render-viz.mjs <show.toml> [--out video.mp4] [--song n] [--section label]
//     [--from s] [--to s] [--size WxH] [--fps n] [--jobs n] [--fresh]
//
// Each song needs a performance export (`performance-export`: its mix and
// section timing). A song's `performance` key names one; otherwise the song
// is exported into ~/.cache/cycletron/performance, again whenever its file
// changes, or with `--fresh`.
//
// `--song n` renders only the nth song (from 1); `--section label` only that
// section (the first song that has it); `--from`/`--to` trim, in seconds of
// what's rendered. `--size` and `--fps` override the show's, for quick looks
// (`--size 960x540 --fps 30`); `--out` overrides its `out`.
//
// `--jobs` renders that many chunks at once, each in its own browser, and
// joins them losslessly; every frame replays from its song's start, so the
// result matches one job bit for bit (trail modes may differ by one level on
// a few pixels for a moment after a seam).

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {availableParallelism, homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(UI, '..');
const CACHE = path.join(homedir(), '.cache', 'cycletron', 'performance');

const args = process.argv.slice(2);
const flags = {
    out: '', song: '', section: '', from: '', to: '', size: '', fps: '', fresh: false,
    // Rendering saturates the CPU at about eight jobs on a 14-core machine; more only contend.
    jobs: String(Math.max(1, Math.min(8, availableParallelism() - 2))),
};
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].slice(2);
        if (!(key in flags)) throw new Error(`unknown flag --${key}`);
        flags[key] = typeof flags[key] === 'boolean' ? true : args[++i];
    } else positional.push(args[i]);
}
if (positional.length !== 1) {
    console.error('usage: render-viz.mjs <show.toml> [--out video.mp4] [--song n] [--section label] [--from s] [--to s] [--size WxH] [--fps n] [--jobs n] [--fresh]');
    process.exit(2);
}
const showPath = path.resolve(positional[0]);

const server = await createServer({root: UI, mode: 'render', logLevel: 'error', server: {port: 0}});
let parts = null;
try {
    await server.listen();
    await main();
} finally {
    if (parts) await rm(parts, {recursive: true, force: true});
    await server.close();
}

async function main() {
    const {parseShow, cue, ShowError} = await server.ssrLoadModule('/src/show/show.ts');
    const {VIZ_MODES} = await server.ssrLoadModule('/src/viz/registry.ts');
    const ctx = {dir: path.dirname(showPath), home: homedir(), modes: VIZ_MODES.map((m) => m.id)};
    let show;
    try {
        show = parseShow(await readFile(showPath, 'utf8'), ctx);
    } catch (e) {
        if (e instanceof ShowError) fail(`${path.basename(showPath)}${e.line ? `:${e.line}` : ''}: ${e.message}`);
        throw e;
    }

    const outPath = flags.out ? path.resolve(flags.out) : show.out;
    if (!outPath) fail('no output: give the show an `out` in [show], or pass --out');
    const fps = flags.fps ? Number(flags.fps) : (show.fps ?? 60);
    const [width, height] = flags.size ? flags.size.split('x').map(Number) : [show.size?.width ?? 1920, show.size?.height ?? 1080];
    if (!(fps > 0) || !(width > 0) || !(height > 0)) fail('--fps and --size need positive numbers (--size 1920x1080)');

    let songs = show.songs;
    if (flags.song) {
        const n = Number(flags.song);
        if (!Number.isInteger(n) || n < 1 || n > songs.length) fail(`--song: 1 to ${songs.length}, not ${flags.song}`);
        songs = [songs[n - 1]];
    }

    // Each song on the timeline: its export, its cues, and where its frames fall.
    const timeline = [];
    let frame = 0;
    for (const song of songs) {
        const dir = song.performance ?? await exported(song);
        const performance = JSON.parse(await readFile(path.join(dir, 'performance.json'), 'utf8'));
        const form = performance.sections.map((s) => ({
            label: s.label,
            startCycle: Math.round(s.start_ns / performance.cycle_ns),
            cycles: Math.round((s.end_ns - s.start_ns) / performance.cycle_ns),
        }));
        let cues;
        try {
            cues = cue(song, form);
        } catch (e) {
            if (e instanceof ShowError) fail(`${path.basename(showPath)}: ${e.message}`);
            throw e;
        }
        const frames = Math.round((performance.duration_ns / 1e9) * fps);
        timeline.push({song, dir, performance, cues, start: frame, frames});
        frame += frames;
    }

    // What's rendered, in timeline frames.
    let first = 0;
    let last = frame;
    if (flags.section) {
        const at = timeline.find((t) => t.cues.some((c) => c.label === flags.section));
        if (!at) fail(`--section: no song here has a section '${flags.section}'`);
        const c = at.cues.find((c) => c.label === flags.section);
        const cycle = at.performance.cycle_ns / 1e9;
        first = at.start + Math.round(c.startCycle * cycle * fps);
        last = at.start + Math.round((c.startCycle + c.cycles) * cycle * fps);
    }
    const span = last - first;
    if (flags.to) last = Math.min(last, first + Math.round(Number(flags.to) * fps));
    if (flags.from) first += Math.round(Number(flags.from) * fps);
    if (!(last > first)) fail(`nothing to render: --from/--to leave no frames of the ${(span / fps).toFixed(1)}s`);
    const frames = last - first;

    // Chunks of at least a second (each pays a browser launch and a warm-up),
    // never across a song: a song renders from its own start.
    const jobs = Math.max(1, Number(flags.jobs));
    const size = Math.max(fps, Math.ceil(frames / jobs));
    const chunks = [];
    for (const t of timeline) {
        const from = Math.max(first, t.start) - t.start;
        const to = Math.min(last, t.start + t.frames) - t.start;
        for (let at = from; at < to; at += size) chunks.push({t, start: at, count: Math.min(size, to - at)});
    }
    const playing = [...new Set(chunks.map((c) => c.t))];

    const url = new URL('viz-render.html', server.resolvedUrls.local[0]).href;
    await mkdir(path.dirname(outPath), {recursive: true});
    parts = await mkdtemp(path.join(path.dirname(outPath), '.render-viz-'));
    const label = playing.length === 1 ? path.basename(playing[0].song.source, '.strudel') : `${playing.length} songs`;
    const progress = {done: 0, frames, label, fps};
    const started = Date.now();
    let failure = null;
    let next = 0;
    // A pool of `jobs` browsers; one failure stops the rest.
    await Promise.allSettled(Array.from({length: Math.min(jobs, chunks.length)}, async () => {
        while (next < chunks.length && !failure) {
            const k = next++;
            await renderChunk(chunks[k], chunkPath(k), {url, width, height, fps, progress, failed: () => failure})
                .catch((e) => {
                    failure ??= e;
                });
        }
    }));
    if (failure) throw failure;

    const list = path.join(parts, 'parts.txt');
    await writeFile(list, chunks.map((_, k) => `file '${chunkPath(k)}'\n`).join(''));
    // Each song's mix trimmed to exactly its rendered frames, so the songs stay in sync.
    const audio = playing.map((t, i) => {
        const from = (Math.max(first, t.start) - t.start) / fps;
        const to = (Math.min(last, t.start + t.frames) - t.start) / fps;
        return `[${i + 1}:a]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS,volume=${t.song.gainDb}dB,`
            + `aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`;
    });
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', list,
        ...playing.flatMap((t) => ['-i', path.join(t.dir, t.performance.audio)]),
        '-filter_complex', `${audio.join(';')};${playing.map((_, i) => `[a${i}]`).join('')}concat=n=${playing.length}:v=0:a=1[a]`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
        outPath,
    ]);
    console.error(`\n${label}: ${frames} frames → ${outPath} in ${((Date.now() - started) / 1000).toFixed(1)}s (${jobs} jobs)`);
}

/** The song's performance export from the cache, exported first when its file has changed (or `--fresh`). */
async function exported(song) {
    const text = await readFile(song.source).catch(() => fail(`can't read ${song.source}`));
    const key = createHash('sha1').update(text).update(`passes=${song.passes}`).digest('hex').slice(0, 16);
    const dir = path.join(CACHE, `${path.basename(song.source, '.strudel')}-${key}`);
    const ready = await access(path.join(dir, 'performance.json')).then(() => true, () => false);
    if (ready && !flags.fresh) return dir;
    await mkdir(dir, {recursive: true});
    console.error(`exporting ${path.basename(song.source)}…`);
    await run('cargo', [
        'run', '--release', '-q', '-p', 'performance-export', '--',
        song.source, dir, '--passes', String(song.passes),
    ], REPO);
    return dir;
}

/** Render `chunk.count` frames of its song from song frame `chunk.start` to a video-only part. */
async function renderChunk({t, start, count}, out, {url, width, height, fps, progress, failed}) {
    const browser = await chromium.launch();
    let ffmpeg = null;
    try {
        const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
        page.on('pageerror', (e) => console.error('[page]', e.message));
        const mix = path.join(t.dir, t.performance.audio);
        await page.route('**/__render/mix.wav', (route) => route.fulfill({path: mix, contentType: 'audio/wav'}));
        await page.goto(url);
        await page.waitForFunction(() => 'vizRender' in window);
        await page.evaluate((opts) => window.vizRender.setup(opts), {
            code: t.performance.code, bpm: t.performance.bpm, cues: t.cues, song: {passes: t.song.passes, fade: t.song.fade},
            width, height, fps,
            startFrame: start, sensitivity: t.song.sensitivity, audio: '/__render/mix.wav',
        });

        ffmpeg = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
            // veryfast, not medium: a quarter less render time with every core busy, for a
            // slightly lower-quality encode at crf 16 — fine for video that is re-encoded on upload.
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
            out,
        ], {stdio: ['pipe', 'inherit', 'inherit']});
        const encoded = exited(ffmpeg);
        // Awaited below on success; on a failure the frame loop's error is the one to report.
        encoded.catch(() => {});
        // An early ffmpeg exit surfaces through `encoded`, not as EPIPE on the next write.
        ffmpeg.stdin.on('error', () => {});
        for (let i = 0; i < count; i++) {
            const failure = failed();
            if (failure) throw failure;
            const png = Buffer.from(await page.evaluate(() => window.vizRender.frame()), 'base64');
            if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
            if (++progress.done % fps === 0) {
                process.stderr.write(`\r${progress.label}: ${(progress.done / fps).toFixed(0)}/${(progress.frames / fps).toFixed(0)}s`);
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

function run(cmd, argv, cwd) {
    return exited(spawn(cmd, argv, {cwd, stdio: ['ignore', 'inherit', 'inherit']}));
}

function exited(child) {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${child.spawnfile} exited ${c}`))));
    });
}

function fail(message) {
    console.error(`render-viz: ${message}`);
    process.exit(1);
}
