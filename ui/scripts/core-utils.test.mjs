/** Core pure-logic UI helpers: fuzzy ranking, HTML escaping, and mixer track transforms. */
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
globalThis.window = {};
after(() => { delete globalThis.window; });

const {scoreText} = await server.ssrLoadModule('/src/fuzzy.ts');
const {escapeHtml} = await server.ssrLoadModule('/src/html.ts');
const {parseTracks, mixer} = await server.ssrLoadModule('/src/mixer.ts');
const {basename, dirname, relativePath} = await server.ssrLoadModule('/src/paths.ts');
const {alpha, mix, toRgb} = await server.ssrLoadModule('/src/desktop-theme.ts');

test('scoreText ranks exact > prefix > substring > subtitle > subsequence > miss', () => {
    const exact = scoreText('Save', '', 'save');
    const prefix = scoreText('Save As…', '', 'save');
    const substring = scoreText('Autosave Session', '', 'save');
    const subtitle = scoreText('File', 'save current', 'save');
    const subseq = scoreText('Show All Visual Effects', '', 'save');
    const miss = scoreText('Play / Pause', 'transport', 'save');

    assert.ok(exact > prefix);
    assert.ok(prefix > substring);
    assert.ok(substring > subtitle);
    assert.ok(subtitle > subseq);
    assert.ok(subseq > miss);
    assert.equal(miss, 0);
});

test('escapeHtml escapes all five HTML-significant characters', () => {
    assert.equal(
        escapeHtml(`<script a="1" b='2'>&</script>`),
        '&lt;script a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;&lt;/script&gt;',
    );
});

test('parseTracks finds $: tracks and labels them from comments or sounds', () => {
    const song = [
        'setbpm(124);',
        '',
        '// Kick & hat',
        '$: s("bd*4, hh*8")',
        '',
        '$: note("c2 g1").s("sawtooth")',
    ].join('\n');
    const tracks = parseTracks(song);
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].label, 'Kick & hat');
    assert.equal(tracks[1].label, 'sawtooth');
    assert.equal(song.slice(tracks[0].start, tracks[0].end).trim(), '$: s("bd*4, hh*8")');
});

test('mixer.transform preserves exact character offsets when muting a track', () => {
    const song = [
        'setbpm(124);',
        '$: s("bd*4")',
        '$: note("c3 e3").s("sawtooth")',
    ].join('\n');
    mixer.reset();
    mixer.refresh(song);
    mixer.toggleMute(0);
    const out = mixer.transform(song);
    assert.equal(out.length, song.length);
    assert.equal(out.indexOf('$: note("c3 e3")'), song.indexOf('$: note("c3 e3")'));
    assert.ok(!out.includes('bd*4'));
    mixer.reset();
});

test('path helpers handle POSIX and Windows separators', () => {
    assert.equal(basename('/Users/me/Music/demo.wav'), 'demo.wav');
    assert.equal(basename('C:\\Music\\demo.wav'), 'demo.wav');
    assert.equal(dirname('/Users/me/Music/demo.wav'), '/Users/me/Music');
    assert.equal(dirname('/demo.wav'), '/');
    assert.equal(dirname('demo.wav'), '');
    assert.equal(relativePath('/a/b', '/a/c/d.strudel'), '../c/d.strudel');
});

test('desktop-theme color helpers parse and blend hex colors safely', () => {
    assert.deepEqual(toRgb('#ff8000'), [255, 128, 0]);
    assert.equal(toRgb('not-a-color'), null);
    assert.equal(alpha('#00ff80', 0.5), 'rgba(0, 255, 128, 0.5)');
    assert.equal(mix('#000000', '#ffffff', 0.5), 'rgb(128, 128, 128)');
    assert.equal(mix('#000000', 'bad', 0.5), null);
});
