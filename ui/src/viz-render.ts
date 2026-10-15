/**
 * Offline visualizer render page (`viz-render.html`), driven headlessly by
 * `scripts/render-viz.mjs`. Evaluates a pattern in the engine (no audio
 * thread), replays the song's WAV through an {@link OfflineAnalyser}, and
 * paints one exact frame per `frame()` call on a fixed clock, so any length
 * renders identically at any speed. Each frame comes back as a PNG encoded
 * here: far cheaper than a DevTools screenshot, and rasterized on the CPU
 * from the first frame so every run, and every chunk, is bit-identical.
 */

import wasmInit, {getActiveLocsBufPtr, getCycleViewBufPtr, parsePattern} from '../pkg/strudel_audio_wasm.js';
import wasmUrl from '../pkg/strudel_audio_wasm_bg.wasm?url';
import {ActiveLocations} from './active-locations.js';
import {MusicCamera, type Section, TitleCards} from './viz/edit.js';
import {advanceScanlines, bandEnergies, paintFrame} from './viz/frame.js';
import {OfflineAnalyser} from './viz/offline-analyser.js';
import {VIZ_MODES} from './viz/registry.js';
import {StageCodeLayer, type StageFollow} from './viz/stage/code-layer.js';
import {readTheme} from './viz/theme.js';
import type {VizLayer, VizMode, VizModeDef, VizServices} from './viz/types.js';

type MutableServices = { -readonly [K in keyof VizServices]: VizServices[K] };

/**
 * Seconds painted (not returned) before the first frame when any scheduled
 * mode leaves trails, so its smear matches a render that started earlier:
 * long enough that 8-bit fades settle to the same pixels.
 */
const TRAIL_PREROLL_SECONDS = 3;

export interface RenderSetup {
    code: string;
    bpm: number;
    /** Mode schedule in song time: the first cut starts at 0, each runs until the next. */
    cuts: Cut[];
    width: number;
    height: number;
    fps: number;
    /** Song frame (at `fps`) this render starts on. Earlier frames still run to warm up state. */
    startFrame: number;
    sensitivity: number;
    /** URL of the song's mix. */
    audio: string;
    /** Overlay the code as Stage Mode draws it, following the music this way; null for visuals only. */
    code_follow: StageFollow | null;
    /** The song's sections, for the camera and title cards. */
    sections: Section[];
    /** Kick onsets, song seconds, ascending; the camera bumps on each. */
    kicks: number[];
    /** Move the camera over the mode with the song's structure. */
    camera: boolean;
    /** Title each section on its downbeat. */
    titles: boolean;
}

/** Switch to registry mode `mode` (e.g. `cockpit`) at song time `at` seconds. */
export interface Cut {
    at: number;
    mode: string;
}

interface Track {
    at: number;
    def: VizModeDef;
    mode: VizMode;
}

class OfflineRender {
    private readonly ctx: CanvasRenderingContext2D;
    /** One instance per scheduled cut; all step every frame so each is warm when cut to. */
    private tracks: Track[] = [];
    private shown: Track | null = null;
    private analyser!: OfflineAnalyser;
    private s!: MutableServices;
    private fps = 60;
    private cps = 0.5;
    private next = 0;
    /** Song time of the frame being stepped, in seconds. */
    private time = 0;
    private scanlineOffset = 0;
    private instances: {mode: VizMode}[] = [];
    private layers: VizLayer[] = [];
    private stageCode: {layer: StageCodeLayer; locations: ActiveLocations; code: string;
        pattern: ReturnType<typeof parsePattern>} | null = null;
    private camera: MusicCamera | null = null;

    constructor(private readonly canvas: HTMLCanvasElement) {
        // CPU raster from the start: Chrome otherwise moves a canvas off the GPU
        // once it sees repeated readbacks, shifting pixels mid-render.
        this.ctx = canvas.getContext('2d', {alpha: false, willReadFrequently: true})!;
    }

    async setup(opts: RenderSetup): Promise<void> {
        const memory = new WebAssembly.Memory({initial: 65, maximum: 16384, shared: true});
        await wasmInit({module_or_path: wasmUrl, memory});
        const pattern = parsePattern(opts.code);

        const bytes = await (await fetch(opts.audio)).arrayBuffer();
        const audio = await new OfflineAudioContext(2, 1, 44_100).decodeAudioData(bytes);
        this.analyser = new OfflineAnalyser(audio);

        if (opts.cuts[0]?.at !== 0) throw new Error('the first cut must start at 0');
        const instances = new Map<string, {def: VizModeDef; mode: VizMode}>();
        this.tracks = opts.cuts.map((cut) => {
            let instance = instances.get(cut.mode);
            if (!instance) {
                const def = VIZ_MODES.find((m) => m.id === cut.mode);
                if (!def) throw new Error(`unknown mode '${cut.mode}' (have: ${VIZ_MODES.map((m) => m.id).join(', ')})`);
                instance = {def, mode: def.create()};
                instances.set(cut.mode, instance);
            }
            return {at: cut.at, ...instance};
        });
        this.instances = [...instances.values()];
        this.shown = null;

        this.canvas.width = opts.width;
        this.canvas.height = opts.height;
        this.canvas.style.cssText = `display:block; width:${opts.width}px; height:${opts.height}px;`;
        this.fps = opts.fps;
        this.cps = opts.bpm / 240;
        const bins = this.analyser.frequencyBinCount;
        this.s = {
            width: opts.width,
            height: opts.height,
            dpr: 1,
            theme: readTheme(),
            cycle: 0,
            bpm: opts.bpm,
            low: 0,
            mid: 0,
            high: 0,
            freqData: new Uint8Array(bins),
            timeData: new Float32Array(bins),
            sampleRate: this.analyser.sampleRate,
            sensitivity: opts.sensitivity,
            patternSource: {scheduler: {pattern}, memory, cycleViewPtr: getCycleViewBufPtr()},
        };
        this.stageCode = null;
        this.layers = [];
        if (opts.code_follow) {
            const layer = new StageCodeLayer();
            layer.setCaretVisible(false);
            layer.setFollow(opts.code_follow);
            layer.setSnapshot({code: opts.code, cursor: 0, selFrom: 0, selTo: 0});
            this.stageCode = {layer, locations: new ActiveLocations(memory, getActiveLocsBufPtr()), code: opts.code, pattern};
            this.layers = [layer];
        }
        if (opts.titles) this.layers.push(new TitleCards(opts.sections, () => this.time));
        this.camera = opts.camera ? new MusicCamera(opts.sections, opts.kicks, opts.width) : null;
        for (const {mode} of this.instances) mode.layout(this.s);
        for (const layer of this.layers) layer.layout(this.s);

        // Simulate from song start so state at `start` matches a live run.
        this.next = 0;
        // Nothing else reads the canvas back, so only trails need painting to warm.
        const warm = opts.startFrame;
        const trails = this.tracks.some((t) => t.def.trailFade !== undefined);
        const preroll = trails ? Math.round(TRAIL_PREROLL_SECONDS * this.fps) : 0;
        while (this.next < warm) this.step(this.next >= warm - preroll);
    }

    /** Advance one frame, paint it, and return it as base64 PNG. */
    frame(): string {
        this.step(true);
        const url = this.canvas.toDataURL('image/png');
        return url.slice(url.indexOf(',') + 1);
    }

    private step(paint: boolean): void {
        const dt = 1 / this.fps;
        const t = this.next * dt;
        this.time = t;
        this.next += 1;
        const s = this.s;
        this.analyser.read(t, s.freqData!, s.timeData!);
        Object.assign(s, bandEnergies(s.freqData!, s.sensitivity));
        s.cycle = t * this.cps;
        for (const {mode} of this.instances) mode.update(dt, s);
        if (this.stageCode) {
            // Same query and lookahead as the live app's per-frame highlight.
            const {layer, locations, code, pattern} = this.stageCode;
            const count = pattern.queryActiveLocations(s.cycle, 0.5);
            if (count > 0) layer.setActiveRanges(locations.ranges(count, code));
            else layer.clearActiveRanges();
        }
        for (const layer of this.layers) layer.update(dt, s);
        this.scanlineOffset = advanceScanlines(this.scanlineOffset, dt);
        if (!paint) return;
        let track = this.tracks[0];
        for (const c of this.tracks) if (c.at <= t) track = c;
        // A cut must not inherit the previous mode's pixels through a trail fade.
        if (track !== this.shown && track.def.trailFade !== undefined) {
            this.ctx.fillStyle = s.theme.bg;
            this.ctx.fillRect(0, 0, s.width, s.height);
        }
        this.shown = track;
        paintFrame(this.ctx, track.def, track.mode, this.layers, s, this.scanlineOffset, this.camera?.at(t));
    }
}

const render = new OfflineRender(document.getElementById('stage') as HTMLCanvasElement);
(window as unknown as {vizRender: OfflineRender}).vizRender = render;
