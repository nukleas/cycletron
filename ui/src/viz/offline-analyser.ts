/**
 * An AnalyserNode replayed over decoded audio, for rendering visualizer frames
 * offline. Reproduces the Web Audio spec's analysis so modes see what they see
 * live: mono down-mix, Blackman window, |X|/N magnitude, exponential smoothing
 * across reads, then dB mapped onto bytes between min/max decibels. Reads must
 * come in frame order — smoothing carries state from one read to the next,
 * exactly as one `getByteFrequencyData` call per rAF does live.
 */

/** Must match the live analyser in `audio-manager.ts`. */
export const FFT_SIZE = 1024;
const SMOOTHING = 0.8;
const MIN_DB = -100;
const MAX_DB = -30;

export class OfflineAnalyser {
    readonly sampleRate: number;
    readonly frequencyBinCount = FFT_SIZE / 2;
    private readonly mono: Float32Array;
    private readonly window = blackman(FFT_SIZE);
    private readonly re = new Float64Array(FFT_SIZE);
    private readonly im = new Float64Array(FFT_SIZE);
    private readonly smoothed = new Float64Array(FFT_SIZE / 2);

    constructor(audio: AudioBuffer) {
        this.sampleRate = audio.sampleRate;
        this.mono = downmix(audio);
    }

    /** Fill `freq` and `time` as the live analyser would at `seconds`. */
    read(seconds: number, freq: Uint8Array, time: Float32Array): void {
        const end = Math.round(seconds * this.sampleRate);
        const start = end - FFT_SIZE;
        const sample = (i: number) => (i >= 0 && i < this.mono.length ? this.mono[i] : 0);

        // getFloatTimeDomainData copies the oldest `time.length` of the window.
        for (let i = 0; i < time.length; i++) time[i] = sample(start + i);

        for (let i = 0; i < FFT_SIZE; i++) {
            this.re[i] = sample(start + i) * this.window[i];
            this.im[i] = 0;
        }
        fft(this.re, this.im);
        const scale = 255 / (MAX_DB - MIN_DB);
        for (let k = 0; k < freq.length; k++) {
            const magnitude = Math.hypot(this.re[k], this.im[k]) / FFT_SIZE;
            this.smoothed[k] = SMOOTHING * this.smoothed[k] + (1 - SMOOTHING) * magnitude;
            const db = 20 * Math.log10(this.smoothed[k]);
            freq[k] = Math.max(0, Math.min(255, Math.floor(scale * (db - MIN_DB))));
        }
    }
}

function downmix(audio: AudioBuffer): Float32Array {
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] += data[i] / audio.numberOfChannels;
    }
    return out;
}

function blackman(n: number): Float64Array {
    const a = 0.16;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const x = (2 * Math.PI * i) / n;
        w[i] = (1 - a) / 2 - 0.5 * Math.cos(x) + (a / 2) * Math.cos(2 * x);
    }
    return w;
}

/** In-place iterative radix-2 FFT; length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const angle = (-2 * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const a = i + j;
                const b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci;
                const ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
            }
        }
    }
}
