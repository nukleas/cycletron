/**
 * The offline renderer's chunking contract: a render that starts mid-song
 * (as each `render-viz.mjs --jobs` chunk does) paints the same pixels as one
 * that ran from the start. Headless Chromium, a synthetic mix, small frames.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const FPS = 30;
const BPM = 120;
const SECONDS = 6;
const CODE = 'stack(s("bd*4"), s("~ sd ~ sd").gain(0.5), note("c3 e3 g3 b3").s("sawtooth").gain(0.3))';
const CAMERA = {move: 'drift', punch: 1, kick: 1};

const LOOK = {
    code: {follow: 'solo', size: null, place: 'left', opacity: 1, scrim: true, type: null}, camera: CAMERA, titles: true, title: null, shots: null, every: 4, transition: {kind: 'cut', bars: 0},
    palette: 'neon', letterbox: null, grain: 0, scanlines: true, strobe: null, speed: 1, text: [],
};

/** The song as two sections of 1.5 cycles (3 s), showing `one` then `two`, cards and camera on. */
function cues(one, two = one) {
    return [
        {label: 'one', startCycle: 0, cycles: 1.5, look: {...LOOK, mode: one}},
        {label: 'two', startCycle: 1.5, cycles: 1.5, look: {...LOOK, mode: two}},
    ];
}

let server;
let url;
before(async () => {
    server = await createServer({root: fileURLToPath(new URL('..', import.meta.url)), mode: 'render', logLevel: 'error', server: {port: 0}});
    await server.listen();
    url = new URL('viz-render.html', server.resolvedUrls.local[0]).href;
});
after(() => server?.close());

/** A kick on every beat: a decaying 55 Hz sine, 16-bit mono WAV. */
function mix() {
    const rate = 44_100;
    const samples = new Int16Array(rate * SECONDS);
    for (let i = 0; i < samples.length; i++) {
        const t = (i / rate) % 0.5;
        samples[i] = Math.round(Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 12) * 20_000);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + samples.byteLength, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples.byteLength, 40);
    return Buffer.concat([header, Buffer.from(samples.buffer)]);
}
const WAV = mix();

/** Hashes of `count` frames rendered from song frame `startFrame`. */
async function render(song, startFrame, count, fade = {in: 0, out: 0}) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({viewport: {width: 480, height: 270}, deviceScaleFactor: 1});
        await page.route('**/__render/mix.wav', (route) => route.fulfill({body: WAV, contentType: 'audio/wav'}));
        await page.goto(url);
        await page.waitForFunction(() => 'vizRender' in window);
        await page.evaluate((opts) => window.vizRender.setup(opts), {
            code: CODE, bpm: BPM, cues: song, song: {passes: 1, fade}, width: 480, height: 270, fps: FPS, startFrame,
            sensitivity: 1, audio: '/__render/mix.wav',
        });
        const hashes = [];
        for (let i = 0; i < count; i++) {
            hashes.push(createHash('sha1').update(await page.evaluate(() => window.vizRender.frame())).digest('hex'));
        }
        return hashes;
    } finally {
        await browser.close();
    }
}

async function assertSeamless(song, chunkAt, fade) {
    const total = SECONDS * FPS;
    const from = chunkAt * FPS;
    const [whole, chunk] = await Promise.all([render(song, 0, total, fade), render(song, from, total - from, fade)]);
    const differing = chunk.flatMap((h, i) => (h === whole[from + i] ? [] : [from + i]));
    assert.deepEqual(differing, [], `frames that differ from the continuous render`);
}

test('a chunk across a cut, a title card and the camera matches the continuous render', () =>
    assertSeamless(cues('tunnel', 'kaleidoscope'), 2.5));

test('a chunk starting mid-fade, and mid-glitch, in palettes and grain, matches the continuous render', async () => {
    // Shots every half bar (1 s): faded in over a bar in `one`, glitched in `two`.
    const song = cues('tunnel', 'plasma');
    song[0].look = {...song[0].look, shots: [{mode: 'tunnel', bars: null}, {mode: 'kaleidoscope', bars: null, palette: 'ice'}],
        every: 0.5, transition: {kind: 'fade', bars: 0.4}, palette: 'amber', scanlines: false};
    song[1].look = {...song[1].look, shots: [{mode: 'plasma', bars: null}, {mode: 'spot-field', bars: null}], every: 0.5,
        transition: {kind: 'glitch', bars: 0.25}, palette: 'vapor', grain: 0.6, letterbox: 2.39,
        code: {follow: 'fold', size: 36, place: 'right', opacity: 0.7, scrim: false, type: 0.75}};
    // 1.2 s is 0.1 bar into the second shot's fade; 3.1 s is inside `two`'s first glitch.
    await assertSeamless(song, 1.2);
    await assertSeamless(song, 3.1);
});

test('strobe, speed, captions and the song fading in and out match the continuous render', async () => {
    const song = cues('tunnel', 'plasma');
    song[0].look = {...song[0].look, strobe: {on: 'kick', strength: 0.6}, speed: 0.5,
        text: [{say: 'one', at: 0.25, hold: 1, place: 'bottom'}]};
    song[1].look = {...song[1].look, strobe: {on: 'beat', strength: 0.4}, speed: 2,
        text: [{say: 'and two', at: 0, hold: 0.5, place: 'center'}]};
    // Fading up over the first bar and down over the last; chunks inside each.
    await assertSeamless(song, 1, {in: 1, out: 1});
    await assertSeamless(song, 5, {in: 1, out: 1});
});

test('a trail mode matches once its preroll has painted the smear', () =>
    assertSeamless(cues('lissajous'), 4));

test('every mode matches the continuous render across a chunk seam', async () => {
    const {VIZ_MODES} = await server.ssrLoadModule('/src/viz/registry.ts');
    const failing = {};
    const ids = VIZ_MODES.map((m) => m.id);
    // A few browsers at a time: each render is one.
    for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(ids.slice(i, i + 3).map(async (id) => {
            try {
                await assertSeamless(cues(id), 4);
            } catch (e) {
                failing[id] = e.message.split('\n')[0];
            }
        }));
    }
    assert.deepEqual(failing, {});
});
