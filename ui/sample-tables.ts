/**
 * Sample tables — the single source of truth for the bundled Cycletron
 * sample set.
 *
 * Consumed by:
 *   1. `sample-loader.ts` — live playback loads these banks into the engine.
 *   2. `scripts/gen-sample-manifest.mjs` — generates
 *      `ui/public/cycletron.strudel.json`, the manifest the offline export
 *      renderer registers so exports resolve the exact same files.
 *
 * The manifest is regenerated on every dev/build run (like `gen:dsl`), so it
 * cannot drift from these tables. Node ≥22.18 strips the type annotations
 * when the generator imports this file directly.
 */

/**
 * Michael Fischer's 1994 TR-808 sample set (CC0), the source of the bundled
 * default kit — remote fallback if a file is somehow missing from the bundle.
 */
export const FISCHER_808_BASE = 'https://raw.githubusercontent.com/tidalcycles/sounds-tr808-fischer/main/';

/**
 * Streamed drum machine kits live in the upstream tidal-drum-machines repo.
 * That collection carries no license, so we never redistribute it — kits
 * without a cleanly licensed replacement stream from here at runtime (as
 * strudel.cc does) and are simply absent offline.
 */
export const TDM_BASE = 'https://raw.githubusercontent.com/geikha/tidal-drum-machines/master/machines/';

/**
 * The default 12-voice kit: Michael Fischer's 1994 TR-808 set (CC0), bundled
 * in `ui/public/samples/` (offline). `sub` is the bundled path relative to
 * `/samples/`, `src` the path inside the Fischer repo (remote fallback).
 */
export const ESSENTIAL_DRUMS: Array<{name: string; sub: string; src: string}> = [
    {name: 'bd', sub: 'bd/BD0050.WAV', src: 'bd8/BD0050.WAV'},
    {name: 'sd', sub: 'sd/SD5050.WAV', src: 'sd8/SD5050.WAV'},
    {name: 'sn', sub: 'sn/SD0075.WAV', src: 'sd8/SD0075.WAV'},
    {name: 'hh', sub: 'hh/CH.WAV',     src: 'ch8/CH.WAV'},
    {name: 'cp', sub: 'cp/CP.WAV',     src: 'cp8/CP.WAV'},
    {name: 'oh', sub: 'oh/OH00.WAV',   src: 'oh8/OH00.WAV'},
    {name: 'ht', sub: 'ht/HT50.WAV',   src: 'ht8/HT50.WAV'},
    {name: 'mt', sub: 'mt/MT50.WAV',   src: 'mt8/MT50.WAV'},
    {name: 'lt', sub: 'lt/LT50.WAV',   src: 'lt8/LT50.WAV'},
    {name: 'cr', sub: 'cr/CY0050.WAV', src: 'cy8/CY0050.WAV'},
    {name: 'cb', sub: 'cb/CB.WAV',     src: 'cb8/CB.WAV'},
    {name: 'rs', sub: 'rs/RS.WAV',     src: 'rs8/RS.WAV'},
];

/**
 * All drum machine voices, each mapped to the URL it loads from.
 * Naming: `{MachineName}_{voice}` — these are the canonical web-strudel names.
 * The engine supports `.bank()` prefix lookup, so `s("bd").bank("RolandTR808")`
 * resolves to `RolandTR808_bd`; the full underscore name works too. A voice the
 * kit lacks (e.g. LinnDrum has no `cr`) resolves to nothing and plays silent.
 * Machine names must not contain underscores — the engine splits flat keys at
 * the first `_`.
 *
 * TR-808 (Michael Fischer's CC0 set), TR-707 (public-domain hyperreal set),
 * and LinnDrum (BushDrum, CC0) are bundled in `ui/public/machines/`; TR-909
 * and DR-55 have no cleanly licensed sample set, so they stream from upstream.
 * See ATTRIBUTION.md. Grouped as [machineName, displayName, [voice, url][]].
 */
export const MACHINE_KITS: Array<[string, string, Array<[string, string]>]> = [
    ['RolandTR808', 'TR-808', [
        ['bd',  '/machines/RolandTR808_bd.wav'],
        ['sd',  '/machines/RolandTR808_sd.wav'],
        ['hh',  '/machines/RolandTR808_hh.wav'],
        ['oh',  '/machines/RolandTR808_oh.wav'],
        ['cp',  '/machines/RolandTR808_cp.wav'],
        ['rim', '/machines/RolandTR808_rim.wav'],
        ['lt',  '/machines/RolandTR808_lt.wav'],
        ['mt',  '/machines/RolandTR808_mt.wav'],
        ['ht',  '/machines/RolandTR808_ht.wav'],
        ['cb',  '/machines/RolandTR808_cb.wav'],
    ]],
    ['RolandTR909', 'TR-909', [
        ['bd',  TDM_BASE + 'RolandTR909/rolandtr909-bd/Bassdrum-01.wav'],
        ['sd',  TDM_BASE + 'RolandTR909/rolandtr909-sd/naredrum.wav'],
        ['hh',  TDM_BASE + 'RolandTR909/rolandtr909-hh/hh01.wav'],
        ['oh',  TDM_BASE + 'RolandTR909/rolandtr909-oh/Hat%20Open.wav'],
        ['cp',  TDM_BASE + 'RolandTR909/rolandtr909-cp/Clap.wav'],
        ['rd',  TDM_BASE + 'RolandTR909/rolandtr909-rd/Ride.wav'],
        ['rim', TDM_BASE + 'RolandTR909/rolandtr909-rim/Rimhot.wav'],
    ]],
    ['RolandTR707', 'TR-707', [
        ['bd',  '/machines/RolandTR707_bd.wav'],
        ['sd',  '/machines/RolandTR707_sd.wav'],
        ['hh',  '/machines/RolandTR707_hh.wav'],
        ['oh',  '/machines/RolandTR707_oh.wav'],
        ['cp',  '/machines/RolandTR707_cp.wav'],
        ['lt',  '/machines/RolandTR707_lt.wav'],
        ['ht',  '/machines/RolandTR707_ht.wav'],
    ]],
    ['LinnDrum', 'LinnDrum', [
        ['bd',  '/machines/LinnDrum_bd.wav'],
        ['sd',  '/machines/LinnDrum_sd.wav'],
        ['hh',  '/machines/LinnDrum_hh.wav'],
        ['cp',  '/machines/LinnDrum_cp.wav'],
    ]],
    ['BossDR55', 'DR-55', [
        ['bd',  TDM_BASE + 'BossDR55/bossdr55-bd/Bassdrum-01.wav'],
        ['sd',  TDM_BASE + 'BossDR55/bossdr55-sd/Snaredrum-01.wav'],
        ['hh',  TDM_BASE + 'BossDR55/bossdr55-hh/Hihat1.wav'],
        ['rim', TDM_BASE + 'BossDR55/bossdr55-rim/Rimshot.wav'],
    ]],
];

/**
 * Percussion & texture "color" banks — CC0 recordings from the Versilian
 * Community Sample Library (VCSL, https://github.com/sgossner/VCSL) bundled in
 * `ui/public/samples/` (see ATTRIBUTION.md for the per-bank source mapping).
 * Each bank is a single raw fortissimo one-shot (index 0 only — `:n` replays
 * the same sample). Agent guidance scopes them to sparse genre-appropriate
 * accents, tamed with gain/filtering — they are not default percussion.
 * Each entry is [bankName, relativePath].
 */
export const PERCUSSION_COLORS: Array<[string, string]> = [
    ['perc',       'perc/Cajon_hit1_fff_rr1.wav'],
    ['click',      'click/claves_ff.wav'],
    ['metal',      'metal/Anvil_Hit1_v3_rr1_Mid.wav'],
    ['east',       'east/wood_click_ff.wav'],
    ['hand',       'hand/Conga_HitN_v3_rr1_Sum.wav'],
    ['industrial', 'industrial/BrakeDrum1_Hammer_v3_rr1_Mid.wav'],
    ['space',      'space/glass3_Asharp4_Fast_1_Main.wav'],
    ['arpy',       'arpy/Clavisynth_C4_vl3.wav'],
    ['tabla',      'tabla/Darbuka_1_hit_vl2_rr1.wav'],
    ['jvbass',     'jvbass/FMPiano_C1_vl3.wav'],
];

/**
 * Melodic / speech expansion banks — short CC0 slices from the Tidal
 * Clean-Samples ecosystem, bundled in `ui/public/samples/`. Each bank has
 * multiple variants selected with `s("flbass:2")` (sample index). See
 * ATTRIBUTION.md for per-bank provenance. Must stay in sync with
 * `INSTRUMENTS` in `crates/cycletron-analysis/src/sounds.rs`.
 */
export const INSTRUMENT_BANKS: Array<[string, string[]]> = [
    ['flbass', [
        'flbass/c2_finger_short.wav',
        'flbass/c3_finger_short.wav',
        'flbass/c2_palm_mute.wav',
        'flbass/c3_pick_short.wav',
    ]],
    ['uke', [
        'uke/c3_short_soft.wav',
        'uke/c3_short_hard.wav',
        'uke/c4_soft.wav',
        'uke/c4_harmonic.wav',
    ]],
    ['cpluck', [
        'cpluck/c2_short.wav',
        'cpluck/c3_short.wav',
        'cpluck/c4_pluck.wav',
        'cpluck/body_low.wav',
    ]],
    ['cbow', [
        'cbow/c2_short.wav',
        'cbow/c3_short.wav',
        'cbow/c4_short.wav',
        'cbow/c5_short.wav',
    ]],
    ['speech', [
        'speech/a.wav',
        'speech/b.wav',
        'speech/c.wav',
        'speech/d.wav',
        'speech/e.wav',
        'speech/f.wav',
        'speech/g.wav',
    ]],
];
