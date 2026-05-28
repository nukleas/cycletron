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

interface LoadKitResult {
    loaded: number;
    kit: string;
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
        const base = 'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/';
        const essentials = [
            {name: 'bd', url: base + 'bd/BT0A0A7.wav'},
            {name: 'sd', url: base + 'sd/rytm-00-hard.wav'},
            {name: 'sn', url: base + 'sn/ST0T0S0.wav'},
            {name: 'hh', url: base + 'hh/000_hh3closedhh.wav'},
            {name: 'cp', url: base + 'cp/HANDCLP0.wav'},
            {name: 'oh', url: base + '808oh/OH00.WAV'},
            {name: 'ht', url: base + 'ht/HT0D0.wav'},
            {name: 'mt', url: base + 'mt/MT0D0.wav'},
            {name: 'lt', url: base + 'lt/LT0D0.wav'},
            {name: 'cr', url: base + 'cr/RIDED0.wav'},
            {name: 'cb', url: base + 'cb/rytm-cb.wav'},
            {name: 'rs', url: base + 'rs/rytm-rs.wav'},
        ];

        const result = await this._loadKitBatch(essentials, 'Essential Drums');
        return result.loaded;
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

    private async _loadKitBatch(
        samples: Array<{ name: string; url: string }>,
        kit: string,
    ): Promise<LoadKitResult> {
        const decoded = await Promise.all(
            samples.map(async ({name, url}) => {
                const resp = await fetch(url, {mode: 'cors'}).catch(() => null);

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
