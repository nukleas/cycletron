/** Schedule regressions against the committed WASM, without an audio device or canvas. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {getCycleViewBufPtr, initSync, parsePattern} from '../pkg/strudel_audio_wasm.js';

// Use the application's TS resolver; no extra test compiler or dependencies.
const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null},
    optimizeDeps: {noDiscovery: true, include: []},
});
after(() => server.close());
const {TrackModel, MAX_EVENTS_PER_TRACK} = await server.ssrLoadModule('/src/viz/tracks.ts');
const {defaultTheme} = await server.ssrLoadModule('/src/viz/theme.ts');
const {isoCityDef} = await server.ssrLoadModule('/src/viz/modes/iso-city.ts');
const {neonCircuitDef} = await server.ssrLoadModule('/src/viz/modes/neon-circuit.ts');
const {plasmaDef} = await server.ssrLoadModule('/src/viz/modes/plasma.ts');
const {memory} = initSync({
    module: readFileSync(new URL('../pkg/strudel_audio_wasm_bg.wasm', import.meta.url)),
});
const theme = defaultTheme();

// Only the circuit's tempo accessor needs a browser global.
globalThis.window = {strudelApp: {scheduler: {tempo: {bpm: 120}}}};
after(() => { delete globalThis.window; });

function fixture(t, code) {
    const source = {scheduler: {pattern: null}, memory, cycleViewPtr: getCycleViewBufPtr()};
    function edit(next) {
        const old = source.scheduler.pattern;
        source.scheduler.pattern = next === null ? null : parsePattern(next);
        old?.free();
    }
    edit(code);
    t.after(() => source.scheduler.pattern?.free());
    const services = {
        width: 1280, height: 720, dpr: 1, theme, cycle: 0,
        low: 0, mid: 0, high: 0, freqData: null, timeData: null,
        sampleRate: 48000, sensitivity: 1, patternSource: source,
    };
    return {source, services, edit};
}

function onsets(model, source, cycle) {
    const result = [];
    model.forEachOnset(model.sync(source, cycle, theme), (track, e) => {
        result.push([track.name, track.begins[e], track.notes[e]]);
    });
    return result;
}

function events(track, bar) {
    const result = [];
    for (let e = 0; e < track.count; e++) {
        if (Math.floor(track.begins[e]) === bar) result.push([track.begins[e] - bar, track.notes[e]]);
    }
    return result;
}

test('start, live edit at zero, stop/restart and bar boundaries fire each downbeat once', (t) => {
    const {source, edit} = fixture(t, 's("bd*4")');
    const model = new TrackModel(2);
    assert.equal(onsets(model, source, 0).length, 1);
    assert.equal(onsets(model, source, 0).length, 0);
    edit('s("bd*4")');
    assert.equal(onsets(model, source, 0).length, 0);
    assert.equal(onsets(model, source, 0.249).length, 0);
    assert.equal(onsets(model, source, 0.251).length, 1);
    onsets(model, source, 0.99);
    assert.equal(onsets(model, source, 1.001).length, 1);
    assert.equal(onsets(model, source, 1.001).length, 0);
    edit(null);
    assert.equal(onsets(model, source, 0).length, 0);
    edit('s("bd*4")');
    assert.equal(onsets(model, source, 0).length, 1);
});

test('mid-bar entry, live edits and long seeks do not replay past onsets', (t) => {
    const {source, edit} = fixture(t, 's("bd*4")');
    const model = new TrackModel();
    assert.equal(onsets(model, source, 0.76).length, 0);
    edit('s("bd*4")');
    assert.equal(onsets(model, source, 0.76).length, 0);
    assert.equal(onsets(model, source, 3.76).length, 0);
    assert.equal(onsets(model, source, 1.76).length, 0);
    assert.equal(onsets(model, source, 2.001).length, 1);
});

test('an edit preserves the onset crossed since the last frame', (t) => {
    const {source, edit} = fixture(t, 's("bd*4")');
    const model = new TrackModel();
    onsets(model, source, 0.24);
    edit('s("bd*4")');
    assert.equal(onsets(model, source, 0.26).length, 1);
});

test('lookahead keeps both stacked voices and reserves a full budget per bar', (t) => {
    const {source} = fixture(t, 'stack(note("c4*32").s("sine"), note("g4*32").s("sine"))');
    const single = new TrackModel();
    const ahead = new TrackModel(2);
    single.sync(source, 0, theme);
    ahead.sync(source, 0, theme);
    assert.equal(single.tracks[0].count, MAX_EVENTS_PER_TRACK);
    assert.equal(ahead.tracks[0].count, MAX_EVENTS_PER_TRACK * 2);
    assert.deepEqual(events(ahead.tracks[0], 0), events(single.tracks[0], 0));
    assert.deepEqual(events(ahead.tracks[0], 1), events(single.tracks[0], 0));
    assert.equal(onsets(ahead, source, 0.99).length, 62); // two downbeat notes already crossed
});

test('future events cannot consume the current bar of the shared WASM buffer', (t) => {
    // 768 events fit one query; 1536 exceed the engine's 1024-event scratch.
    const code = `stack(${Array.from({length: 12}, (_, i) => `s("budget${i}*64")`).join(',')})`;
    const {source} = fixture(t, code);
    const single = new TrackModel();
    const ahead = new TrackModel(2);
    single.sync(source, 0, theme);
    ahead.sync(source, 0, theme);
    assert.equal(single.tracks.length, 12);
    assert.equal(ahead.tracks.length, 12);
    for (const track of single.tracks) {
        const next = ahead.tracks.find((t) => t.name === track.name);
        assert.deepEqual(events(next, 0), events(track, 0));
        assert.equal(next.count, MAX_EVENTS_PER_TRACK);
    }
});

test('a held note is not duplicated at the start of the lookahead bar', (t) => {
    const {source} = fixture(t, 'note("c4").s("sine").slow(4)');
    const model = new TrackModel(2);
    model.sync(source, 0, theme);
    assert.equal(model.tracks[0].count, 1);
    assert.equal(model.tracks[0].ends[0], 2);
    model.sync(source, 1, theme);
    assert.equal(model.tracks[0].count, 1);
});

test('ISO CITY uses the same onset window and emits no traffic on a same-phase edit', (t) => {
    const {services, edit} = fixture(t, 's("bd*4")');
    const city = isoCityDef.create();
    city.layout(services);
    city.update(0, services);
    assert.equal(city.trafficCount, 4);
    services.cycle = 0.76;
    city.update(0, services);
    const before = city.trafficCount;
    edit('s("bd*4")');
    city.update(0, services);
    assert.equal(city.trafficCount, before);
    services.cycle = 1.001;
    city.update(0, services);
    assert.equal(city.trafficCount, before + 4);
});

test('NEON CIRCUIT reconciles package geometry and metal/epoxy lighting on edits', (t) => {
    const {services, edit} = fixture(t, 'note("c2").s("sawtooth")');
    const circuit = neonCircuitDef.create();
    circuit.layout(services);
    circuit.update(1 / 60, services);
    const part = circuit.parts[0];
    assert.equal(part.kind, 'to220');
    const bassWidth = part.w;
    edit('note("c5").s("sawtooth")');
    circuit.update(0, services);
    assert.equal(circuit.parts[0], part);
    assert.equal(part.kind, 'dip');
    assert.ok(part.w > bassWidth);
    const epoxy = part.faces.top.slice();
    edit('s("sawtooth")');
    circuit.update(0, services);
    assert.equal(part.kind, 'xtal');
    assert.notDeepEqual(part.faces.top, epoxy);
    edit('note("c5").s("sawtooth")');
    circuit.update(0, services);
    assert.equal(part.kind, 'dip');
    assert.deepEqual(part.faces.top, epoxy);
});

test('NEON CIRCUIT keeps a pitched part\'s package through a resting bar', (t) => {
    const {services} = fixture(t, 'note("<c5 ~ ~>").s("sawtooth")');
    const circuit = neonCircuitDef.create();
    circuit.layout(services);
    circuit.update(1 / 60, services);
    const part = circuit.parts[0];
    assert.equal(part.kind, 'dip');
    // Bar 1 and the look-ahead bar 2 are both rests: no notes to judge by.
    services.cycle = 1.5;
    circuit.update(1 / 60, services);
    assert.equal(circuit.parts[0], part);
    assert.equal(part.kind, 'dip');
});

const plasmaPart = (i) => `note("${i === 8 ? 'c5*4' : 'c2'}").s("part${i}")`
    + `.color("#${(0x110000 + i * 0x181819).toString(16).padStart(6, '0')}")`;
const nineParts = `stack(${Array.from({length: 9}, (_, i) => plasmaPart(i)).join(',')})`;

test('PLASMA keeps eight distinct owners and stable palettes under overflow', (t) => {
    const {services} = fixture(t, nineParts);
    const plasma = plasmaDef.create();
    plasma.layout(services);
    plasma.update(1 / 60, services);
    const owners = plasma.ballTrack.slice();
    const bassTarget = plasma.pitchTarget[0];
    assert.ok(bassTarget < 0);
    assert.equal(new Set(owners).size, 8);
    assert.deepEqual(owners.map((t) => t.name), Array.from({length: 8}, (_, i) => `part${i}`));
    let paletteWrites = 0;
    plasma.midCss = new Proxy(plasma.midCss, {
        set(target, key, value) { paletteWrites++; target[key] = value; return true; },
    });
    for (let frame = 1; frame <= 60; frame++) {
        services.cycle = frame / 120;
        plasma.update(1 / 60, services);
    }
    assert.deepEqual(plasma.ballTrack, owners);
    assert.equal(paletteWrites, 0);
    // The overflow C5 onsets must not steer the first owner's C2 ball.
    assert.equal(plasma.pitchTarget[0], bassTarget);
});

test('PLASMA reuses faded vacancies after churn without aliasing lifetime slots', (t) => {
    const {services, edit} = fixture(t, nineParts);
    const plasma = plasmaDef.create();
    plasma.layout(services);
    plasma.update(1 / 60, services);
    const first = plasma.ballTrack[0];
    const bassTarget = plasma.pitchTarget[0];
    edit(`stack(${plasmaPart(0)}, ${plasmaPart(8)})`);
    for (let frame = 1; frame <= 480; frame++) {
        services.cycle = frame / 120;
        plasma.update(1 / 60, services);
    }
    const owners = plasma.ballTrack.filter(Boolean);
    assert.equal(owners.length, 2);
    assert.equal(plasma.ballTrack[0], first);
    const other = plasma.ballTrack.findIndex((t) => t?.name === 'part8');
    assert.ok(other > 0);
    assert.equal(plasma.pitchTarget[0], bassTarget);
    assert.ok(plasma.pitchTarget[other] > 0);
});
