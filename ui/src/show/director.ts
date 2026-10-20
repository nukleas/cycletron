/**
 * What a show shows at each moment of a song: the mode and its palette, the
 * camera's framing, the transition under way, strobe and fades, the title
 * cards and captions, and how the code follows. A pure function of song time
 * and the song's structure (its cued sections and drum onsets), so live
 * playback and the offline renderer cut the same video from it.
 */

import {Captions} from '../viz/captions.js';
import {type CameraStyle, MusicCamera, TitleCards, type View} from '../viz/edit.js';
import type {Finish} from '../viz/finish.js';
import {drumOnsets} from '../viz/tracks.js';
import type {Entering, Transition} from '../viz/transitions.js';
import type {PatternSource, VizLayer, VizServices} from '../viz/types.js';
import type {PatternHandle} from '../../pkg';
import type {StageCodeLayer} from '../viz/stage/code-layer.js';
import {clamp01} from '../viz/util.js';
import {type CodeLook, type Cue, formLength, type ShowSong, type Strobe} from './show.js';

/** Drum onsets within one pass of the form, in cycles, ascending. */
export interface Drums {
    kick: readonly number[];
    snare: readonly number[];
}

/** Strobe flash decay, seconds. */
const STROBE_DECAY = 0.06;

/** A stretch of one mode within a section: the whole section, or one of its shots. In cycles. */
interface Take {
    cue: Cue;
    start: number;
    end: number;
    mode: string;
    camera: CameraStyle | null;
    palette: string;
    transition: Transition;
}

/** What one moment shows. */
export interface Frame {
    cue: Cue;
    /** Changes at every cut. */
    take: object;
    mode: string;
    /** The camera's framing, or null for none. */
    view: View | null;
    /** The transition into this take while it lasts, else null. */
    entering: Entering | null;
    palette: string;
    finish: Finish;
    scanlines: boolean;
    /** Seconds into the playing pass of the form. */
    time: number;
    /** White over the visuals, 0 to 1: the strobe. */
    strobe: number;
    /** Black over everything, 0 to 1: the song fading in or out. */
    dim: number;
    /** How fast the visuals move, against the music's pace. */
    speed: number;
    code: CodeLook;
    /** How much of the code has typed in, 0 to 1, or null when it shows whole. */
    typed: number | null;
}

export class Director {
    /** The title cards and captions, drawn over the visuals and code as the latest frame says. */
    readonly overlay: VizLayer;
    /** Whether any take fades in, so hosts keep the frame a fade dissolves from. */
    readonly fades: boolean;
    private readonly camera: MusicCamera;
    private readonly takes: Take[];
    private readonly length: number;
    /** Seconds into the playing pass of the form. */
    private t = 0;
    /** Whether the latest frame's section shows its title card. */
    private titled = false;

    /**
     * `cues` are one pass of the song's form in cycles, at `cps`; `drums` are
     * onsets in cycles within that pass. Time past the form wraps, as the
     * song's selector does; `song` gives its passes and its fades.
     */
    constructor(cues: readonly Cue[], private readonly cps: number, private readonly drums: Drums,
        private readonly song: Pick<ShowSong, 'passes' | 'fade'>) {
        this.length = formLength(cues);
        this.takes = cues.flatMap(takesOf);
        this.fades = this.takes.some((t) => t.transition.kind === 'fade');
        const seconds = (c: number) => c / cps;
        const now = () => this.t;
        // Each take is a shot to the camera: a new move, and a punch on its cut.
        this.camera = new MusicCamera(this.takes.map((t) => ({label: t.cue.label, at: seconds(t.start), end: seconds(t.end)})),
            drums.kick.map(seconds));
        const titles = new TitleCards(cues.map((c) => ({
            label: c.label, at: seconds(c.startCycle), end: seconds(c.startCycle + c.cycles), title: c.look.title ?? undefined,
        })), now);
        const captions = new Captions(cues.flatMap((c) => c.look.text.map((line) => ({
            say: line.say, at: seconds(c.startCycle + line.at), until: seconds(c.startCycle + line.at + line.hold),
            place: line.place, style: line.style,
        }))), now);
        this.overlay = {
            layout: () => {},
            update: () => {},
            render: (ctx: CanvasRenderingContext2D, s: VizServices) => {
                if (this.titled) titles.render(ctx, s);
                captions.render(ctx, s);
            },
        };
    }

    /** The song `cycle`'s frame; the overlay draws this moment until the next call. */
    at(cycle: number): Frame {
        const pass = Math.floor(cycle / this.length);
        const wrapped = cycle - pass * this.length;
        this.t = wrapped / this.cps;
        let i = 0;
        while (i + 1 < this.takes.length && this.takes[i + 1].start <= wrapped) i++;
        const take = this.takes[i];
        const {look} = take.cue;
        this.titled = look.titles;
        return {
            cue: take.cue,
            take,
            mode: take.mode,
            view: take.camera ? this.camera.at(this.t, take.camera) : null,
            entering: entering(take, wrapped, this.cps, pass === 0 && i === 0),
            palette: take.palette,
            finish: look,
            scanlines: look.scanlines,
            time: this.t,
            strobe: look.strobe ? this.strobe(look.strobe, wrapped) : 0,
            dim: this.dim(cycle),
            speed: look.speed,
            code: look.code,
            typed: look.code.type === null ? null : clamp01((wrapped - take.cue.startCycle) / look.code.type),
        };
    }

    /** The flash from the latest hit at or before `cycle`. */
    private strobe({on, strength}: Strobe, cycle: number): number {
        const since = on === 'beat' ? cycle % 0.25 : sinceLast(this.drums[on], cycle);
        return since === null ? 0 : strength * Math.exp(-since / this.cps / STROBE_DECAY);
    }

    /** Black while the song fades up from its start, or down to its last pass's end. */
    private dim(cycle: number): number {
        const {fade, passes} = this.song;
        const end = passes * this.length;
        if (fade.in > 0 && cycle < fade.in) return 1 - cycle / fade.in;
        if (fade.out > 0 && cycle >= end - fade.out && cycle < end) return (cycle - (end - fade.out)) / fade.out;
        return 0;
    }
}

/** Show `frame`'s code on `layer`; `basePx` is the text size when the show doesn't set one. */
export function showCode(layer: StageCodeLayer, {code, typed}: Pick<Frame, 'code' | 'typed'>, basePx: number): void {
    layer.setHidden(code.follow === 'hide');
    if (code.follow !== 'hide') layer.setFollow(code.follow);
    layer.setBaseFontPx(code.size ?? basePx);
    layer.setStyle({place: code.place, opacity: code.opacity, scrim: code.scrim, typed});
}

/** A director for one pass of `cues`, its drums read from the song's pattern. */
export function direct(cues: readonly Cue[], cps: number, song: Pick<ShowSong, 'passes' | 'fade'>,
    pattern: PatternHandle | null, source: PatternSource | null): Director {
    const read = (family: 'kick' | 'snare') => (pattern && source ? drumOnsets(pattern, source, formLength(cues), family) : []);
    return new Director(cues, cps, {kick: read('kick'), snare: read('snare')}, song);
}

/** Cycles since the latest onset at or before `cycle`, or null before the first. */
function sinceLast(onsets: readonly number[], cycle: number): number | null {
    let lo = 0;
    let hi = onsets.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (onsets[mid] <= cycle) lo = mid + 1;
        else hi = mid;
    }
    return lo === 0 ? null : cycle - onsets[lo - 1];
}

/** The section as one take, or one per shot, cycling through its shots until it ends. */
function takesOf(cue: Cue): Take[] {
    const {look} = cue;
    const end = cue.startCycle + cue.cycles;
    const take = (start: number, stop: number, mode: string, camera: CameraStyle | null, palette: string): Take =>
        ({cue, start, end: stop, mode, camera, palette, transition: look.transition});
    if (!look.shots) return [take(cue.startCycle, end, look.mode, look.camera, look.palette)];
    const takes: Take[] = [];
    for (let start = cue.startCycle, i = 0; start < end; i++) {
        const shot = look.shots[i % look.shots.length];
        const stop = Math.min(end, start + (shot.bars ?? look.every));
        takes.push(take(start, stop, shot.mode, shot.camera === undefined ? look.camera : shot.camera, shot.palette ?? look.palette));
        start = stop;
    }
    return takes;
}

/** The transition into `take` at `cycle`, while it lasts. The song's opening fades up from black: there's nothing before it. */
function entering(take: Take, cycle: number, cps: number, opening: boolean): Entering | null {
    const {kind, bars} = take.transition;
    const since = cycle - take.start;
    if (kind === 'cut' || since >= bars) return null;
    return {kind: kind === 'fade' && opening ? 'black' : kind, p: since / bars, since: since / cps};
}
