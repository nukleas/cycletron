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

/** Marker for an unpitched sample (drum). */
const UNPITCHED = 0xFFFF_FFFF;

/** WebAudioFont CDN root — fallback when an instrument isn't bundled locally. */
const WAF_BASE_URL = 'https://felixroos.github.io/webaudiofontdata/sound';
/** Bundled soundfonts served same-origin from `ui/public/soundfonts/` (offline). */
const LOCAL_WAF_BASE = '/soundfonts';
/** Bundled drum kit served same-origin from `ui/public/samples/` (offline). */
const LOCAL_SAMPLES_BASE = '/samples/';
/** Remote drum kit, used as a fallback when a sample isn't bundled. */
const DIRT_SAMPLES_BASE = 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/';
/** Bundled drum machine kits in `ui/public/machines/`. */
const LOCAL_MACHINES_BASE = '/machines/';

/**
 * All bundled drum machine voices.
 * Naming: `{MachineName}_{voice}` — these are the canonical web-strudel names
 * (what `.bank("RolandTR808")` + `s("bd")` resolves to once the strudel-rs engine
 * supports `.bank()` prefix lookup). Until then, use the full name directly in `s("…")`.
 *
 * Grouped as [machineName, displayName, voices[]].
 */
export const BUNDLED_MACHINE_KITS: Array<[string, string, string[]]> = [
    ['RolandTR808', 'TR-808',   ['bd','sd','hh','oh','cp','rim','lt','mt','ht','cb']],
    ['RolandTR909', 'TR-909',   ['bd','sd','hh','oh','cp','rd','rim']],
    ['RolandTR707', 'TR-707',   ['bd','sd','hh','oh','cp','lt','ht']],
    ['LinnDrum',    'LinnDrum', ['bd','sd','hh','cp']],
    ['BossDR55',    'DR-55',    ['bd','sd','hh','rim']],
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
        // Bundled in ui/public/samples/ (offline); falls back to Dirt-Samples
        // over the network if a file is somehow missing from the bundle.
        const subs: Array<{ name: string; sub: string }> = [
            {name: 'bd', sub: 'bd/BT0A0A7.wav'},
            {name: 'sd', sub: 'sd/rytm-00-hard.wav'},
            {name: 'sn', sub: 'sn/ST0T0S0.wav'},
            {name: 'hh', sub: 'hh/000_hh3closedhh.wav'},
            {name: 'cp', sub: 'cp/HANDCLP0.wav'},
            {name: 'oh', sub: '808oh/OH00.WAV'},
            {name: 'ht', sub: 'ht/HT0D0.wav'},
            {name: 'mt', sub: 'mt/MT0D0.wav'},
            {name: 'lt', sub: 'lt/LT0D0.wav'},
            {name: 'cr', sub: 'cr/RIDED0.wav'},
            {name: 'cb', sub: 'cb/rytm-cb.wav'},
            {name: 'rs', sub: 'rs/rytm-rs.wav'},
        ];
        const essentials = subs.map(({name, sub}) => ({
            name,
            url: LOCAL_SAMPLES_BASE + sub,
            fallback: DIRT_SAMPLES_BASE + sub,
        }));

        const result = await this._loadKitBatch(essentials, 'Essential Drums');
        return result.loaded;
    }

    /**
     * Load all bundled drum machine kits from `ui/public/machines/` (offline-first).
     * Each voice is registered under `{MachineName}_{voice}`, e.g. `RolandTR808_bd`.
     * These are the canonical web-strudel `.bank()` equivalents — use them directly
     * in patterns as `s("RolandTR808_bd")` until strudel-rs adds `.bank()` prefixing.
     * Returns the total number of voices loaded.
     */
    async loadMachineKits(): Promise<number> {
        let total = 0;
        for (const [machine, displayName, voices] of BUNDLED_MACHINE_KITS) {
            const samples = voices.map(v => ({
                name: `${machine}_${v}`,
                url:  `${LOCAL_MACHINES_BASE}${machine}_${v}.wav`,
            }));
            const {loaded} = await this._loadKitBatch(samples, displayName);
            total += loaded;
        }
        return total;
    }

    async loadTR808(): Promise<LoadKitResult> {
        const base = 'https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/RolandTR808/';
        const samples = [
            {name: 'bd', url: base + 'roland808-bd/BD.wav'},
            {name: 'sd', url: base + 'roland808-sd/SD0010.wav'},
            {name: 'hh', url: base + 'roland808-hh/CH.wav'},
            {name: 'oh', url: base + 'roland808-oh/OH00.wav'},
            {name: 'cp', url: base + 'roland808-cp/CP.wav'},
            {name: 'cb', url: base + 'roland808-cb/CB.wav'},
            {name: 'rs', url: base + 'roland808-rim/RS.wav'},
        ];
        return this._loadKitBatch(samples, 'TR-808');
    }

    async loadTR909(): Promise<LoadKitResult> {
        const base = 'https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/RolandTR909/';
        const samples = [
            {name: 'bd', url: base + 'roland909-bd/BT3A0A7.wav'},
            {name: 'sd', url: base + 'roland909-sd/ST0T0S3.wav'},
            {name: 'hh', url: base + 'roland909-hh/HHCD4.wav'},
            {name: 'oh', url: base + 'roland909-oh/OHHD0.wav'},
            {name: 'cp', url: base + 'roland909-cp/HANDCLP1.wav'},
            {name: 'rd', url: base + 'roland909-rd/RD0010.wav'},
        ];
        return this._loadKitBatch(samples, 'TR-909');
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
     * Decode and register a bank of local samples (raw file bytes already read
     * from disk by the Tauri backend). Treated as unpitched one-shots indexed
     * in array order, so `s("<name>")`, `s("<name>:1")`, … select variants.
     * Returns the number of samples successfully decoded.
     */
    async loadLocalBank(name: string, datas: ArrayBuffer[]): Promise<number> {
        const decoded = await Promise.all(
            datas.map(async (data): Promise<DecodedSample | null> => {
                try {
                    const audioBuffer = await this.audioContext.decodeAudioData(data);
                    return {
                        name,
                        audioBuffer,
                        midiNote: UNPITCHED,
                        sampleIdx: 0,
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
        samples: Array<{ name: string; url: string; fallback?: string }>,
        kit: string,
    ): Promise<LoadKitResult> {
        const decoded = await Promise.all(
            samples.map(async ({name, url, fallback}) => {
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
                        sampleIdx: 0,
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

        for (const {name} of valid) {
            this._logSuccess(name);
        }

        this.audioManager.sendSampleBatch(valid);
        const loaded = valid.length;
        return {loaded, kit};
    }
}
