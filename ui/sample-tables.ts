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

/** uzu-drumkit (Unlicense) — hat/ride/rim/shaker variants Fischer cannot provide. */
export const UZU_BASE = 'https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/';

/**
 * Streamed drum machine kits live in the upstream tidal-drum-machines repo.
 * That collection carries no license, so we never redistribute it — kits
 * without a cleanly licensed replacement stream from here at runtime (as
 * strudel.cc does) and are simply absent offline.
 */
export const TDM_BASE = 'https://raw.githubusercontent.com/geikha/tidal-drum-machines/master/machines/';

/** One file in a default-kit bank. `sub` is under `ui/public/samples/`. */
export type DrumFile = {
    sub: string;
    /** Path inside the Fischer repo (CDN fallback). */
    fischer?: string;
    /** Path inside uzu-drumkit (CDN fallback). */
    uzu?: string;
};

export type DrumBank = {
    name: string;
    files: DrumFile[];
};

/** Fischer 808 knob positions used in filenames. */
const KNOBS = ['00', '25', '50', '75', '10'] as const;

function fischer(sub: string, dir8: string, name: string): DrumFile {
    return {sub: `${sub}/${name}`, fischer: `${dir8}/${name}`};
}

function uzu(sub: string, rel: string): DrumFile {
    return {sub: `${sub}/${rel.split('/').pop()!}`, uzu: rel};
}

/** Two-knob Fischer grid (25 files). `keepFirst` stays `:0` so existing patterns match. */
function fischerGrid2(bank: string, dir8: string, prefix: string, keepFirst: string): DrumFile[] {
    const names: string[] = [];
    for (const a of KNOBS) {
        for (const b of KNOBS) names.push(`${prefix}${a}${b}.WAV`);
    }
    return [keepFirst, ...names.filter((n) => n !== keepFirst)].map((n) => fischer(bank, dir8, n));
}

/** One-knob Fischer grid (5 files). */
function fischerGrid1(bank: string, dir8: string, prefix: string, keepFirst: string): DrumFile[] {
    const names = KNOBS.map((k) => `${prefix}${k}.WAV`);
    return [keepFirst, ...names.filter((n) => n !== keepFirst)].map((n) => fischer(bank, dir8, n));
}

const UZU_HH = [
    'hh/10_hh_switchangel.wav',
    'hh/11_hh_mot4i.wav',
    'hh/12_hh_switchangel.wav',
    'hh/13_hh_switchangel.wav',
    'hh/14_hh_mot4i.wav',
];
const UZU_RIM = [
    'rim/10_rim_switchangel.wav',
    'rim/11_rim_switch_angel.wav',
];

/**
 * Default kit, bundled in `ui/public/samples/` (offline).
 *
 * Fischer's 1994 TR-808 (CC0) fills `bd`/`sd`/`oh`/`cr`/toms/congas with every
 * knob take (`:n` walks them). Closed hat has only one Fischer file, so `hh:1+`
 * and `rd`/`rim`/`sh`/`tb`/`brk` come from uzu-drumkit (Unlicense).
 * Index 0 of each pre-existing bank is the file Cycletron already shipped.
 */
export const ESSENTIAL_DRUMS: DrumBank[] = [
    {name: 'bd', files: fischerGrid2('bd', 'bd8', 'BD', 'BD0050.WAV')},
    {name: 'sd', files: fischerGrid2('sd', 'sd8', 'SD', 'SD5050.WAV')},
    {name: 'sn', files: [fischer('sn', 'sd8', 'SD0075.WAV')]},
    {name: 'hh', files: [fischer('hh', 'ch8', 'CH.WAV'), ...UZU_HH.map((rel) => uzu('hh', rel))]},
    {name: 'cp', files: [fischer('cp', 'cp8', 'CP.WAV')]},
    {name: 'oh', files: fischerGrid1('oh', 'oh8', 'OH', 'OH00.WAV')},
    {name: 'ht', files: fischerGrid1('ht', 'ht8', 'HT', 'HT50.WAV')},
    {name: 'mt', files: fischerGrid1('mt', 'mt8', 'MT', 'MT50.WAV')},
    {name: 'lt', files: fischerGrid1('lt', 'lt8', 'LT', 'LT50.WAV')},
    {name: 'cr', files: fischerGrid2('cr', 'cy8', 'CY', 'CY0050.WAV')},
    {name: 'cb', files: [fischer('cb', 'cb8', 'CB.WAV')]},
    {name: 'rs', files: [fischer('rs', 'rs8', 'RS.WAV'), ...UZU_RIM.map((rel) => uzu('rim', rel))]},
    {name: 'rim', files: [fischer('rs', 'rs8', 'RS.WAV'), ...UZU_RIM.map((rel) => uzu('rim', rel))]},
    {name: 'rd', files: [uzu('rd', 'rd/10_rd_switchangel.wav')]},
    {name: 'sh', files: [uzu('sh', 'sh/10_sh_switchangel.wav')]},
    {name: 'tb', files: [uzu('tb', 'tb/10_tb.wav')]},
    {name: 'brk', files: [uzu('brk', 'brk/10_break_amen_pprocessed.wav')]},
    {name: 'cl', files: [fischer('cl', 'cl8', 'CL.WAV')]},
    {name: 'ma', files: [fischer('ma', 'ma8', 'MA.WAV')]},
    {name: 'lc', files: fischerGrid1('lc', 'lc8', 'LC', 'LC50.WAV')},
    {name: 'mc', files: fischerGrid1('mc', 'mc8', 'MC', 'MC50.WAV')},
    {name: 'hc', files: fischerGrid1('hc', 'hc8', 'HC', 'HC50.WAV')},
];

/**
 * Kits recorded from a Roland TR-8 (MckAudio/MckSamplePacks, CC0): its models
 * of the 909, 606 and 727, not the original machines. Voices follow strudel.cc's
 * names for these machines. Each take is [voice, path under the pack's `TR8/`];
 * `scripts/vendor-tr8.mjs` trims and converts them into `ui/public/machines/`.
 */
export const TR8_KITS: Array<[string, string, Array<[string, string]>]> = [
    ['RolandTR909', 'TR-909', [
        ['bd',  'BD/004_909_Bass_Drum_1.wav'],
        ['bd',  'BD/005_909_Bass_Drum_2.wav'],
        ['bd',  'BD/006_909_Bass_Drum_3.wav'],
        ['bd',  'BD/012_909_AttackBD_1.wav'],
        ['sd',  'SD/005_909_Snare_Drum_1.wav'],
        ['sd',  'SD/006_909_Snare_Drum_2.wav'],
        ['sd',  'SD/007_909_Snare_Drum_3.wav'],
        ['sd',  'SD/011_909_AttackSD_1.wav'],
        ['hh',  'HATS/008_909_Closed_HiHat.wav'],
        ['hh',  'HATS/010_909_Closed_HiHat_Short.wav'],
        ['oh',  'HATS/007_909_Open_HiHat.wav'],
        ['oh',  'HATS/009_909_Open_HiHat_Short.wav'],
        ['cp',  'PERC/019_909_Hand_Clap.wav'],
        ['cp',  'PERC/020_909_Hand_Clap_Long.wav'],
        ['rim', 'PERC/009_909_Rim_Shot.wav'],
        ['cr',  'HATS/020_909_Crash_Cymbal.wav'],
        ['cr',  'HATS/021_909_Crash_Cymbal_Short.wav'],
        ['rd',  'HATS/026_909_Ride_Cymbal.wav'],
        ['rd',  'HATS/027_909_Ride_Cymbal_Short.wav'],
        ['lt',  'TOMS/010_909_Low_Tom.wav'],
        ['lt',  'TOMS/013_909_Low_Tom_Short.wav'],
        ['mt',  'TOMS/011_909_Mid_Tom.wav'],
        ['mt',  'TOMS/014_909_Mid_Tom_Short.wav'],
        ['ht',  'TOMS/012_909_High_Tom.wav'],
        ['ht',  'TOMS/015_909_High_Tom_Short.wav'],
    ]],
    ['RolandTR606', 'TR-606', [
        ['bd',  'BD/015_606_Bass_Drum_1.wav'],
        ['bd',  'BD/016_606_Bass_Drum_2.wav'],
        ['bd',  'BD/017_606_Bass_Drum_3.wav'],
        ['sd',  'SD/013_606_Snare_Drum_1.wav'],
        ['sd',  'SD/014_606_Snare_Drum_2.wav'],
        ['sd',  'SD/015_606_Snare_Drum_3.wav'],
        ['hh',  'HATS/014_606_Closed_HiHat.wav'],
        ['hh',  'HATS/016_606_Closed_HiHat_Long.wav'],
        ['oh',  'HATS/013_606_Open_HiHat.wav'],
        ['oh',  'HATS/015_606_Open_HiHat_Long.wav'],
        ['cr',  'HATS/024_606_Cymbal.wav'],
        ['cr',  'HATS/025_606_Cymbal_Short.wav'],
        ['lt',  'TOMS/035_606_Low_Tom.wav'],
        ['lt',  'TOMS/034_606_Floor_Tom.wav'],
        ['ht',  'TOMS/036_606_High_Tom.wav'],
        ['ht',  'TOMS/039_606_High_Tom_Long.wav'],
    ]],
    ['RolandTR727', 'TR-727', [
        ['perc', 'PERC/001_727_Low_Conga.wav'],
        ['perc', 'PERC/002_727_Open_High_Conga.wav'],
        ['perc', 'PERC/003_727_Mute_High_Conga.wav'],
        ['perc', 'PERC/006_727_Low_Bongo.wav'],
        ['perc', 'PERC/007_727_High_Bongo.wav'],
        ['perc', 'PERC/004_727_Low_Timbale.wav'],
        ['perc', 'PERC/005_727_High_Timbale.wav'],
        ['perc', 'PERC/014_727_Agogo_Low.wav'],
        ['perc', 'PERC/015_727_Agogo_Mid.wav'],
        ['perc', 'PERC/016_727_Agogo_High.wav'],
        ['perc', 'PERC/029_727_Short_Whistle.wav'],
        ['perc', 'PERC/030_727_Long_Whistle.wav'],
        ['perc', 'PERC/031_727_Quijada.wav'],
        ['perc', 'PERC/035_727_Star_Chime.wav'],
        ['sh',   'PERC/028_727_Cabasa.wav'],
    ]],
];

/** How many earlier takes share take `i`'s voice: its `:n`. */
export function takeIndex(takes: Array<[string, string]>, i: number): number {
    return takes.slice(0, i).filter(([v]) => v === takes[i][0]).length;
}

/** Bundled path of a TR-8 take: `RolandTR909_bd.wav`, then `RolandTR909_bd-1.wav`, … */
export function tr8Url(machine: string, voice: string, n: number): string {
    return `/machines/${machine}_${voice}${n ? `-${n}` : ''}.wav`;
}

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
 * LinnDrum (BushDrum, CC0) and the TR-8 kits below are bundled in
 * `ui/public/machines/`; DR-55 has no cleanly licensed sample set, so it
 * streams from upstream. See ATTRIBUTION.md.
 * Grouped as [machineName, displayName, [voice, url][]]; a voice listed more
 * than once gets `:n` variants in listed order.
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
    ...TR8_KITS.map(([machine, display, takes]): [string, string, Array<[string, string]>] => [
        machine,
        display,
        takes.map(([voice], i) => [voice, tr8Url(machine, voice, takeIndex(takes, i))]),
    ]),
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

/**
 * VCSL instruments — a curated slice of the Versilian Community Sample
 * Library (CC0), bundled so a koto-free orchestra is playable offline. Pitched
 * banks are note-mapped (the engine picks the nearest recorded note and
 * repitches, like a downloaded set); one-shot banks index `:n` variants.
 * Files are trimmed, faded and MP3-encoded by `scripts/vendor-vcsl.mjs`
 * from the sources in `scripts/vcsl-sources.json`. Must stay in sync with
 * `VCSL_PITCHED` / `VCSL_ONESHOTS` in `crates/cycletron-analysis/src/sounds.rs`.
 */
export const VCSL_PITCHED: Array<[string, Record<string, string>]> = [
    ['kalimba', {
        B2: 'kalimba/B2.mp3',
        Ds3: 'kalimba/Ds3.mp3',
        Gs3: 'kalimba/Gs3.mp3',
        Cs4: 'kalimba/Cs4.mp3',
        Fs4: 'kalimba/Fs4.mp3',
        B4: 'kalimba/B4.mp3',
    }],
    ['marimba', {
        F1: 'marimba/F1.mp3',
        G2: 'marimba/G2.mp3',
        F3: 'marimba/F3.mp3',
        C4: 'marimba/C4.mp3',
        B4: 'marimba/B4.mp3',
        C6: 'marimba/C6.mp3',
    }],
    ['vibraphone', {
        F2: 'vibraphone/F2.mp3',
        C3: 'vibraphone/C3.mp3',
        G3: 'vibraphone/G3.mp3',
        D4: 'vibraphone/D4.mp3',
        A4: 'vibraphone/A4.mp3',
        E5: 'vibraphone/E5.mp3',
    }],
    ['glockenspiel', {
        G4: 'glockenspiel/G4.mp3',
        G5: 'glockenspiel/G5.mp3',
        C6: 'glockenspiel/C6.mp3',
        G6: 'glockenspiel/G6.mp3',
        C7: 'glockenspiel/C7.mp3',
    }],
    ['tubularbells', {
        C3: 'tubularbells/C3.mp3',
        E3: 'tubularbells/E3.mp3',
        Gs3: 'tubularbells/Gs3.mp3',
        C4: 'tubularbells/C4.mp3',
        E4: 'tubularbells/E4.mp3',
    }],
    ['harp', {
        E1: 'harp/E1.mp3',
        D2: 'harp/D2.mp3',
        C3: 'harp/C3.mp3',
        B3: 'harp/B3.mp3',
        C5: 'harp/C5.mp3',
        B5: 'harp/B5.mp3',
        A6: 'harp/A6.mp3',
        F7: 'harp/F7.mp3',
    }],
    ['ocarina', {
        A3: 'ocarina/A3.mp3',
        Cs4: 'ocarina/Cs4.mp3',
        Fs4: 'ocarina/Fs4.mp3',
        As4: 'ocarina/As4.mp3',
        Cs5: 'ocarina/Cs5.mp3',
    }],
    ['recorder_alto_sus', {
        F3: 'recorder_alto_sus/F3.mp3',
        As3: 'recorder_alto_sus/As3.mp3',
        D4: 'recorder_alto_sus/D4.mp3',
        Gs4: 'recorder_alto_sus/Gs4.mp3',
        C5: 'recorder_alto_sus/C5.mp3',
        E5: 'recorder_alto_sus/E5.mp3',
    }],
    ['balafon', {
        Cs3: 'balafon/Cs3.mp3',
        F3: 'balafon/F3.mp3',
        C4: 'balafon/C4.mp3',
        F4: 'balafon/F4.mp3',
        C5: 'balafon/C5.mp3',
        F5: 'balafon/F5.mp3',
    }],
    ['harmonica', {
        C3: 'harmonica/C3.mp3',
        C4: 'harmonica/C4.mp3',
        G4: 'harmonica/G4.mp3',
        E5: 'harmonica/E5.mp3',
        C6: 'harmonica/C6.mp3',
    }],
    ['steinway', {
        As0: 'steinway/As0.mp3',
        Gs1: 'steinway/Gs1.mp3',
        E2: 'steinway/E2.mp3',
        D3: 'steinway/D3.mp3',
        As3: 'steinway/As3.mp3',
        Gs4: 'steinway/Gs4.mp3',
        E5: 'steinway/E5.mp3',
        D6: 'steinway/D6.mp3',
        As6: 'steinway/As6.mp3',
        Gs7: 'steinway/Gs7.mp3',
    }],
    ['strumstick', {
        D2: 'strumstick/D2.mp3',
        G2: 'strumstick/G2.mp3',
        Cs3: 'strumstick/Cs3.mp3',
        Fs3: 'strumstick/Fs3.mp3',
        B3: 'strumstick/B3.mp3',
        E4: 'strumstick/E4.mp3',
        A4: 'strumstick/A4.mp3',
    }],
    ['psaltery_pluck', {
        As3: 'psaltery_pluck/As3.mp3',
        D4: 'psaltery_pluck/D4.mp3',
        Fs4: 'psaltery_pluck/Fs4.mp3',
        As4: 'psaltery_pluck/As4.mp3',
        D5: 'psaltery_pluck/D5.mp3',
        Fs5: 'psaltery_pluck/Fs5.mp3',
    }],
    ['dantranh', {
        B1: 'dantranh/B1.mp3',
        Fs2: 'dantranh/Fs2.mp3',
        B2: 'dantranh/B2.mp3',
        Ds3: 'dantranh/Ds3.mp3',
        B3: 'dantranh/B3.mp3',
        Ds4: 'dantranh/Ds4.mp3',
        B4: 'dantranh/B4.mp3',
    }],
];

export const VCSL_ONESHOTS: Array<[string, string[]]> = [
    ['gong', ['gong/00.mp3', 'gong/01.mp3', 'gong/02.mp3']],
    ['timpani', ['timpani/00.mp3', 'timpani/01.mp3', 'timpani/02.mp3', 'timpani/03.mp3']],
    ['didgeridoo', ['didgeridoo/00.mp3', 'didgeridoo/01.mp3', 'didgeridoo/02.mp3']],
    ['bongo', ['bongo/00.mp3', 'bongo/01.mp3', 'bongo/02.mp3', 'bongo/03.mp3']],
    ['shaker_small', ['shaker_small/00.mp3', 'shaker_small/01.mp3', 'shaker_small/02.mp3']],
    ['tambourine', ['tambourine/00.mp3', 'tambourine/01.mp3', 'tambourine/02.mp3']],
    ['agogo', ['agogo/00.mp3', 'agogo/01.mp3', 'agogo/02.mp3']],
    ['guiro', ['guiro/00.mp3', 'guiro/01.mp3']],
    ['sleighbells', ['sleighbells/00.mp3', 'sleighbells/01.mp3']],
    ['triangles', ['triangles/00.mp3', 'triangles/01.mp3', 'triangles/02.mp3']],
    ['framedrum', ['framedrum/00.mp3', 'framedrum/01.mp3', 'framedrum/02.mp3']],
    ['darbuka', ['darbuka/00.mp3', 'darbuka/01.mp3', 'darbuka/02.mp3', 'darbuka/03.mp3']],
];
