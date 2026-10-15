/** Show files: layering, strict validation, and cueing a song's form. */
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
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
const {parseShow, cue, cueAt, formLength, ShowError} = await server.ssrLoadModule('/src/show/show.ts');
const {locate} = await server.ssrLoadModule('/src/show/locate.ts');

const CTX = {dir: '/shows', home: '/home/me', modes: ['tunnel', 'plasma', 'cockpit']};
const FORM = [
    {label: 'intro', startCycle: 0, cycles: 8},
    {label: 'drop', startCycle: 8, cycles: 16},
    {label: 'outro', startCycle: 24, cycles: 8},
];

const SHOW = `
[show]
title = "Test"
out = "renders/test.mp4"
size = "1280x720"
fps = 30

[defaults]
code = "solo"
camera = true

[[song]]
source = "~/Songs/test.strudel"
mode = "tunnel"
titles = true

[song.sections]
drop = "plasma"
outro = { mode = "cockpit", code = "fold", camera = false }
`;

test('settings layer defaults → song → section, and paths resolve', () => {
    const show = parseShow(SHOW, CTX);
    assert.equal(show.out, '/shows/renders/test.mp4');
    assert.deepEqual(show.size, {width: 1280, height: 720});
    assert.equal(show.songs[0].source, '/home/me/Songs/test.strudel');
    assert.equal(parseShow('[[song]]\nsource = "../Songs/./a.strudel"\nmode = "tunnel"\n', CTX).songs[0].source, '/Songs/a.strudel');
    assert.deepEqual(cue(show.songs[0], FORM).map((c) => [c.label, c.look]), [
        ['intro', {mode: 'tunnel', code: 'solo', camera: true, titles: true}],
        ['drop', {mode: 'plasma', code: 'solo', camera: true, titles: true}],
        ['outro', {mode: 'cockpit', code: 'fold', camera: false, titles: true}],
    ]);
});

test('mistakes fail with the path to them', () => {
    const fails = (text, path) => assert.throws(() => parseShow(text, CTX), (e) => e instanceof ShowError && e.message.startsWith(path));
    const song = '[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n';
    fails(`[defaults]\ncamra = true\n${song}`, 'defaults.camra: unknown key');
    fails(`${song}[song.sections]\ndrop = "plasm"\n`, "song[0].sections.drop: no mode 'plasm'");
    fails(`${song}[song.sections]\ndrop = { code = "all" }\n`, 'song[0].sections.drop.code:');
    fails(`${song}camera = "yes"\n`, 'song[0].camera: expected true or false');
    fails('[show]\ntitle = "x"\n', 'song: a show needs at least one [[song]]');
    fails(`${song}${song}transition = "flash"\n`, 'song[1].transition: only "cut" so far');
    fails(`${song}passes = 0\n`, 'song[0].passes: expected a positive whole number');
    fails(`${song}${song}[song.sections]\ndrop = "plasm"\n`, "song[1].sections.drop: no mode 'plasm'");
    fails('[[song]]\nsource = "a.strudel"\n', 'song[0].mode: expected a string');
    fails('[show\n', '');
});

test('a section the song lacks fails when cued', () => {
    const show = parseShow('[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n[song.sections]\nbridge = "plasma"\n', CTX);
    assert.throws(() => cue(show.songs[0], FORM), /song\[0\]\.sections\.bridge: the song has no section 'bridge' \(it has: intro, drop, outro\)/);
});

test('the playing cue follows the cycle and loops with the form', () => {
    const cues = cue(parseShow(SHOW, CTX).songs[0], FORM);
    assert.deepEqual([0, 7.99, 8, 23.5, 24, 31.9, 32, 40].map((c) => cueAt(cues, c).label),
        ['intro', 'intro', 'drop', 'drop', 'outro', 'outro', 'intro', 'drop']);
});

test('a path is found on the line that writes it, or its nearest table', () => {
    const line = (path) => locate(SHOW, path);
    const at = (n) => SHOW.split('\n')[n - 1].trim();
    assert.equal(at(line('defaults.camera').line), 'camera = true');
    assert.equal(at(line('song[0].mode').line), 'mode = "tunnel"');
    assert.equal(at(line('song[0].sections.drop').line), 'drop = "plasma"');
    // Inside an inline table: the entry's line.
    assert.deepEqual(line('song[0].sections.outro.code'), {line: line('song[0].sections.outro').line, exact: false});
    // Not written: the enclosing table, inexactly.
    assert.deepEqual(line('song[0].sections.intro'), {line: line('song[0].sections').line, exact: false});
    assert.equal(at(line('song[0].sections').line), '[song.sections]');
    assert.equal(at(line('song[0]').line), '[[song]]');
    assert.deepEqual(locate(SHOW, ''), {line: 1, exact: true});
});

test('a setlist keeps each song in order with its own looks and passes', () => {
    const show = parseShow(`${SHOW}
[[song]]
source = "next.strudel"
mode = "cockpit"
passes = 2
transition = "cut"
[song.sections]
intro = "plasma"
`, CTX);
    assert.deepEqual(show.songs.map((s) => [s.index, s.source, s.passes]), [[0, '/home/me/Songs/test.strudel', 1], [1, '/shows/next.strudel', 2]]);
    const cues = cue(show.songs[1], FORM);
    assert.deepEqual(cues.map((c) => c.look.mode), ['plasma', 'cockpit', 'cockpit']);
    assert.equal(formLength(cues), 32);
    assert.throws(() => cue(show.songs[1], FORM.slice(1)), /song\[1\]\.sections\.intro: the song has no section 'intro'/);
    assert.equal(locate(`${SHOW}\n[[song]]\nsource = "n"\nmode = "cockpit"\n[song.sections]\nintro = "plasma"\n`, 'song[1].sections.intro').exact, true);
});

test('paths resolve with either separator, on any root', () => {
    const src = (source, ctx = CTX) => parseShow(`[[song]]\nsource = ${JSON.stringify(source)}\nmode = "tunnel"\n`, ctx).songs[0].source;
    const win = {...CTX, dir: 'C:\\Users\\me\\shows', home: 'C:\\Users\\me'};
    assert.equal(src('..\\songs\\a.strudel', win), 'C:/Users/me/songs/a.strudel');
    assert.equal(src('~\\a.strudel', win), 'C:/Users/me/a.strudel');
    assert.equal(src('\\\\srv\\share\\a.strudel', win), '//srv/share/a.strudel');
    assert.equal(src('D:\\x\\..\\a.strudel', win), 'D:/a.strudel');
    assert.equal(src('/a/..'), '/');
    assert.equal(src('/a/../../b'), '/b');
});

test('defaults are checked even when every song overrides them', () => {
    const fails = (text, path) => assert.throws(() => parseShow(text, CTX), (e) => e instanceof ShowError && e.message.startsWith(path));
    fails('[defaults]\ngain_db = "loud"\n[[song]]\nsource = "a"\nmode = "tunnel"\ngain_db = 3\n', 'defaults.gain_db: expected a number');
    fails('[show]\nsize = "0x0"\n[[song]]\nsource = "a"\nmode = "tunnel"\n', 'show.size: expected WIDTHxHEIGHT');
    assert.throws(() => parseShow('[[song]\n', CTX), (e) => e instanceof ShowError && !e.message.includes('\n') && e.line === 1);
});

test('dotted and quoted keys are found on their line', () => {
    const text = '[[song]]\nsource = "a"\nmode = "tunnel"\nsections.drop = "plasma"\n"sections".\'outro\' = "cockpit"\n';
    assert.deepEqual(locate(text, 'song[0].sections.drop'), {line: 4, exact: true});
    assert.deepEqual(locate(text, 'song[0].sections.outro'), {line: 5, exact: true});
});
