/**
 * Sample Loader
 *
 * Loads samples from URLs, decodes them via the AudioContext,
 * caches the AudioBuffer, and delivers PCM data to:
 *   1. The main-thread headless AudioProcessor (for hasSample/sampleCount)
 *   2. The AudioWorklet's DSP engine (for actual playback) via transferred ArrayBuffers
 */

import type {MainThreadProcessor} from './pkg';
import type {DecodedSample, StrudelAudioManager} from './audio-manager.js';
import {GM_BANK_NAMES, GM_FONT_FILES} from './soundfont-tables.js';

/**
 * A decoded soundfont zone retained on the JS side for the live MIDI monitor
 * ([`ui/src/midi-monitor.ts`]). Unlike [`DecodedSample`], these `AudioBuffer`s
 * are NOT shipped to the WASM engine — they're played directly on the main
 * thread via `AudioBufferSourceNode`, independent of the strudel scheduler.
 */
export interface MonitorZone {
    audioBuffer: AudioBuffer;
    /** Exact recording pitch in cents (e.g. 6000 = MIDI 60). */
    baseDetuneCents: number;
    /** Nearest MIDI note the sample was recorded at. */
    midiNote: number;
    keyRangeLow: number;
    keyRangeHigh: number;
    /** Loop start in decoded-rate samples, or 0xFFFFFFFF if the sample doesn't loop. */
    loopStart: number;
    loopEnd: number;
}

/** Marker for an unpitched sample (drum). */
const UNPITCHED = 0xFFFF_FFFF;

/** WebAudioFont CDN root — fallback when an instrument isn't bundled locally. */
const WAF_BASE_URL = 'https://felixroos.github.io/webaudiofontdata/sound';
/** Bundled soundfonts served same-origin from `ui/public/soundfonts/` (offline). */
const LOCAL_WAF_BASE = '/soundfonts';
/** Bundled drum kit served same-origin from `ui/public/samples/` (offline). */
const LOCAL_SAMPLES_BASE = '/samples/';
/**
 * Michael Fischer's 1994 TR-808 sample set (CC0), the source of the bundled
 * default kit — remote fallback if a file is somehow missing from the bundle.
 */
const FISCHER_808_BASE = 'https://raw.githubusercontent.com/tidalcycles/sounds-tr808-fischer/main/';

/**
 * Streamed drum machine kits live in the upstream tidal-drum-machines repo.
 * That collection carries no license, so we never redistribute it — kits
 * without a cleanly licensed replacement stream from here at runtime (as
 * strudel.cc does) and are simply absent offline.
 */
const TDM_BASE = 'https://raw.githubusercontent.com/geikha/tidal-drum-machines/master/machines/';

/**
 * All drum machine voices, each mapped to the URL it loads from.
 * Naming: `{MachineName}_{voice}` — these are the canonical web-strudel names.
 * The engine supports `.bank()` prefix lookup, so `s("bd").bank("RolandTR808")`
 * resolves to `RolandTR808_bd`; the full underscore name works too. A voice the
 * kit lacks (e.g. LinnDrum has no `cr`) resolves to nothing and plays silent.
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
 * These break the agent out of the 12-drum default kit: instead of reaching
 * for `rs(3,16).hpf()` as the only dry/metallic percussion, it gets real perc,
 * industrial, hand, and ethnic voices plus a bass, a pluck, and an atmosphere.
 * One representative sample per bank (index 0); use `s("perc:2")` for variety
 * once more indices are bundled. Each entry is [bankName, relativePath].
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
 * Fetch the first URL that responds OK, trying each in order. Used for
 * offline-first loading: a bundled same-origin path first, then a remote CDN.
 */
async function fetchFirstOk(urls: string[]): Promise<Response | null> {
    for (const u of urls) {
        try {
            const resp = await fetch(u, {mode: 'cors'});
            if (resp.ok) return resp;
        } catch {
            // try the next URL
        }
    }
    return null;
}

interface LoadKitResult {
    loaded: number;
    kit: string;
    /** Bank names that decoded and registered successfully. */
    names: string[];
}

interface WafZone {
    // cents, e.g. 6000 = MIDI 60 = C4
    originalPitch: number;
    // original recording rate (for loop-point scaling)
    sampleRate: number;
    // in original-rate samples; 0xFFFFFFFF = none
    loopStart: number;
    loopEnd: number;
    coarseTune: number;
    fineTune: number;
    // base64 MP3 data
    fileData: string;
    keyRangeLow: number;
    keyRangeHigh: number;
}

/**
 * Linear-scan parser for a WebAudioFont `.js` file's `zones` array. Avoids regex
 * backtracking over the multi-MB base64 sample strings. Ported from strudel-rs
 * www/wasm-repl.
 */
function parseWafJs(js: string): WafZone[] {
    const zones: WafZone[] = [];

    const zonesIdx = js.indexOf('zones');
    if (zonesIdx === -1) return zones;
    let i = js.indexOf('[', zonesIdx);
    if (i === -1) return zones;
    i++; // past '['

    const readNumber = (): number => {
        const s = i;
        if (js[i] === '-') i++;
        while (i < js.length && js[i] >= '0' && js[i] <= '9') i++;
        return parseInt(js.slice(s, i), 10);
    };

    while (i < js.length) {
        while (i < js.length && (js.charCodeAt(i) <= 32 || js[i] === ',')) i++;
        if (js[i] === ']') break;
        if (js[i] !== '{') { i++; continue; }
        i++; // past '{'

        let originalPitch = 6000;
        let sampleRate = 44100;
        let loopStart = 0xFFFF_FFFF;
        let loopEnd = 0;
        let coarseTune = 0;
        let fineTune = 0;
        let fileData = '';
        let keyRangeLow = 0;
        let keyRangeHigh = 127;

        while (i < js.length && js[i] !== '}') {
            while (i < js.length && (js.charCodeAt(i) <= 32 || js[i] === ',')) i++;
            if (js[i] === '}') break;

            const keyStart = i;
            while (i < js.length && js[i] !== ':' && js[i] !== '}') i++;
            const key = js.slice(keyStart, i).trim();
            if (js[i] !== ':') break;
            i++; // past ':'
            while (i < js.length && js.charCodeAt(i) <= 32) i++;

            if (key === 'file' || key === 'sample') {
                const q = js[i];
                if (q !== '"' && q !== "'") { i++; continue; }
                i++; // past opening quote
                const s = i;
                while (i < js.length && js[i] !== q) i++;
                fileData = js.slice(s, i);
                if (i < js.length) i++; // past closing quote
            } else if (key === 'originalPitch') {
                originalPitch = readNumber() || 6000;
            } else if (key === 'sampleRate') {
                sampleRate = readNumber() || 44100;
            } else if (key === 'loopStart') {
                loopStart = readNumber() || 0xFFFF_FFFF;
            } else if (key === 'loopEnd') {
                loopEnd = readNumber() || 0;
            } else if (key === 'coarseTune') {
                coarseTune = readNumber() || 0;
            } else if (key === 'fineTune') {
                fineTune = readNumber() || 0;
            } else if (key === 'keyRangeLow') {
                const parsed = readNumber();
                keyRangeLow = isNaN(parsed) ? 0 : parsed;
            } else if (key === 'keyRangeHigh') {
                const parsed = readNumber();
                keyRangeHigh = isNaN(parsed) ? 127 : parsed;
            } else {
                // Skip unknown value (string or primitive)
                if (js[i] === '"' || js[i] === "'") {
                    const q = js[i++];
                    while (i < js.length && js[i] !== q) i++;
                    if (i < js.length) i++;
                } else {
                    while (i < js.length && js[i] !== ',' && js[i] !== '}') i++;
                }
            }
        }
        if (js[i] === '}') i++; // past '}'

        if (fileData) {
            zones.push({
                originalPitch, sampleRate, loopStart, loopEnd,
                coarseTune, fineTune, fileData, keyRangeLow, keyRangeHigh,
            });
        }
    }
    return zones;
}

export class SampleLoader {
    processor: MainThreadProcessor;
    audioContext: AudioContext;
    audioManager: StrudelAudioManager;
    loading: Map<string, Promise<void>>;

    constructor(
        processor: MainThreadProcessor,
        audioContext: AudioContext,
        audioManager: StrudelAudioManager,
    ) {
        this.processor = processor;
        this.audioContext = audioContext;
        this.audioManager = audioManager;
        this.loading = new Map();
    }

    private _logSuccess(name: string): void {
        console.log(`[SampleLoader] loaded ${name}`);
    }

    async loadEssentialDrums(): Promise<number> {
        // The default 12-voice kit is Michael Fischer's 1994 TR-808 set (CC0),
        // bundled in ui/public/samples/ (offline); falls back to the upstream
        // repo if a file is somehow missing from the bundle. `sub` is the
        // bundled path, `src` the path inside the Fischer repo.
        const subs: Array<{ name: string; sub: string; src: string }> = [
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
        const essentials = subs.map(({name, sub, src}) => ({
            name,
            url: LOCAL_SAMPLES_BASE + sub,
            fallback: FISCHER_808_BASE + src,
        }));

        const result = await this._loadKitBatch(essentials, 'Essential Drums');
        return result.loaded;
    }

    /**
     * Load the bundled percussion & texture color pack ([`PERCUSSION_COLORS`])
     * from `ui/public/samples/`. Returns the bank names that loaded, so the
     * caller can register them with the backend (`register_sound_banks`) —
     * that's how the agent's `list_sounds` learns they exist and stops
     * defaulting to a lone rimshot for every percussion part.
     */
    async loadPercussionColors(): Promise<string[]> {
        const samples = PERCUSSION_COLORS.map(([name, sub]) => ({
            name,
            url: LOCAL_SAMPLES_BASE + sub,
        }));
        const {names} = await this._loadKitBatch(samples, 'Percussion Colors');
        return names;
    }

    /**
     * Load the bundled melodic/speech expansion banks ([`INSTRUMENT_BANKS`]) —
     * multi-variant unpitched one-shots (use `s("flbass:2")` for variants).
     * Returns bank names that had at least one sample load successfully.
     */
    async loadInstrumentBanks(): Promise<string[]> {
        const samples: Array<{name: string; url: string; sampleIdx: number}> = [];
        for (const [name, files] of INSTRUMENT_BANKS) {
            files.forEach((sub, i) => {
                samples.push({
                    name,
                    url: LOCAL_SAMPLES_BASE + sub,
                    sampleIdx: i,
                });
            });
        }
        const {names} = await this._loadKitBatch(samples, 'Instrument Banks');
        // One entry per sample file was returned; unique bank names for the agent.
        return [...new Set(names)];
    }

    /**
     * Load all drum machine kits ([`MACHINE_KITS`]) — bundled kits from
     * `ui/public/machines/`, unlicensed-upstream kits streamed at runtime.
     * Each voice is registered under `{MachineName}_{voice}`, e.g. `RolandTR808_bd`.
     * Use either the full name `s("RolandTR808_bd")` or the `.bank()` form
     * `s("bd").bank("RolandTR808")` — the engine resolves both to the same sample.
     * Returns the total number of voices loaded.
     */
    async loadMachineKits(): Promise<number> {
        let total = 0;
        for (const [machine, displayName, voices] of MACHINE_KITS) {
            const samples = voices.map(([v, url]) => ({
                name: `${machine}_${v}`,
                url,
            }));
            const {loaded} = await this._loadKitBatch(samples, displayName);
            total += loaded;
        }
        return total;
    }

    /**
     * Fetch a WebAudioFont `.js` file, decode every zone via the AudioContext,
     * and register the resulting key-zoned samples under `bankName` so that
     * `s("<bankName>")` plays a real multisampled instrument. `sampleIdx`
     * selects the soundfont variant (`bankName:N` in patterns).
     *
     * Returns the number of zones successfully registered (0 on failure).
     * De-duplication by (bankName, sampleIdx) is the caller's responsibility.
     */
    async loadWebAudioFont(bankName: string, fontFile: string, sampleIdx: number): Promise<number> {
        const fullName = sampleIdx === 0 ? bankName : `${bankName}:${sampleIdx}`;
        // Bundled soundfont first (offline, instant), CDN as fallback.
        const resp = await fetchFirstOk([
            `${LOCAL_WAF_BASE}/${fontFile}.js`,
            `${WAF_BASE_URL}/${fontFile}.js`,
        ]);
        if (!resp?.ok) {
            console.warn(`[SampleLoader] soundfont fetch failed: ${fontFile}`);
            return 0;
        }
        const js = await resp.text();

        const zones = parseWafJs(js);
        if (zones.length === 0) {
            console.warn(`[SampleLoader] no zones parsed from ${fontFile}`);
            return 0;
        }

        const decoded = await Promise.all(
            zones.map(async (zone): Promise<DecodedSample | null> => {
                try {
                    const binary = atob(zone.fileData);
                    const bytes = new Uint8Array(binary.length);
                    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                    const audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);

                    // baseDetune accounts for coarse + fine tuning (in cents).
                    const baseDetuneCents = zone.originalPitch - 100.0 * zone.coarseTune - zone.fineTune;
                    const midiNote = Math.round(baseDetuneCents / 100);

                    // Scale loop points from the zone's native rate to the decoded rate.
                    const hasLoop = zone.loopStart > 1 && zone.loopStart < zone.loopEnd;
                    const scale = audioBuffer.sampleRate / zone.sampleRate;
                    const loopStart = hasLoop ? Math.round(zone.loopStart * scale) : 0xFFFF_FFFF;
                    const loopEnd = hasLoop ? Math.round(zone.loopEnd * scale) : 0;

                    const item: DecodedSample = {
                        name: bankName,
                        audioBuffer,
                        midiNote,
                        sampleIdx,
                        loopStart,
                        loopEnd,
                        keyRangeLow: zone.keyRangeLow,
                        keyRangeHigh: zone.keyRangeHigh,
                        baseDetuneCents,
                    };
                    return item;
                } catch {
                    return null;
                }
            }),
        );

        const valid = decoded.filter((x): x is DecodedSample => x !== null);
        if (valid.length === 0) return 0;

        this.audioManager.sendSampleBatch(valid);
        console.log(`[SampleLoader] ${fontFile}: ${valid.length}/${zones.length} zones → "${fullName}"`);
        return valid.length;
    }

    /**
     * Decode a GM instrument's primary soundfont into [`MonitorZone`]s for the
     * live MIDI monitor. Reuses the same fetch/parse/decode path as
     * [`loadWebAudioFont`] but keeps the `AudioBuffer`s on the JS side instead
     * of shipping PCM to the WASM engine. Returns `[]` if the instrument is
     * unknown or the soundfont can't be fetched.
     */
    async loadMonitorInstrument(bankName: string): Promise<MonitorZone[]> {
        const idx = GM_BANK_NAMES.indexOf(bankName);
        const fonts = idx >= 0 ? GM_FONT_FILES[idx] : null;
        const fontFile = fonts && fonts.length > 0 ? fonts[0] : null;
        if (!fontFile) {
            console.warn(`[SampleLoader] no soundfont for monitor instrument "${bankName}"`);
            return [];
        }

        const resp = await fetchFirstOk([
            `${LOCAL_WAF_BASE}/${fontFile}.js`,
            `${WAF_BASE_URL}/${fontFile}.js`,
        ]);
        if (!resp?.ok) return [];
        const zones = parseWafJs(await resp.text());

        const out: MonitorZone[] = [];
        for (const zone of zones) {
            try {
                const binary = atob(zone.fileData);
                const bytes = new Uint8Array(binary.length);
                for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                const audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);

                const baseDetuneCents = zone.originalPitch - 100.0 * zone.coarseTune - zone.fineTune;
                const midiNote = Math.round(baseDetuneCents / 100);
                const hasLoop = zone.loopStart > 1 && zone.loopStart < zone.loopEnd;
                const scale = audioBuffer.sampleRate / zone.sampleRate;
                const loopStart = hasLoop ? Math.round(zone.loopStart * scale) : 0xFFFF_FFFF;
                const loopEnd = hasLoop ? Math.round(zone.loopEnd * scale) : 0;

                out.push({
                    audioBuffer,
                    baseDetuneCents,
                    midiNote,
                    keyRangeLow: zone.keyRangeLow,
                    keyRangeHigh: zone.keyRangeHigh,
                    loopStart,
                    loopEnd,
                });
            } catch {
                // skip undecodable zone
            }
        }
        console.log(`[SampleLoader] monitor "${bankName}": ${out.length}/${zones.length} zones`);
        return out;
    }

    /**
     * Decode and register a bank of local samples (raw file bytes already read
     * from disk by the Tauri backend). Treated as unpitched one-shots indexed
     * in array order, so `s("<name>")`, `s("<name>:1")`, … select variants.
     * Returns the number of samples successfully decoded.
     */
    async loadLocalBank(name: string, datas: ArrayBuffer[]): Promise<number> {
        const decoded = await Promise.all(
            datas.map(async (data, i): Promise<DecodedSample | null> => {
                try {
                    const audioBuffer = await this.audioContext.decodeAudioData(data);
                    return {
                        name,
                        audioBuffer,
                        midiNote: UNPITCHED,
                        sampleIdx: i,
                        loopStart: 0,
                        loopEnd: 0,
                        keyRangeLow: 255,
                        keyRangeHigh: 255,
                        baseDetuneCents: NaN,
                    };
                } catch (e) {
                    console.warn(`[SampleLoader] local "${name}" decode failed`, e);
                    return null;
                }
            }),
        );

        const valid = decoded.filter((x): x is DecodedSample => x !== null);
        if (valid.length === 0) return 0;
        this.audioManager.sendSampleBatch(valid);
        console.log(`[SampleLoader] local bank "${name}": ${valid.length}/${datas.length} samples`);
        return valid.length;
    }

    private async _loadKitBatch(
        samples: Array<{ name: string; url: string; fallback?: string; sampleIdx?: number }>,
        kit: string,
    ): Promise<LoadKitResult> {
        const decoded = await Promise.all(
            samples.map(async ({name, url, fallback, sampleIdx}) => {
                const resp = await fetchFirstOk(fallback ? [url, fallback] : [url]);

                if (!resp?.ok) {
                    console.warn(`[SampleLoader] ${kit} ${name}: Fetch failed`);
                    return null;
                }

                try {
                    const buffer = await resp.arrayBuffer();
                    const audioBuffer = await this.audioContext.decodeAudioData(buffer);
                    const item: DecodedSample = {
                        name,
                        audioBuffer,
                        midiNote: UNPITCHED,
                        sampleIdx: sampleIdx ?? 0,
                        loopStart: 0,
                        loopEnd: 0,
                        keyRangeLow: 255,
                        keyRangeHigh: 255,
                        baseDetuneCents: NaN,
                    };
                    return item;
                } catch (e) {
                    console.warn(`[SampleLoader] ${kit} ${name}: Decode failed`, e);
                    return null;
                }
            }),
        );

        const valid = decoded.filter((x): x is DecodedSample => x !== null);

        for (const {name, sampleIdx} of valid) {
            this._logSuccess(sampleIdx ? `${name}:${sampleIdx}` : name);
        }

        this.audioManager.sendSampleBatch(valid);
        const loaded = valid.length;
        return {loaded, kit, names: valid.map(v => v.name)};
    }
}
