/**
 * In-app help copy. Keep in sync with docs/USER_GUIDE.md and docs/DIALECT.md.
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
    {group: 'Transport', keys: 'Esc', action: 'Stop'},
    {group: 'Files', keys: '⌘N', action: 'New file'},
    {group: 'Files', keys: '⌘O', action: 'Open file'},
    {group: 'Files', keys: '⌘S', action: 'Save'},
    {group: 'Files', keys: '⌘⇧S', action: 'Save as…'},
    {group: 'App', keys: '⌘⇧P', action: 'Command palette'},
    {group: 'App', keys: '⌘,', action: 'Preferences'},
    {group: 'Editor', keys: '⌘F', action: 'Find'},
    {group: 'Editor', keys: '⌘⇧F', action: 'Replace'},
    {group: 'View', keys: '⌘⇧V', action: 'Toggle immersive visualization'},
];

export const QUICKSTART: string[] = [
    'Press Play (⌘↩) once so audio is armed.',
    'Open Examples and load Lesson 1 · First Steps.',
    'Edit the code, then Play again to hear changes.',
    'Optional: set an AI provider in Preferences and ask for a variation.',
    'Save into your library with ⌘S.',
];

export const DIALECT_RULES: DialectRule[] = [
    {
        title: 'Pan is 0…1 (not −1…1)',
        body: 'Negative pan becomes NaN and the event is completely silent.',
        good: '.pan(0.3)  ·  .pan(sine.range(0.2, 0.8))',
        bad: '.pan(-0.3)  ·  .pan(sine.range(-0.3, 0.3))',
    },
    {
        title: 'chord() needs .voicing()',
        body: 'Without voicing, the chord symbol is treated like a sample name → silence.',
        good: 'chord("<Cm7 FM7>").voicing().s("supersaw")',
        bad: 'chord("<Cm7 FM7>").s("supersaw")',
    },
    {
        title: '.scale() needs "root:mode"',
        body: 'A bare mode name is a no-op. Only numeric scale degrees are quantized.',
        good: 'note("0 2 4").scale("C4:minor")',
        bad: 'note("0 2 4").scale("minor")',
    },
    {
        title: 'pickRestart needs .slow(n) on the selector',
        body: 'Without .slow(), each section lasts one cycle (~1–2s at dance tempos).',
        good: '"<intro drop>".slow(8).pickRestart({ intro: …, drop: … })',
        bad: '"<intro drop>".pickRestart({ … })',
    },
    {
        title: 'Arrow params without parentheses',
        body: 'Parenthesised parameters are a parse error in the DSL.',
        good: '.every(2, x => x.fast(2))',
        bad: '.every(2, (x) => x.fast(2))',
    },
    {
        title: 'No commas inside < >',
        body: 'Spaces separate slowcat items. Commas only stack inside [ ] / { } or at top level.',
        good: 'note("<c2 g2 a2 f2>")  ·  note("<[c3,e3,g3] [f3,a3,c4]>")',
        bad: 'note("<c2, g2>")  ·  note("<[c3,e3,g3], [f3,a3,c4]>")',
    },
    {
        title: 'Random | only inside [ ] or { }',
        body: 'Pipe choice is illegal inside angle brackets.',
        good: 's("[bd | sd]")',
        bad: 's("<bd | sd>")',
    },
    {
        title: 'Tempo & samples',
        body: 'Use setbpm(120); with parens. No .bank("…") — use bd/sd/hh or catalog names. Double quotes only for mini-notation strings.',
    },
];

export const PRIVACY_BLURB =
    'Prompts and pattern text go to the AI provider you choose. API keys stay on this machine (keychain in release builds; local app data during `cargo tauri dev`). Logs and agent stats are local. License: AGPL-3.0-or-later.';
