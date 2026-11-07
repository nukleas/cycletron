/**
 * In-app help copy. Keep in sync with docs/USER_GUIDE.md and docs/DIALECT.md (same buckets, same order).
 */

export interface ShortcutRow {
    keys: string;
    action: string;
    group: string;
}

export interface DialectRule {
    title: string;
    body: string;
    good?: string;
    bad?: string;
}

export const SHORTCUTS: ShortcutRow[] = [
    {group: 'Transport', keys: '⌘↩', action: 'Play / pause'},
    {group: 'Transport', keys: '⇧↩', action: 'Evaluate current block'},
    {group: 'Transport', keys: 'Esc / ⌘.', action: 'Stop'},
    {group: 'Files', keys: '⌘N', action: 'New file'},
    {group: 'Files', keys: '⌘O', action: 'Open file'},
    {group: 'Files', keys: '⌘S', action: 'Save'},
    {group: 'Files', keys: '⌘⇧S', action: 'Save as…'},
    {group: 'App', keys: '⌘⇧P', action: 'Command palette'},
    {group: 'App', keys: '⌘,', action: 'Preferences'},
    {group: 'App', keys: '⌘⇧A', action: 'Toggle AI panel'},
    {group: 'Editor', keys: '⌘F', action: 'Find (panel includes Replace)'},
    {group: 'View', keys: '⌘⇧V', action: 'Toggle immersive visualization'},
    {group: 'View', keys: '⌘⇧]', action: 'Next visualization mode'},
    {group: 'View', keys: '⌘⇧F', action: 'Stage Mode (fullscreen performance view)'},
];

export const QUICKSTART: string[] = [
    'Press Play (⌘↩) once so audio is armed.',
    'Open Examples and load Lesson 1 · First Steps.',
    'Edit the code, then Play again to hear changes.',
    'Optional: click Enable AI… in the AI panel, pick a provider, ask for a variation.',
    'Save into your library with ⌘S.',
];

export const DIALECT_RULES: DialectRule[] = [
    {
        title: "Commas inside < > don't stack (engine)",
        body: 'Upstream stacks the groups. Here each comma group becomes its own alternating slot, so nothing plays together. Stack inside [ ] or at top level.',
        good: 'note("<c2 g2 a2 f2>")  ·  note("<[c3,e3,g3] [f3,a3,c4]>")  ·  s("bd, sd")',
        bad: 'note("<c2, g2>")  ·  note("<[c3,e3,g3], [f3,a3,c4]>")',
    },
    {
        title: '.scale() needs a root (engine)',
        body: 'Upstream defaults to C. Here a bare mode name does nothing, silently. Only numeric degrees are quantized.',
        good: 'note("0 2 4").scale("C4:minor")',
        bad: 'note("0 2 4").scale("minor")',
    },
    {
        title: 'Euclid and .. arguments are literals (engine)',
        body: 'Patterns in the (p,s,r) slots or in a .. range are rejected. Alternate pre-built variants instead.',
        good: 's("<bd(3,8) bd(3,8,1) bd(3,8,2)>")',
        bad: 's("bd(<3 5>,8)")  ·  s("bd(3,8,<0 2>)")',
    },
    {
        title: 'Some methods take a number, not a pattern (engine)',
        body: 'Controls and fast/slow/ply/late take patterns as upstream. every, lastOf, sometimesBy, degradeBy, euclid, iter, chunk, hurry, linger, segment, striate, chop, swingBy, add, sub, mul, div, range and off take a plain number here.',
        good: 'note("0 2 4").add(12)  ·  .every(2, x => x.fast(2))',
        bad: 'note("0 2 4").add("<0 12>")  ·  .every("<2 3>", x => x.fast(2))',
    },
    {
        title: 'vowel takes numbers (engine)',
        body: '0=a 1=e 2=i 3=o 4=u. Letters are dropped without an error.',
        good: '.vowel("<0 1 2>")',
        bad: '.vowel("<a e i>")',
    },
    {
        title: 'Not available yet: functions',
        body: 'choose/chooseCycles (use randcat, wrandcat, pick). loopAt, fit, slice, splice (use chop, striate, bite). stepcat/timeCat (use arrange or @ weights). chord as a method after n(). all(). samples(). $drums: named tracks (use $: and _$:). Free-standing arrow helpers. setcps (use setbpm/setcpm).',
    },
    {
        title: 'Not available yet: controls',
        body: 'postgain, freq, accelerate, nudge, octave, djf, compressor, unison/spread, the lfo/warp/wt families. Short aliases lpa/lpd/lps/lpr and fmatt/fmdec/fmsus/fmrel: use lpattack, fmattack and the other long names.',
    },
    {
        title: 'Silent, not an error',
        body: 'Pan is 0..1 as upstream, but out-of-range is silent here instead of clamped. chord() without .voicing() is only a tag (same as upstream). A .add() on a bare string is ignored. .cpm(n) in a chain sets the song tempo, it does not speed up that pattern.',
        good: '.pan(0.3)  ·  .pan(sine.range(0.2, 0.8))  ·  chord("<Cm7 FM7>").voicing().s("supersaw")',
        bad: '.pan(-0.3)  ·  chord("<Cm7 FM7>").s("supersaw")  ·  note("c e".add(12))',
    },
    {
        title: 'Same as web Strudel',
        body: 'Pan 0..1 with 0.5 centre. chord() needs .voicing(). | random choice works in [ ] and { }, not in < >. setbpm(120); has parens because it is JavaScript (setbpm is a Cycletron extra). cat is slowcat. A < > slot lasts one cycle; sections get length from @n weights or .slow(n) on the selector, the shape the section tools in Cycletron read. .bank("…") works for the bundled kits (RolandTR808/909/707/606/727, LinnDrum, BossDR55).',
        good: '"<intro@2 drop@2>".slow(8).pickRestart({ intro: …, drop: … })',
    },
];

export const PRIVACY_BLURB =
    'Prompts and pattern text go to the AI provider you choose. API keys stay on this machine (keychain in release builds; local app data during `cargo tauri dev`). Logs and agent stats are local. License: AGPL-3.0-or-later.';
