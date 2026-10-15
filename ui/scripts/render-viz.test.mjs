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
const SECTIONS = [{label: 'one', at: 0, end: 3}, {label: 'two', at: 3, end: SECONDS}];
const KICKS = Array.from({length: SECONDS * 2}, (_, i) => i / 2);

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
async function render(cuts, startFrame, count) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({viewport: {width: 480, height: 270}, deviceScaleFactor: 1});
        await page.route('**/__render/mix.wav', (route) => route.fulfill({body: WAV, contentType: 'audio/wav'}));
        await page.goto(url);
        await page.waitForFunction(() => 'vizRender' in window);
        await page.evaluate((opts) => window.vizRender.setup(opts), {
            code: CODE, bpm: BPM, cuts, width: 480, height: 270, fps: FPS, startFrame,
            sensitivity: 1, audio: '/__render/mix.wav', code_follow: 'solo',
            sections: SECTIONS, kicks: KICKS, camera: true, titles: true,
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

async function assertSeamless(cuts, chunkAt) {
    const total = SECONDS * FPS;
    const from = chunkAt * FPS;
    const [whole, chunk] = await Promise.all([render(cuts, 0, total), render(cuts, from, total - from)]);
    const differing = chunk.flatMap((h, i) => (h === whole[from + i] ? [] : [from + i]));
    assert.deepEqual(differing, [], `frames that differ from the continuous render`);
}

test('a chunk across a cut, a title card and the camera matches the continuous render', () =>
    assertSeamless([{at: 0, mode: 'tunnel'}, {at: 3, mode: 'kaleidoscope'}], 2.5));

test('a trail mode matches once its preroll has painted the smear', () =>
    assertSeamless([{at: 0, mode: 'lissajous'}], 4));

test('every mode matches the continuous render across a chunk seam', async () => {
    const {VIZ_MODES} = await server.ssrLoadModule('/src/viz/registry.ts');
    const failing = {};
    const ids = VIZ_MODES.map((m) => m.id);
    // A few browsers at a time: each render is one.
    for (let i = 0; i < ids.length; i += 3) {
        await Promise.all(ids.slice(i, i + 3).map(async (id) => {
            try {
                await assertSeamless([{at: 0, mode: id}], 4);
            } catch (e) {
                failing[id] = e.message.split('\n')[0];
            }
        }));
    }
    assert.deepEqual(failing, {});
});
