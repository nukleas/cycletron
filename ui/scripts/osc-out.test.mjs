/**
 * OSC onset scan: every hap that starts during playback goes out once, even
 * when it falls in the last frame of a bar or while a send is still in
 * flight. A fake cycle-view buffer and a fake Tauri invoke stand in for the
 * engine and the socket; no audio, no WASM.
 */
import assert from 'node:assert/strict';
import {after, beforeEach, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

// tauri.ts reads this at import time to decide it is running in the app.
const sends = [];
let hold = false;
let release = [];
globalThis.window = {
    __TAURI__: {
        core: {
            invoke(cmd, args) {
                if (cmd === 'osc_configure') return Promise.resolve({enabled: true, target: '127.0.0.1:57120'});
                if (cmd !== 'osc_frame') return Promise.resolve(null);
                sends.push(args);
                // A held send stays in flight until the test lets it land.
                return hold ? new Promise(resolve => release.push(resolve)) : Promise.resolve(null);
            },
        },
    },
};
globalThis.localStorage = {getItem: () => null, setItem: () => {}};

const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null},
    optimizeDeps: {noDiscovery: true, include: []},
});
after(() => server.close());
const {oscOut} = await server.ssrLoadModule('/src/osc-out.ts');

/** One track, `hh`, whose haps start at `begins` (fractions of a bar) every bar. */
function source(begins) {
    const memory = new WebAssembly.Memory({initial: 1});
    const pattern = {
        queryCycleViewData() {
            const data = new Float32Array(memory.buffer, 0, 4096);
            data.set([1, 1, 0, 0, begins.length]);
            begins.forEach((b, i) => data.set([b, b + 0.01, 60], 5 + i * 3));
        },
        getTrackName: () => 'hh',
    };
    return {scheduler: {pattern}, memory, cycleViewPtr: 0};
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const sent = () => sends.reduce((n, s) => n + s.haps.length, 0);

/** Play `bars` bars at 60 fps and cps 0.5, letting each send land unless held. */
async function play(bars, onFrame = () => {}) {
    const step = 0.5 / 60;
    for (let f = 0, cycle = 0.0001; cycle < bars; f++, cycle += step) {
        oscOut.frame(cycle);
        onFrame(f);
        await settle();
    }
}

beforeEach(async () => {
    sends.length = 0;
    hold = false;
    release = [];
    await oscOut.apply({enabled: true, host: '127.0.0.1', port: 57120});
});

test('sends every hap of a steady pattern once', async () => {
    oscOut.attach(source(Array.from({length: 16}, (_, i) => i / 16)));
    await play(8);
    assert.equal(sent(), 16 * 8);
});

test('a hap in the last frame of a bar still goes out', async () => {
    oscOut.attach(source([0.995]));
    await play(8);
    oscOut.frame(8.0001);
    await settle();
    assert.equal(sent(), 8);
});

test('haps found while a send is in flight go out with the next one', async () => {
    oscOut.attach(source(Array.from({length: 16}, (_, i) => i / 16)));
    hold = true;
    // Each send takes three frames to land.
    await play(4, f => {
        if (f % 3 === 2) release.splice(0).forEach(resolve => resolve(null));
    });
    release.splice(0).forEach(resolve => resolve(null));
    await settle();
    oscOut.frame(4.0001);
    await settle();
    // Four bars, plus the downbeat of the fifth that the last frame crossed.
    assert.equal(sent(), 16 * 4 + 1);
});
