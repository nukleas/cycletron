/** Parts shelf: cutting sources into lanes and placing a part in a song. */
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {parser} from '@lezer/javascript';

const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: {middlewareMode: true, hmr: false, watch: null},
    optimizeDeps: {noDiscovery: true, include: []},
});
after(() => server.close());
globalThis.window = {};
after(() => { delete globalThis.window; });
const {splitLanes, classify} = await server.ssrLoadModule('/src/parts/split.ts');
const {planInsert} = await server.ssrLoadModule('/src/parts/insert.ts');
const {partsFrom, fastSavedCode, savedRecordToParts} = await server.ssrLoadModule('/src/parts/catalog.ts');
const {shelfRows, kitCore, SPLIT_OVER} = await server.ssrLoadModule('/src/parts/groups.ts');
const {keyOf, parseKey, shiftBetween, transposed, fitted} = await server.ssrLoadModule('/src/parts/key.ts');

const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');

const kick = {title: 'kick', code: 's("bd*4")', bpm: 124};

/** `|` marks the drop position. */
function drop(src, part = kick) {
    const pos = src.indexOf('|');
    const code = src.replace('|', '');
    const plan = planInsert(code, pos < 0 ? null : pos, part);
    return {plan, out: code.slice(0, plan.from) + plan.insert + code.slice(plan.to)};
}

test('a stack file gives one lane per argument', () => {
    const {bpm, lanes} = splitLanes(read('corpus/rhythm/four-on-the-floor.strudel'));
    assert.equal(bpm, 124);
    assert.deepEqual(lanes.map((l) => l.code), ['s("bd bd bd bd")', 's("~ sd ~ sd")', 's("hh*8").gain(0.5)']);
});

test('a single voice stays whole', () => {
    const {lanes} = splitLanes(read('corpus/timbre/fm-bass.strudel'));
    assert.equal(lanes.length, 1);
    assert.match(lanes[0].code, /^note\("c2 c2 eb2 g2"\)\n {2}\.s\("fm"\)/);
});

test('tracks give one lane each, named by their comment', () => {
    const {lanes} = splitLanes('setcpm(30)\n// Kick\n$: s("bd*4")\n\n$: note("c2")\n  .s("saw");\n');
    assert.deepEqual(lanes, [
        {label: 'Kick', code: 's("bd*4")'},
        {label: null, code: 'note("c2")\n  .s("saw")'},
    ]);
});

test('comments inside a stack name its lanes', () => {
    const {lanes} = splitLanes('stack(\n  // Drums\n  s("bd*4"),\n  // Bass\n  note("c2")\n)');
    assert.deepEqual(lanes.map((l) => l.label), ['Drums', 'Bass']);
});

test('sources that cannot stand alone are skipped', () => {
    assert.equal(splitLanes(read('corpus/form/aabb-pickrestart.strudel')).lanes.length, 0);
    assert.equal(splitLanes('const a = s("bd");\nstack(a, s("hh"))').lanes.length, 0);
    assert.equal(splitLanes('s("bd")\n$: s("hh")').lanes.length, 0);
});

test('roles', () => {
    assert.equal(classify('', 's("bd bd bd bd")'), 'drums');
    assert.equal(classify('', 's("hh*8").gain(0.5)'), 'drums');
    assert.equal(classify('', 'note("c2 c2 eb2 g2").s("fm")'), 'bass');
    assert.equal(classify('', 'note("c4 eb4 g4").s("triangle")'), 'lead');
    assert.equal(classify('Stabbed minor-7ths', 'note("c4").s("saw")'), 'chords');
    assert.equal(classify('Offbeat bass', 'note("c4").s("saw")'), 'bass');
    assert.equal(classify('', 's("RolandTR808_bd ~ RolandTR808_bd ~")'), 'drums');
    assert.equal(classify('', 'note("d2 ~ a2 ~ d2 ~ c3 ~").s("gm_acoustic_bass")'), 'bass');
    assert.equal(classify('', 'note("~ g2 ~ g2 ~ g2 ~ g3").s("sawtooth")'), 'bass');
});

test('melodic lanes are named by role', () => {
    const parts = partsFrom({
        id: 'x', name: 'Groove', source: 'corpus',
        text: 'stack(s("bd*4"), note("c2 c2").s("sawtooth"), note("c5 e5").s("triangle"))',
    });
    assert.deepEqual(parts.map((p) => p.title), ['Groove · bd', 'Groove · bass', 'Groove · lead']);
});

test('four-on-the-floor stays one beat', () => {
    const parts = partsFrom({
        id: 'x', name: 'Four On The Floor', source: 'corpus',
        text: read('corpus/rhythm/four-on-the-floor.strudel'),
    });
    assert.deepEqual(parts.map((p) => [p.title, p.role, p.bpm]), [['Four On The Floor', 'drums', 124]]);
    assert.equal(splitLanes(parts[0].code).lanes.length, 3);
});

test('drum lanes merge and the rest stay separate', () => {
    const parts = partsFrom({
        id: 'x', name: 'Groove', source: 'corpus',
        text: 'stack(s("bd*4"), note("c2 c2").s("sawtooth"), s("hh*8"))',
    });
    assert.deepEqual(parts.map((p) => p.title), ['Groove · drums', 'Groove · bass']);
    assert.equal(parts[0].code, 'stack(\n  s("bd*4"),\n  s("hh*8")\n)');
});

test('a saved part is one part whatever is in it', () => {
    const parts = partsFrom({
        id: 'x', name: 'Mine', source: 'mine', role: 'chords',
        text: 'stack(note("c3 e3"), note("g3 b3"))',
    });
    assert.deepEqual(parts.map((p) => [p.title, p.role]), [['Mine', 'chords']]);
});

test('an empty song takes the part and its tempo', () => {
    assert.equal(drop('').out, 'setbpm(124);\n\n// kick\n$: s("bd*4")\n');
    assert.equal(drop('  \n').out, 'setbpm(124);\n\n// kick\n$: s("bd*4")\n');
});

test('no position appends a track', () => {
    assert.equal(drop('setbpm(90);\n\n$: s("hh*8")\n').out, 'setbpm(90);\n\n$: s("hh*8")\n\n// kick\n$: s("bd*4")\n');
    assert.equal(drop('stack(s("hh*8"))').out, 'stack(s("hh*8"))\n\n// kick\n$: s("bd*4")\n');
});

test('a drop between tracks lands on the nearest gap', () => {
    const src = 'setbpm(90);\n\n// hats\n$: s("hh*8")\n  .ga|in(0.4)\n\n// bass\n$: note("c2")\n';
    assert.equal(drop(src).out,
        'setbpm(90);\n\n// hats\n$: s("hh*8")\n  .gain(0.4)\n\n// kick\n$: s("bd*4")\n\n// bass\n$: note("c2")\n');
});

test('nothing lands above the tempo line', () => {
    assert.equal(drop('|// song\nsetbpm(90);\n\n$: s("hh*8")\n').out,
        '// song\nsetbpm(90);\n\n// kick\n$: s("bd*4")\n\n$: s("hh*8")\n');
});

test('a drop inside a stack adds an argument there', () => {
    const src = 'stack(\n  s("hh*8"),\n  note("c2")|\n    .s("saw")\n)';
    assert.equal(drop(src).out, 'stack(\n  s("hh*8"),\n  note("c2")\n    .s("saw"),\n  s("bd*4")\n)');
    assert.equal(drop('stack(s("hh*8")|, s("cp"))').out, 'stack(s("hh*8"), s("bd*4"), s("cp"))');
    assert.equal(drop('stack(|\n  s("hh*8")\n)').out, 'stack(\n  s("bd*4"),\n  s("hh*8")\n)');
    assert.equal(drop('stack(|)').out, 'stack(s("bd*4"))');
});

test('a multi-line part keeps its shape inside a stack', () => {
    const part = {title: 'bass', code: 'note("c2")\n  .s("saw")', bpm: null};
    assert.equal(drop('stack(\n    s("hh*8")|\n)', part).out,
        'stack(\n    s("hh*8"),\n    note("c2")\n      .s("saw")\n)');
});

test('a drop in one section leaves the others alone', () => {
    const song = read('ui/songs/agency/01-legacy-system.strudel');
    const at = song.indexOf('stack(', song.indexOf('pickRestart')) + 'stack('.length + 1;
    const plan = planInsert(song, at, kick);
    assert.equal(plan.kind, 'stack');
    const out = song.slice(0, plan.from) + plan.insert + song.slice(plan.to);
    assert.equal(out.length, song.length + plan.insert.length);
    assert.equal(out.split('s("bd*4")').length, 2);
    assert.equal(song.slice(plan.from), out.slice(plan.from + plan.insert.length));
});

test('the reported part range is the part', () => {
    for (const src of ['', 'setbpm(90);\n$: s("hh")\n', 'stack(s("hh")|)', 'stack(|\n  s("hh")\n)']) {
        const {plan} = drop(src);
        assert.equal(plan.insert.slice(plan.partFrom, plan.partTo), kick.code);
    }
});

test('every corpus lane parses as one expression', () => {
    let count = 0;
    for (const dir of ['rhythm', 'melody', 'harmony', 'timbre', 'motion']) {
        for (const file of readdirSync(repo(`corpus/${dir}`)).filter((f) => f.endsWith('.strudel'))) {
            for (const lane of splitLanes(read(`corpus/${dir}/${file}`)).lanes) {
                const top = parser.parse(lane.code).topNode;
                const kids = [];
                for (let n = top.firstChild; n; n = n.nextSibling) kids.push(n.name);
                assert.deepEqual(kids, ['ExpressionStatement'], `${dir}/${file}: ${lane.code}`);
                count++;
            }
        }
    }
    assert.ok(count > 60, `only ${count} lanes`);
});

function saved(n, over) {
    return Array.from({length: n}, (_, i) => ({
        id: `p${i}`, title: `part ${i}`, role: 'drums', genre: null, bpm: 100, code: `s("bd*${i + 1}")`,
        source: 'mine', collection: 'kit', key: null, bars: 1, ...over(i),
    }));
}
const labels = (rows) => rows.filter((r) => r.t === 'group').map((r) => `${r.depth}:${r.label} ${r.count}`);

test('a small group lists its parts without sub-groups', () => {
    const rows = shelfRows(saved(3, () => ({})), new Set(['drums']));
    assert.deepEqual(labels(rows), ['0:Drums 3']);
    assert.equal(rows.filter((r) => r.t === 'part').length, 3);
});

test('a big role splits by collection, then drums by tempo', () => {
    const parts = saved(SPLIT_OVER * 3, (i) => ({
        collection: i % 3 ? 'kit' : null,
        bpm: i % 2 ? 92 : 128,
    }));
    const open = new Set(['drums', 'drums/kit']);
    const rows = shelfRows(parts, open);
    assert.deepEqual(labels(rows), [
        `0:Drums ${SPLIT_OVER * 3}`, `1:My parts ${SPLIT_OVER}`, `1:kit ${SPLIT_OVER * 2}`,
        `2:80–99 bpm ${SPLIT_OVER}`, `2:120–139 bpm ${SPLIT_OVER}`,
    ]);
    assert.equal(rows.some((r) => r.t === 'part'), false);
});

test('pitched parts split by key in chromatic order', () => {
    const keys = ['A:minor', 'C:major', null, 'Eb:major'];
    const parts = saved(SPLIT_OVER * 2, (i) => ({role: 'lead', key: keys[i % 4]}));
    const rows = shelfRows(parts, new Set(['lead']));
    assert.deepEqual(labels(rows).slice(1).map((l) => l.replace(/ \d+$/, '')),
        ['1:C major', '1:Eb major', '1:A minor', '1:no key']);
});

test('groups of one or two are gathered under other', () => {
    const genres = ['house', 'house', 'house', 'techno', 'dub', 'dub'];
    const parts = saved(SPLIT_OVER * 2, (i) => ({role: 'bass', source: 'corpus', collection: null, genre: genres[i] ?? 'trance'}));
    const rows = shelfRows(parts, new Set(['bass']));
    assert.deepEqual(labels(rows).slice(1), ['1:house 3', `1:trance ${SPLIT_OVER * 2 - 6}`, '1:other 3']);
});

test('parts list best rated first, unrated with the usable ones', () => {
    const ratings = [2, null, 4, 3];
    const rows = shelfRows(saved(4, (i) => ({rating: ratings[i]})), new Set(['drums']));
    assert.deepEqual(rows.filter((r) => r.t === 'part').map((r) => r.part.rating), [4, null, 3, 2]);
});

test('pitched parts split by pack folder after key', () => {
    const folders = ['soul style', 'pop style'];
    const parts = saved(SPLIT_OVER * 2, (i) => ({role: 'chords', key: 'C:major', folder: folders[i % 2]}));
    const rows = shelfRows(parts, new Set(['chords']));
    assert.deepEqual(labels(rows).slice(1), [`1:pop style ${SPLIT_OVER}`, `1:soul style ${SPLIT_OVER}`]);
});

test('a song key is read from its scale or its notes', () => {
    assert.deepEqual(keyOf('n("0 2 4").scale("D:dorian")'), {root: 2, mode: 'dorian'});
    assert.deepEqual(keyOf('$: note("a2 c3 e3 a3 g3 e3 f3 e3")\n$: note("<[a3,c4,e4] [f3,a3,c4] [g3,b3,d4] [e3,g3,b3]>")'), {root: 9, mode: 'minor'});
    assert.deepEqual(keyOf('note("c3 e3 g3 c4 f3 a3 g3 b3")'), {root: 0, mode: 'major'});
    assert.equal(keyOf('s("bd*4")'), null);
    // A synth kick is written as a note but has no key.
    const kick = 'note("c2*4").s("triangle").penv(-24).pdecay(0.05)';
    assert.equal(keyOf(kick), null);
    assert.deepEqual(keyOf(`$: stack(${kick}, s("white*8"))\n$: note("d2 f2 a2 d3 e3 f3 a3 d3").penv(2)`), {root: 2, mode: 'minor'});
});

test('a part moves the short way onto the song\'s notes', () => {
    const key = (text) => parseKey(text);
    assert.equal(shiftBetween(key('F:minor'), key('A:minor')), 4);
    assert.equal(shiftBetween(key('A:minor'), key('F:minor')), -4);
    assert.equal(shiftBetween(key('A:minor'), key('C:major')), 0);
    assert.equal(shiftBetween(key('D:dorian'), key('A:minor')), 0);
    assert.equal(shiftBetween(key('C:major'), key('F#:major')), -6);
});

test('transposing rewrites note names, octaves and scale roots', () => {
    assert.equal(transposed('note("a1 a2 [c3,e3]@2 - b2*2")', 3), 'note("c2 c3 [d#3,g3]@2 - d3*2")');
    assert.equal(transposed('note(`<[A#2 C4] [F3@3 -]>`).sound("gm_piano")', -2), 'note(`<[G#2 A#3] [D#3@3 -]>`).sound("gm_piano")');
    assert.equal(transposed('note("eb3 bb2 c3")', 2), 'note("f3 c3 d3")');
    assert.equal(transposed('note("ab2 cb3")', 1), 'note("a2 c3")');
    assert.equal(transposed('note("c e g")', -1), 'note("b d# f#")');
    assert.equal(transposed('n("0 2 4").scale("A:minor").s("sawtooth")', 3), 'n("0 2 4").scale("C:minor").s("sawtooth")');
    assert.equal(transposed('note("60 64 67")', 2), 'note("60 64 67").transpose(2)');
    assert.equal(transposed('note("c2")', 0), 'note("c2")');
});

test('a part is fitted to the song, drums and keyless songs are left alone', () => {
    const song = 'setbpm(124);\n$: note("<[a3,c4,e4] [f3,a3,c4] [g3,b3,d4] [e3,g3,b3]>")';
    assert.equal(fitted({role: 'bass', key: 'F:minor', code: 'note("f1 f2 ab1 c2")'}, song), 'note("a1 a2 c2 e2")');
    assert.equal(fitted({role: 'bass', key: 'A:minor', code: 'note("a1 f1")'}, 'note("<[d3,f3,a3] [bb2,d3,f3] [c3,e3,g3]>")'), 'note("d2 bb1")');
    assert.equal(fitted({role: 'drums', code: 's("bd*4")'}, song), 's("bd*4")');
    assert.equal(fitted({role: 'bass', key: 'F:minor', code: 'note("f1 f2")'}, 'setbpm(124);'), 'note("f1 f2")');
});

test('kits list above the roles, by style, main parts before alternates', () => {
    const part = (role, title, tags = []) => ({id: title, title, role, code: title, source: 'mine', collection: 'house', kit: 'Deep in A minor', tags});
    const kit = [part('lead', 'hook'), part('drums', 'fill', ['fill']), part('bass', 'bass'), part('drums', 'beat'), part('bass', 'busier', ['variation'])];
    const all = [...kit, {id: 'x', title: 'loose', role: 'bass', code: 'x', source: 'mine', collection: 'house'}];

    assert.deepEqual(shelfRows(all, new Set()).map((r) => r.label), ['Kits', 'Drums', 'Bass', 'Lead']);
    const rows = shelfRows(all, new Set(['kits', 'kits/house', 'kits/house/Deep in A minor']));
    assert.deepEqual(rows.slice(0, 3).map((r) => [r.label, r.count]), [['Kits', 1], ['house', 1], ['Deep in A minor', 5]]);
    assert.deepEqual(rows.slice(3, 8).map((r) => r.part.title), ['beat', 'fill', 'bass', 'busier', 'hook']);
    assert.deepEqual(rows[2].kit.map((p) => p.title), ['beat', 'bass', 'hook']);
    assert.deepEqual(kitCore(kit).map((p) => p.title), ['beat', 'bass', 'hook']);
});

test('saved part fast path matches full parser output and falls back on complex bodies', () => {
    const record = (code, over = {}) => ({
        path: '/lib/Parts/bass/test.strudel',
        name: 'Test',
        role: 'bass',
        bpm: 120,
        bars: 2,
        key: 'A:minor',
        collection: 'pack',
        license: 'MIT',
        song: null,
        source: 'folder/file.mid',
        rating: 4,
        tags: ['part', 'bass', 'pack', 'groove'],
        kit: null,
        code,
        ...over,
    });

    // Clean single-line and multi-line expressions take the fast path.
    assert.equal(fastSavedCode('note("a1 c2").s("saw")\n'), 'note("a1 c2").s("saw")');
    assert.equal(
        fastSavedCode('stack(\n  s("bd*4"),\n  s("~ sd ~ sd")\n)\n'),
        'stack(\n  s("bd*4"),\n  s("~ sd ~ sd")\n)',
    );

    // Complex syntax falls back to the full Lezer parser.
    assert.equal(fastSavedCode('// comment\nsetbpm(128);\n\nnote("c2")'), null);
    assert.equal(fastSavedCode('$: s("bd*4")\n$: s("hh*8")'), null);
    assert.equal(fastSavedCode('stack(s("bd"), s("hh"))'), null);
    assert.equal(fastSavedCode('const a = s("bd");\nstack(a, s("hh"))'), null);
    assert.equal(fastSavedCode('s("bd")\ns("sd")'), null);

    // Parity check: savedRecordToParts produces the exact same code and metadata as partsFrom.
    const samples = [
        'note("a1 c2").s("saw")\n',
        'stack(\n  s("bd*4"),\n  s("~ sd ~ sd")\n)\n',
        '// mine\nsetbpm(128);\n\nnote("c2 e2").s("fm")\n',
        '$: s("bd*4")\n$: s("hh*8")\n',
        'stack(note("c3 e3"), note("g3 b3"))',
        'const a = s("bd");\nstack(a, s("hh"))',
    ];
    for (const code of samples) {
        const rec = record(code);
        const actual = savedRecordToParts(rec);
        const expected = partsFrom({
            id: `mine:${rec.path}`,
            name: rec.name,
            text: rec.code,
            source: 'mine',
            bpm: rec.bpm,
            role: rec.role,
        }).map((part) => ({
            ...part,
            collection: rec.collection,
            key: rec.key,
            bars: rec.bars,
            folder: 'folder',
            song: rec.song,
            rating: rec.rating,
            tags: ['groove'],
            kit: rec.kit,
        }));
        assert.deepEqual(actual, expected, `mismatch for ${JSON.stringify(code)}`);
    }
});
