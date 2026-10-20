/** Show files: layering, strict validation, and cueing a song's form. */
import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {readFileSync, readdirSync} from 'node:fs';
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
const {Director} = await server.ssrLoadModule('/src/show/director.ts');
const {VIZ_MODES} = await server.ssrLoadModule('/src/viz/registry.ts');
const NO_DRUMS = {kick: [], snare: []};

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
drop = { mode = "plasma", title = "ZERO-DAY", camera = { move = "orbit", kick = 2 } }
outro = { mode = "cockpit", code = "fold", camera = false }
`;

test('settings layer defaults → song → section, and paths resolve', () => {
    const show = parseShow(SHOW, CTX);
    assert.equal(show.out, '/shows/renders/test.mp4');
    assert.deepEqual(show.size, {width: 1280, height: 720});
    assert.equal(show.songs[0].source, '/home/me/Songs/test.strudel');
    assert.equal(parseShow('[[song]]\nsource = "../Songs/./a.strudel"\nmode = "tunnel"\n', CTX).songs[0].source, '/Songs/a.strudel');
    const drift = {move: 'drift', punch: 1, kick: 1};
    const code = (follow) => ({follow, size: null, place: 'left', opacity: 1, scrim: true, type: null});
    const rest = {
        shots: null, every: 4, transition: {kind: 'cut', bars: 0}, palette: 'neon', letterbox: null, grain: 0, scanlines: true,
        strobe: null, speed: 1, text: [],
    };
    assert.deepEqual(cue(show.songs[0], FORM).map((c) => [c.label, c.look]), [
        ['intro', {mode: 'tunnel', code: code('solo'), camera: drift, titles: true, title: null, ...rest}],
        ['drop', {mode: 'plasma', code: code('solo'), camera: {move: 'orbit', punch: 1, kick: 2}, titles: true, title: 'ZERO-DAY', ...rest}],
        ['outro', {mode: 'cockpit', code: code('fold'), camera: null, titles: true, title: null, ...rest}],
    ]);
});

test('a titled section shows its card even where the cards are off', () => {
    const looks = parseShow('[defaults]\ntitles = false\n[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n[song.sections]\n'
        + 'drop = { title = "GO" }\noutro = { title = "BYE", titles = false }\n', CTX).songs[0].sections;
    assert.deepEqual([looks.get('drop').titles, looks.get('outro').titles], [true, false]);
});

test('shots cut through a section, each entered by its transition', () => {
    const show = parseShow(`[defaults]\ntransition = "flash"\n[[song]]\nsource = "a.strudel"\nshots = ["tunnel", "plasma"]\nevery = 2\n`
        + '[song.sections]\ndrop = { shots = [{ mode = "cockpit", bars = 3, camera = "orbit" }, "plasma"], transition = { kind = "fade", bars = 2 } }\n'
        + 'outro = "cockpit"\n', CTX);
    const song = show.songs[0];
    assert.equal(song.look.mode, 'tunnel');
    const director = new Director(cue(song, FORM), 0.5, NO_DRUMS, song);
    const at = (cycle) => {
        const f = director.at(cycle);
        return [f.mode, f.entering && f.entering.kind, f.entering && Number(f.entering.p.toFixed(2))];
    };
    // intro: tunnel/plasma every 2 bars, each flashed in over a quarter bar, the opening too.
    assert.deepEqual([0, 0.1, 2.5, 4, 6.5].map(at), [['tunnel', 'flash', 0], ['tunnel', 'flash', 0.4], ['plasma', null, null],
        ['tunnel', 'flash', 0], ['plasma', null, null]]);
    // drop: cockpit 3 bars, plasma 2 (every), cockpit…, each faded over 2 bars.
    assert.deepEqual([8, 9, 11, 14, 21.5].map(at), [['cockpit', 'fade', 0], ['cockpit', 'fade', 0.5], ['plasma', 'fade', 0],
        ['cockpit', 'fade', 0.5], ['plasma', 'fade', 0.25]]);
    // outro's own mode holds through it.
    assert.deepEqual(at(30), ['cockpit', null, null]);
    // A fade at the song's very start comes up from black; on the next pass it dissolves.
    const fading = parseShow('[[song]]\nsource = "a.strudel"\nmode = "tunnel"\ntransition = "fade"\n', CTX).songs[0];
    const opening = new Director(cue(fading, FORM), 0.5, NO_DRUMS, fading);
    assert.equal(opening.at(0.5).entering.kind, 'black');
    assert.equal(opening.at(32.5).entering.kind, 'fade');
    assert.equal(opening.fades, true);
});

test('strobe flashes on its drum, the song fades in and out, and text is placed in its section', () => {
    const song = parseShow('[[song]]\nsource = "a.strudel"\nmode = "tunnel"\npasses = 2\nfade = { in = 2, out = 4 }\n'
        + 'strobe = { on = "snare", strength = 0.5 }\nspeed = 0.5\n'
        + '[song.sections]\ndrop = { mode = "plasma", strobe = "beat", text = [{ say = "go", at = 1 }, { say = "now", at = 4, hold = 1, place = "top" }] }\n', CTX)
        .songs[0];
    assert.deepEqual(song.fade, {in: 2, out: 4});
    assert.deepEqual(song.sections.get('drop').text, [{say: 'go', at: 1, hold: 2, place: 'bottom', style: 'line'}, {say: 'now', at: 4, hold: 1, place: 'top', style: 'line'}]);
    const director = new Director(cue(song, FORM), 0.5, {kick: [], snare: [1, 3]}, song);
    const f = (cycle) => director.at(cycle);
    // Snares at 1 and 3: full strength on the hit, gone a few frames later; nothing before the first.
    assert.equal(f(0.5).strobe, 0);
    assert.equal(f(1).strobe, 0.5);
    assert.ok(f(1.2).strobe < 0.01);
    // The drop strobes every beat, at full strength 0.6.
    assert.equal(f(8.25).strobe, 0.6);
    assert.equal(f(1).speed, 0.5);
    // Fades: up over the first 2 bars, down over the last 4 of the second pass (64), none between.
    assert.deepEqual([0, 1, 2, 32, 60, 62, 64].map((c) => f(c).dim), [1, 0.5, 0, 0, 0, 0.5, 0]);
});

test('code is a follow, or a style table layered over the one below; it types in over its bars', () => {
    const song = parseShow('[defaults]\ncode = { follow = "solo", size = 40, scrim = false }\n[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n'
        + 'code = { place = "right", opacity = 0.5 }\n[song.sections]\ndrop = { code = "fold" }\noutro = { code = { type = 2, place = "center" } }\n', CTX)
        .songs[0];
    assert.deepEqual(song.sections.get('drop').code, {follow: 'fold', size: 40, place: 'right', opacity: 0.5, scrim: false, type: null});
    assert.deepEqual(song.sections.get('outro').code, {follow: 'solo', size: 40, place: 'center', opacity: 0.5, scrim: false, type: 2});
    const director = new Director(cue(song, FORM), 0.5, NO_DRUMS, song);
    assert.deepEqual([24, 25, 26, 30, 8].map((c) => director.at(c).typed), [0, 0.5, 1, 1, null]);
});

test('a camera is a switch, a move, or a table, each layered over the one below', () => {
    const look = (defaults, section) => parseShow(`[defaults]\ncamera = ${defaults}\n[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n[song.sections]\ndrop = { camera = ${section} }\n`, CTX)
        .songs[0].sections.get('drop').camera;
    assert.deepEqual(look('{ move = "push", punch = 0 }', 'true'), {move: 'push', punch: 0, kick: 1});
    assert.deepEqual(look('{ move = "push", punch = 0 }', '"shake"'), {move: 'shake', punch: 0, kick: 1});
    assert.deepEqual(look('false', '{ kick = 3 }'), {move: 'drift', punch: 1, kick: 3});
    assert.equal(look('"still"', 'false'), null);
});

test('mistakes fail with the path to them', () => {
    const fails = (text, path) => assert.throws(() => parseShow(text, CTX), (e) => e instanceof ShowError && e.message.startsWith(path));
    const song = '[[song]]\nsource = "a.strudel"\nmode = "tunnel"\n';
    fails(`[defaults]\ncamra = true\n${song}`, 'defaults.camra: unknown key');
    fails(`${song}[song.sections]\ndrop = "plasm"\n`, "song[0].sections.drop: no mode 'plasm'");
    fails(`${song}[song.sections]\ndrop = { code = "all" }\n`, 'song[0].sections.drop.code:');
    fails(`${song}camera = "yes"\n`, 'song[0].camera: drift, push');
    fails(`${song}camera = 1\n`, 'song[0].camera: expected true, false, a move');
    fails(`${song}camera = { move = "orbit", zoom = 2 }\n`, 'song[0].camera.zoom: unknown key');
    fails(`${song}camera = { kick = 5 }\n`, 'song[0].camera.kick: expected 0 to 4');
    fails(`${song}title = "x"\n`, 'song[0].title: unknown key');
    fails(`${song}transition = "wipe"\n`, 'song[0].transition: cut, flash');
    fails(`${song}every = 0\n`, 'song[0].every: expected bars');
    fails(`${song}palette = "teal"\n`, 'song[0].palette: neon, amber');
    fails(`${song}letterbox = 0.5\n`, 'song[0].letterbox: expected an aspect');
    fails(`${song}grain = 2\n`, 'song[0].grain: expected 0 to 1');
    fails(`${song}strobe = "hat"\n`, 'song[0].strobe: kick, snare, beat');
    fails(`${song}code = { follow = "all" }\n`, 'song[0].code.follow: hide, off');
    fails(`${song}code = { size = 200 }\n`, 'song[0].code.size: expected 10 to 96');
    fails(`${song}code = { place = "middle" }\n`, 'song[0].code.place: left, center, right');
    fails(`${song}code = { font = 2 }\n`, 'song[0].code.font: unknown key');
    fails(`${song}speed = 9\n`, 'song[0].speed: expected 0 (frozen) to 4');
    fails(`${song}text = []\n`, 'song[0].text: unknown key');
    fails(`${song}[song.sections]\ndrop = { text = [{ at = 1 }] }\n`, 'song[0].sections.drop.text[0].say: expected a string');
    fails(`${song}[song.sections]\ndrop = { text = [{ say = "x", place = "left" }] }\n`, 'song[0].sections.drop.text[0].place: bottom');
    fails(`${song}fade = { in = 2, over = 1 }\n`, 'song[0].fade.over: unknown key');
    fails(`${song}shots = []\n`, 'song[0].shots: expected a list');
    fails(`${song}[song.sections]\ndrop = { mode = "plasma", shots = ["tunnel"] }\n`, 'song[0].sections.drop.shots: give a mode or shots');
    fails(`${song}[song.sections]\ndrop = { shots = [{ mode = "plasma", bars = 2, zoom = 1 }] }\n`, 'song[0].sections.drop.shots[0].zoom: unknown key');
    fails(`${song}[song.sections]\ndrop = { title = "" }\n`, 'song[0].sections.drop.title: expected a string');
    fails('[show]\ntitle = "x"\n', 'song: a show needs at least one [[song]]');
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
    assert.match(at(line('song[0].sections.drop').line), /^drop = \{ mode = "plasma"/);
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

test('the bundled shows parse and cue against their songs', () => {
    // The shows are seeded to the library's Demos/Shows, beside Demos/Songs (ui/songs here).
    const shows = fileURLToPath(new URL('../shows/', import.meta.url));
    const songs = fileURLToPath(new URL('../songs/', import.meta.url));
    const ctx = {dir: '/demos/Shows', home: '/home/me', modes: VIZ_MODES.map((m) => m.id)};
    const song = (source) => {
        assert.ok(source.startsWith('/demos/Songs/'), source);
        return readFileSync(songs + source.slice('/demos/Songs/'.length), 'utf8');
    };
    // The form as song-check reads it: `"<a@2 b …>".slow(n)`, a section's bars its weight × n.
    const form = (code) => {
        const [, labels, slow] = code.match(/"<([^>]+)>"\.slow\((\d+)\)\.pickRestart/);
        let startCycle = 0;
        return labels.trim().split(/\s+/).map((entry) => {
            const [label, weight = '1'] = entry.split('@');
            const section = {label, startCycle, cycles: Number(weight) * Number(slow)};
            startCycle += section.cycles;
            return section;
        });
    };
    const files = readdirSync(shows).sort();
    assert.deepEqual(files, ['agency-ost.show.toml', 'cycletron-trailer.show.toml', 'feature-tour.show.toml']);
    for (const file of files) {
        const show = parseShow(readFileSync(shows + file, 'utf8'), ctx);
        for (const s of show.songs) cue(s, form(song(s.source)));
    }
});
