/** Editor autocomplete: what the cursor's context offers. */
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {parser} from '@lezer/javascript';
import {EditorState} from '@codemirror/state';
import {CompletionContext} from '@codemirror/autocomplete';
import {javascript} from '@codemirror/lang-javascript';

const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null},
    optimizeDeps: {noDiscovery: true, include: []},
});
after(() => server.close());
// Outside Tauri: the catalog can't load, so sounds come from the static synth list.
globalThis.window = {};
after(() => { delete globalThis.window; });
console.warn = () => {};
const {spotAt} = await server.ssrLoadModule('/src/editor-spot.ts');
const {buildSoundOptions, strudelCompletionSource} = await server.ssrLoadModule('/src/editor-completions.ts');

/** `|` marks the cursor. */
function spot(src) {
    const pos = src.indexOf('|');
    const text = src.replace('|', '');
    return spotAt(parser.parse(text), (a, b) => text.slice(a, b), pos);
}

async function complete(src, explicit = false) {
    const pos = src.indexOf('|');
    const state = EditorState.create({doc: src.replace('|', ''), extensions: [javascript()]});
    const result = await strudelCompletionSource(new CompletionContext(state, pos, explicit));
    return result && result.options.map((o) => o.label);
}

test('a string argument knows its call', () => {
    assert.deepEqual(spot('s("bd s|")'), {kind: 'string', callee: 's', bank: null, from: 6, word: 's'});
    assert.equal(spot('note("c3 e|")').callee, 'note');
    assert.equal(spot('x.s(\'saw|').callee, 's');
    assert.equal(spot('stack(s(`b|`))').callee, 's');
    assert.equal(spot('s("bd").bank("Rol|').callee, 'bank');
});

test('an open string at the end of the text still counts', () => {
    assert.equal(spot('s("bd sd|').kind, 'string');
});

test('just past a closing quote is code', () => {
    assert.equal(spot('s("bd")|').kind, 'code');
});

test('the chain bank is found either side of the string', () => {
    assert.equal(spot('s("b|").bank("RolandTR909")').bank, 'RolandTR909');
    assert.equal(spot('s("bd").bank("RolandTR909").s("h|")').bank, 'RolandTR909');
    assert.equal(spot('stack(s("b|"), s("hh").bank("X"))').bank, null);
});

test('variant tokens keep the colon', () => {
    assert.equal(spot('s("bd:|")').word, 'bd:');
});

test('a dot means a method, across lines too', () => {
    assert.deepEqual(spot('s("bd").lp|'), {kind: 'code', member: true, from: 8});
    assert.equal(spot('s("bd")\n  .|').member, true);
    assert.equal(spot('st|').member, false);
    assert.equal(spot('x = 0.|').member, false);
});

test('comments offer nothing', () => {
    assert.equal(spot('// s(\n// st|').kind, 'none');
});

test('methods after a dot, functions at the top', async () => {
    const methods = await complete('s("bd").l|');
    assert.ok(methods.includes('lpf'));
    assert.ok(methods.includes('note'), 'note is a method too');
    assert.ok(!methods.includes('stack'));
    const top = await complete('st|');
    assert.ok(top.includes('stack'));
    assert.ok(!top.includes('lpf'));
});

test('only sound strings offer sounds', async () => {
    const sounds = await complete('s("sa|")');
    assert.ok(sounds.includes('sawtooth'));
    assert.ok(sounds.includes('saw'), 'saw is a signal and a synth');
    assert.equal(await complete('note("c|")'), null);
    assert.equal(await complete('n("0 2 4").scale("C4:m|")'), null);
});

const CATALOG = {
    activeSet: 'cycletron',
    byName: new Map(),
    counts: {},
    banks: [
        {name: 'bd', source: 'bundled', kind: 'one-shot', category: 'drums', group: 'Bundled', origin: 'Cycletron', count: 5, samples: [], auditionable: true},
        {name: 'RolandTR909_bd', source: 'bundled', kind: 'machine-voice', machine: 'RolandTR909', category: 'machines', group: 'RolandTR909', origin: 'Cycletron', count: 3, samples: [], auditionable: true},
        {name: 'RolandTR909_hh', source: 'bundled', kind: 'machine-voice', machine: 'RolandTR909', category: 'machines', group: 'RolandTR909', origin: 'Cycletron', count: 1, samples: [], auditionable: true},
        {name: 'harp', source: 'bundled', kind: 'pitched', category: 'pitched', group: 'Bundled', origin: 'VCSL', count: 6, samples: [], auditionable: true},
        {name: 'off', source: 'pack', kind: 'one-shot', category: 'packs', group: 'P', origin: 'p', count: 1, samples: [], auditionable: true, disabled: true},
    ],
};

test('machine voices go through .bank; full names rank last', () => {
    const o = buildSoundOptions(CATALOG);
    const names = o.banks.map((c) => c.label);
    assert.ok(names.includes('bd'));
    assert.equal(o.banks.find((c) => c.label === 'RolandTR909_bd').boost, -10);
    assert.ok(!names.includes('off'), 'disabled pack banks are left out');
    assert.deepEqual(o.machines.map((c) => c.label), ['RolandTR909']);
    assert.deepEqual(o.voices.get('RolandTR909').map((c) => c.label), ['bd', 'hh']);
    assert.equal(o.counts.get('RolandTR909_bd'), 3);
});

test('pitched banks have no :n variants', () => {
    const o = buildSoundOptions(CATALOG);
    assert.equal(o.counts.get('harp'), 0);
    assert.equal(o.banks.find((c) => c.label === 'harp').detail, 'Pitched');
});
