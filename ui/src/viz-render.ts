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
import {direct, type Director, showCode} from './show/director.js';
import type {Cue, ShowSong} from './show/show.js';
import {advanceScanlines, bandEnergies, paintFrame} from './viz/frame.js';
import {OfflineAnalyser} from './viz/offline-analyser.js';
import {applyFinish, wash} from './viz/finish.js';
import {paletteTheme} from './viz/palettes.js';
import {Transitions} from './viz/transitions.js';
import {VIZ_MODES} from './viz/registry.js';
import {DEFAULT_FONT_PX, StageCodeLayer} from './viz/stage/code-layer.js';
import {readTheme} from './viz/theme.js';
import type {Theme, VizLayer, VizMode, VizModeDef, VizServices} from './viz/types.js';

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
    /** One pass of the song's form, in cycles, each section with its look from the show. Time past it wraps. */
    cues: Cue[];
    /** The song's passes and fades. */
    song: Pick<ShowSong, 'passes' | 'fade'>;
    width: number;
    height: number;
    fps: number;
    /** Song frame (at `fps`) this render starts on. Earlier frames still run to warm up state. */
    startFrame: number;
    sensitivity: number;
    /** URL of the song's mix. */
    audio: string;
}

interface Track {
    def: VizModeDef;
    mode: VizMode;
}

class OfflineRender {
    private readonly ctx: CanvasRenderingContext2D;
    /** One instance per mode the show uses, by id; all step every frame so each is warm when cut to. */
    private tracks = new Map<string, Track>();
    private shown: Track | null = null;
    private director!: Director;
    private transitions = new Transitions();
    /** The app's palette; a shot may draw in another. */
    private baseTheme!: Theme;
    private analyser!: OfflineAnalyser;
    private s!: MutableServices;
    private fps = 60;
    private cps = 0.5;
    private next = 0;
    private scanlineOffset = 0;
    private stageCode: {layer: StageCodeLayer; locations: ActiveLocations; code: string;
        pattern: ReturnType<typeof parsePattern>} | null = null;

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

        this.tracks = new Map();
        for (const id of opts.cues.flatMap(({look}) => [look.mode, ...(look.shots ?? []).map((shot) => shot.mode)])) {
            if (this.tracks.has(id)) continue;
            const def = VIZ_MODES.find((m) => m.id === id);
            if (!def) throw new Error(`unknown mode '${id}' (have: ${VIZ_MODES.map((m) => m.id).join(', ')})`);
            this.tracks.set(id, {def, mode: def.create()});
        }
        this.shown = null;

        this.canvas.width = opts.width;
        this.canvas.height = opts.height;
        this.canvas.style.cssText = `display:block; width:${opts.width}px; height:${opts.height}px;`;
        this.fps = opts.fps;
        this.cps = opts.bpm / 240;
        const bins = this.analyser.frequencyBinCount;
        const patternSource = {scheduler: {pattern}, memory, cycleViewPtr: getCycleViewBufPtr()};
        this.baseTheme = readTheme();
        this.s = {
            width: opts.width,
            height: opts.height,
            dpr: 1,
            theme: this.baseTheme,
            cycle: 0,
            bpm: opts.bpm,
            low: 0,
            mid: 0,
            high: 0,
            freqData: new Uint8Array(bins),
            timeData: new Float32Array(bins),
            sampleRate: this.analyser.sampleRate,
            sensitivity: opts.sensitivity,
            patternSource,
        };
        // The same cut the live show makes: kicks read from the pattern, as it plays.
        this.director = direct(opts.cues, this.cps, opts.song, pattern, patternSource);
        this.transitions = new Transitions();
        this.stageCode = null;
        if (opts.cues.some((c) => c.look.code.follow !== 'hide')) {
            const layer = new StageCodeLayer();
            layer.setCaretVisible(false);
            layer.setSnapshot({code: opts.code, cursor: 0, selFrom: 0, selTo: 0});
            this.stageCode = {layer, locations: new ActiveLocations(memory, getActiveLocsBufPtr()), code: opts.code, pattern};
            layer.layout(this.s);
        }
        for (const {mode} of this.tracks.values()) mode.layout(this.s);

        // Simulate from song start so state at `start` matches a live run.
        this.next = 0;
        // Only trails, and the frame a fade dissolves from, need painting to warm.
        const warm = opts.startFrame;
        const trails = [...this.tracks.values()].some((t) => t.def.trailFade !== undefined);
        const preroll = trails ? Math.round(TRAIL_PREROLL_SECONDS * this.fps) : 0;
        while (this.next < warm) this.step(this.next >= warm - preroll || this.fadeFollows());
    }

    /** Advance one frame, paint it, and return it as base64 PNG. */
    frame(): string {
        this.step(true);
        const url = this.canvas.toDataURL('image/png');
        return url.slice(url.indexOf(',') + 1);
    }

    /** Whether the frame after the next one starts a fade, which dissolves from the next one. */
    private fadeFollows(): boolean {
        if (!this.director.fades) return false;
        const entering = this.director.at(((this.next + 1) / this.fps) * this.cps).entering;
        return entering?.kind === 'fade' && entering.since < 1 / this.fps;
    }

    private step(paint: boolean): void {
        const dt = 1 / this.fps;
        const t = this.next * dt;
        this.next += 1;
        const s = this.s;
        this.analyser.read(t, s.freqData!, s.timeData!);
        Object.assign(s, bandEnergies(s.freqData!, s.sensitivity));
        s.cycle = t * this.cps;
        const frame = this.director.at(s.cycle);
        const theme = paletteTheme(frame.palette, this.baseTheme);
        if (theme !== s.theme) {
            // Modes bake their colors at layout.
            s.theme = theme;
            for (const {mode} of this.tracks.values()) mode.layout(s);
        }
        for (const {mode} of this.tracks.values()) mode.update(dt * frame.speed, s);
        const layers: VizLayer[] = [];
        if (this.stageCode) {
            // Same query and lookahead as the live app's per-frame highlight.
            const {layer, locations, code, pattern} = this.stageCode;
            const count = pattern.queryActiveLocations(s.cycle, 0.5);
            if (count > 0) layer.setActiveRanges(locations.ranges(count, code));
            else layer.clearActiveRanges();
            showCode(layer, frame, DEFAULT_FONT_PX);
            layer.update(dt, s);
            layers.push(layer);
        }
        layers.push(this.director.overlay);
        this.scanlineOffset = advanceScanlines(this.scanlineOffset, dt);
        if (!paint) return;
        const track = this.tracks.get(frame.mode)!;
        // A cut must not inherit the previous mode's pixels through a trail fade.
        if (track !== this.shown && track.def.trailFade !== undefined) {
            this.ctx.fillStyle = s.theme.bg;
            this.ctx.fillRect(0, 0, s.width, s.height);
        }
        this.shown = track;
        paintFrame(this.ctx, track.def, track.mode, layers, s, {
            scanlines: frame.scanlines ? this.scanlineOffset : null,
            view: frame.view ?? undefined,
            over: (ctx) => {
                this.transitions.apply(ctx, s, frame.entering, this.director.fades);
                wash(ctx, '#ffffff', frame.strobe);
                applyFinish(ctx, frame.finish, frame.time);
            },
            after: (ctx) => wash(ctx, '#000000', frame.dim),
        });
    }
}

const render = new OfflineRender(document.getElementById('stage') as HTMLCanvasElement);
(window as unknown as {vizRender: OfflineRender}).vizRender = render;
