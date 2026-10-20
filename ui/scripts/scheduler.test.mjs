/**
 * Song swaps in the scheduler: the outgoing song plays exactly to the
 * boundary, the incoming one starts at its own cycle 0 and tempo there, and
 * the UI reports the switch when the downbeat is heard. A fake audio clock
 * and processor record what was queried; no audio, no WASM.
 */
import assert from 'node:assert/strict';
import {after, afterEach, beforeEach, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null},
    optimizeDeps: {noDiscovery: true, include: []},
});
after(() => server.close());
const {PatternScheduler} = await server.ssrLoadModule('/scheduler.ts');

// The UI loop is driven by hand.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const pattern = (name) => ({name, freed: false, free() { this.freed = true; }});

let clock;
let processor;
let scheduler;
let ui;
let started;
beforeEach(() => {
    clock = {currentTime: 0};
    processor = {
        pattern: null,
        startTime: 0,
        queries: [],
        setPattern(p) { this.pattern = p; },
        setStartTime(t) { this.startTime = t; },
        clearPattern() { this.pattern = null; },
        queryEventsPacked(from, to, cps) { this.queries.push({song: this.pattern.name, from, to, cps, startTime: this.startTime}); },
    };
    scheduler = new PatternScheduler(processor, clock);
    ui = [];
    started = 0;
    scheduler.onCycleUpdate = (c) => ui.push(c);
    scheduler.onSongStarted = () => started++;
});

// A failed assertion must not leave the tick timer holding the process open.
afterEach(() => scheduler.stop());

/** Advance the audio clock to `t` seconds and run a scheduling tick. */
function at(t) {
    clock.currentTime = t;
    scheduler.scheduleTick();
}

test('the next song starts at its cycle 0 and tempo, exactly on the boundary', () => {
    scheduler.setBpm(120); // 0.5 cycles per second
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    for (let t = 0.1; t < 6; t += 0.1) at(t);
    // At 5.9 s the song is at cycle 2.95: arm the next one for cycle 4 (8 s).
    scheduler.setPatternAt(pattern('two'), 4, 150);
    for (let t = 6; t < 9; t += 0.1) at(t);
    scheduler.stop();

    const one = processor.queries.filter((q) => q.song === 'one');
    const two = processor.queries.filter((q) => q.song === 'two');
    assert.equal(Math.max(...one.map((q) => q.to)), 4, 'song one is queried exactly to the boundary');
    assert.ok(one.every((q) => q.cps === 0.5));
    assert.equal(two[0].from, 0, 'song two starts at its cycle 0');
    assert.ok(two.every((q) => q.cps === 150 / 240 && Math.abs(q.startTime - 8) < 1e-9), 'at its tempo, anchored on the downbeat');
    // Contiguous: no gap and no overlap in either song.
    for (const runs of [one, two]) {
        for (let i = 1; i < runs.length; i++) assert.ok(Math.abs(runs[i].from - runs[i - 1].to) < 1e-9);
    }
    assert.equal(scheduler.tempo.bpm, 150);
});

test('the UI reports the outgoing song until the downbeat is heard', () => {
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    scheduler.setPatternAt(pattern('two'), 4, 120);
    at(7.95); // installs: the lookahead reaches cycle 4
    const frame = (t) => {
        clock.currentTime = t;
        ui.length = 0;
        scheduler.updateUI();
        return ui[0];
    };
    assert.ok(Math.abs(frame(7.96) - 3.98) < 1e-9, 'still song one, near its end');
    assert.equal(started, 0);
    assert.ok(Math.abs(frame(8.2) - 0.1) < 1e-9, 'song two, from its cycle 0');
    assert.equal(started, 1);
    scheduler.stop();
});

test('an edit to the outgoing song applies now and keeps the next song armed', () => {
    scheduler.launchQuantum = 1;
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    const two = pattern('two');
    scheduler.setPatternAt(two, 4, 120);
    assert.equal(scheduler.setPatternQuantized(pattern('one-edited'), 120), false);
    assert.equal(processor.pattern.name, 'one-edited');
    for (let t = 1.1; t < 8.5; t += 0.1) at(t);
    assert.equal(processor.pattern, two, 'song two still lands');
    assert.equal(two.freed, false);
    scheduler.stop();
});

test('pausing or seeking while a song is armed keeps the playing song and disarms the next', () => {
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(3);
    const two = pattern('two');
    scheduler.setPatternAt(two, 4, 90);
    assert.equal(scheduler.songPending, true);
    clock.currentTime = 3.5;
    scheduler.pause();
    assert.equal(processor.pattern.name, 'one');
    assert.equal(two.freed, true);
    assert.equal(scheduler.songPending, false);
    assert.equal(scheduler.tempo.bpm, 120);

    scheduler.resume();
    const three = pattern('three');
    scheduler.setPatternAt(three, 4, 90);
    scheduler.seekTo(0.5);
    assert.equal(processor.pattern.name, 'one');
    assert.equal(three.freed, true);
    assert.equal(started, 0);
});

test('a song can be cancelled while armed, but not once it is landing', () => {
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    scheduler.setPatternAt(pattern('two'), 4, 120);
    assert.equal(scheduler.cancelSong(), true);
    assert.equal(scheduler.songPending, false);
    assert.equal(scheduler.cancelSong(), false, 'nothing armed');

    scheduler.setPatternAt(pattern('three'), 4, 120);
    at(7.95); // installed; heard at 8 s
    assert.equal(scheduler.songPending, true);
    assert.equal(scheduler.cancelSong(), false);
    assert.equal(processor.pattern.name, 'three');
});

test('an edit landing between install and downbeat is dropped, not swapped over the next song', () => {
    scheduler.launchQuantum = 1;
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    scheduler.setPatternAt(pattern('two'), 4, 150);
    at(7.95); // installed; heard at 8 s
    const late = pattern('one-late');
    assert.equal(scheduler.setPatternQuantized(late, 120), true, 'side effects deferred, never applied');
    assert.equal(late.freed, true);
    assert.equal(processor.pattern.name, 'two');
    assert.equal(scheduler.tempo.bpm, 150);
});

test('arming a song lands a quantized edit that is still waiting', () => {
    scheduler.launchQuantum = 8;
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    const edit = pattern('one-edited');
    assert.equal(scheduler.setPatternQuantized(edit, 120), true);
    scheduler.setPatternAt(pattern('two'), 4, 120);
    assert.equal(processor.pattern, edit);
    assert.equal(edit.freed, false);
});

test('pausing between install and downbeat commits to the next song', () => {
    scheduler.setBpm(120);
    scheduler.setPattern(pattern('one'));
    scheduler.start();
    at(1);
    scheduler.setPatternAt(pattern('two'), 4, 120);
    at(7.95);
    scheduler.pause();
    assert.equal(started, 1);
    assert.equal(scheduler.cycle, 0);
    assert.equal(scheduler.songPending, false);
});
