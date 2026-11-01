// node --test scripts/section-song.test.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compact, parseSections, parseSong, portion, sectionSong, slice, tokenize} from './section-song.mjs';

const FLAT = `---
name: "Cycletron Session"
bpm: 120
tags: [cycletron]
---
setcpm(30)

// Track 1: Lead (C:chromatic)
$: note(\`<
    - c4 [-@6 [d5,f#4]@4 [c#5,e4]@4 [b4,d4]@4 e5 - d5@2 e5 - d5@2 e5 - d5@2 e5 - d5@2]@2 e4
    e4>\`).sound("square").gain(0.7).release(0.15)

// Track 2: Pad (C:chromatic)
$: note(\`<
    - - - -
    a2@2>\`).sound("supersaw").gain(0.5).release(1)

// Track 3: Drumset
$: s(\`<
    [bd sd] [bd sd] [bd sd] [bd sd]
    [bd bd bd bd] [bd bd bd bd]>\`).gain(0.4)
`;

test('tokenize reads weights outside brackets only', () => {
    const steps = tokenize('a#2@2 [x@3 y] [a,b]@2 -');
    assert.deepEqual(steps, [
        {text: 'a#2', w: 2}, {text: '[x@3 y]', w: 1}, {text: '[a,b]', w: 2}, {text: '-', w: 1},
    ]);
});

test('parseSong finds tracks, chains and the setcpm line', () => {
    const song = parseSong(FLAT);
    assert.equal(song.setcpm, 'setcpm(30)');
    assert.equal(song.tracks.length, 3);
    assert.equal(song.tracks[0].comment, 'Track 1: Lead (C:chromatic)');
    assert.equal(song.tracks[0].fn, 'note');
    assert.equal(song.tracks[0].chain, '.sound("square").gain(0.7).release(0.15)');
    assert.equal(song.tracks[2].fn, 's');
    assert.equal(song.tracks[2].chain, '.gain(0.4)');
    assert.equal(song.tracks[0].steps.reduce((n, s) => n + s.w, 0), 6);
});

test('a phrase crossing a boundary is cut at the bar line by inner weight', () => {
    const step = tokenize('[-@6 [d5,f#4]@4 [c#5,e4]@4 [b4,d4]@4 e5 - d5@2 e5 - d5@2 e5 - d5@2 e5 - d5@2]@2')[0];
    const cuts = [];
    assert.deepEqual(portion(step, 0, 1, cuts, 'Track 1 bar 2'),
        [{text: '[-@6 [d5,f#4]@4 [c#5,e4]@4 [b4,d4]@3]', w: 1}]);
    assert.deepEqual(portion(step, 1, 2, cuts, 'Track 1 bar 3'),
        [{text: '[- e5 - d5@2 e5 - d5@2 e5 - d5@2 e5 - d5@2]', w: 1}]);
    assert.deepEqual(cuts, ['Track 1 bar 2: [b4,d4] cut, 1/17 bar of sustain dropped']);
});

test('a bare atom held across the line keeps its onset half and rests after', () => {
    const cuts = [];
    assert.deepEqual(portion({text: 'a2', w: 2}, 0, 1, cuts, 'x'), [{text: '[a2]', w: 1}]);
    assert.deepEqual(portion({text: 'a2', w: 2}, 1, 2, cuts, 'x'), [{text: '-', w: 1}]);
    assert.equal(cuts.length, 1);
});

test('slice pads short tracks and keeps whole steps', () => {
    const song = parseSong(FLAT);
    const cuts = [];
    assert.deepEqual(slice(song.tracks[1].steps, 4, 6, cuts, 't'), [{text: 'a2', w: 2}]);
    assert.deepEqual(slice(song.tracks[1].steps, 0, 2, cuts, 't'), [{text: '-', w: 1}, {text: '-', w: 1}]);
    assert.deepEqual(cuts, []);
});

test('compact folds repeats with !N, except a lone run', () => {
    const one = (text, w = 1) => ({text, w});
    assert.deepEqual(compact([one('-'), one('-'), one('[a]'), one('[a]'), one('[a]'), one('b', 2), one('c')]),
        ['-!2', '[a]!3', 'b@2', 'c']);
    assert.deepEqual(compact([one('[bd]'), one('[bd]'), one('[bd]')]), ['[bd]', '[bd]', '[bd]']);
    assert.throws(() => compact([one('[a b]', 2)]), /one 2-bar phrase alone/);
});

test('parseSections wants contiguous half-open ranges from 0', () => {
    assert.deepEqual(parseSections('intro:0-2,drop:2-6'), [
        {label: 'intro', from: 0, to: 2}, {label: 'drop', from: 2, to: 6},
    ]);
    assert.throws(() => parseSections('intro:0-2,drop:3-6'), /expected 2/);
    assert.throws(() => parseSections('intro:0-0'), /empty/);
});

test('sectionSong emits the form, drops silent tracks, pads and speeds a fast section', () => {
    const song = parseSong(FLAT);
    const {code, cuts} = sectionSong(song, parseSections('a:0-3,b:3-6'), new Map([['b', 1.5]]),
        {name: 'Test', tags: 'x,y', source: 'flat.strudel'});
    assert.match(code, /^---\nname: "Test"\nbpm: 120\ntags: \[x,y\]\n---\n/);
    assert.match(code, /\/\/ FORM: a 3 \| b 2 \(3 bars at 1.5x\)\n/);
    assert.match(code, /\nsetcpm\(30\)\n/);
    assert.match(code, /"<a@3 b@2>"\.slow\(1\)\.pickRestart\(\{/);
    // Section a: the pad is silent and dropped; the lead's cut phrase ends it.
    const a = code.slice(code.indexOf('  a: stack('), code.indexOf('  b: stack('));
    assert.doesNotMatch(a, /Track 2/);
    assert.match(a, /- c4 \[-@6 \[d5,f#4\]@4 \[c#5,e4\]@4 \[b4,d4\]@3\]>`\)\.sound\("square"\)\.gain\(0\.7\)\.release\(0\.15\),/);
    assert.match(a, /\[bd sd\] \[bd sd\] \[bd sd\]>`\)\.gain\(0\.4\)\n  \)/);
    // Section b: 3 bars at 1.5x in a 2-cycle slot, padded with 4 rests, fast on the stack.
    const b = code.slice(code.indexOf('  b: stack('));
    assert.match(b, /\[- e5 - d5@2 e5 - d5@2 e5 - d5@2 e5 - d5@2\] e4!2 -!4>`\)/);
    assert.match(b, /a2@2 -!4>`\)/);
    assert.match(b, /\[bd sd\] \[bd bd bd bd\]!2 -!4>`\)\.gain\(0\.4\)\n  \)\.fast\(1\.5\)\n\}\)\n$/);
    assert.deepEqual(cuts, ['Track 1 bar 2: [b4,d4] cut, 1/17 bar of sustain dropped']);
});

test('sectionSong refuses sections that do not cover the song', () => {
    const song = parseSong(FLAT);
    assert.throws(() => sectionSong(song, parseSections('a:0-5')), /sections end at bar 5; the song has 6/);
});
