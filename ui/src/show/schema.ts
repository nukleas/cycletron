/**
 * What a show file may say: each table's keys, what each key does, and the
 * values it takes. The parser checks a show against this, and the show
 * pane's suggestions and hover text read it, so the three can't disagree.
 * The full guide is docs/SHOW_FILES.md (Help → Shows).
 */

import {CAMERA_MOVES} from '../viz/edit.js';
import {PALETTES} from '../viz/palettes.js';
import {TRANSITION_KINDS} from '../viz/transitions.js';

export const CODE_FOLLOW = ['hide', 'off', 'fold', 'solo'] as const;
export const CODE_PLACES = ['left', 'center', 'right'] as const;
export const STROBE_ON = ['kick', 'snare', 'beat'] as const;
export const CAPTION_PLACES = ['bottom', 'center', 'top'] as const;
export const CAPTION_STYLES = ['line', 'card'] as const;

/** A table in a show: a `[header]`, or the `{ … }` value of a key. */
export type TableName =
    | 'show' | 'defaults' | 'song' | 'sections' | 'section'
    | 'camera' | 'code' | 'transition' | 'strobe' | 'fade' | 'shot' | 'caption';

export interface KeyDoc {
    /** One or two plain sentences, shown on hover and beside a suggestion. */
    doc: string;
    /** Quoted words it takes; `modes` is the visual modes. */
    choices?: readonly string[] | 'modes';
    /** Bare values it takes, like `true` and `false`. */
    literals?: readonly string[];
    /** The table its `{ … }` value is, or each `{ … }` in its list. */
    table?: TableName;
    /** A list of `choices` (or of `table`s), like `shots`. */
    list?: boolean;
    /** A value to start from when the key is picked. */
    example?: string;
}

const BOOL = ['true', 'false'] as const;

/** The look keys: set in `[defaults]`, a song, or a section. */
const LOOK: Record<string, KeyDoc> = {
    code: {
        doc: 'How the song\'s code shows over the visuals: hide, off (all of it, still), fold, or solo. A table sets size, place, opacity, scrim and type too.',
        choices: CODE_FOLLOW, table: 'code', example: '"solo"',
    },
    camera: {
        doc: 'How the camera moves: true, false, a move, or { move, punch, kick }.',
        choices: CAMERA_MOVES, literals: BOOL, table: 'camera', example: '"drift"',
    },
    titles: {doc: 'A title card on each section\'s downbeat.', literals: BOOL, example: 'true'},
    every: {doc: 'Bars each shot holds when it doesn\'t say.', example: '4'},
    transition: {
        doc: 'How each shot is entered: cut, flash, fade, black or glitch, or { kind, bars }.',
        choices: TRANSITION_KINDS, table: 'transition', example: '"flash"',
    },
    palette: {doc: 'The colors the visuals are drawn in.', choices: PALETTES, example: '"neon"'},
    letterbox: {doc: 'Cinema bars cropping to an aspect, like 2.39; more than 1, at most 4. false for none.', literals: ['false'], example: '2.39'},
    grain: {doc: 'Film grain, 0 to 1.', example: '0.15'},
    scanlines: {doc: 'The faint scanline texture.', literals: BOOL, example: 'false'},
    strobe: {
        doc: 'A white flash on each kick, snare or beat, or { on, strength }. false for none.',
        choices: STROBE_ON, literals: ['false'], table: 'strobe', example: '"kick"',
    },
    speed: {doc: 'How fast the visuals move against the music: 0.5 is slow motion, 2 double, 0 frozen, 4 at most.', example: '1'},
};

/** Render settings, in `[defaults]` or a song. */
const AUDIO: Record<string, KeyDoc> = {
    gain_db: {doc: 'Render volume, in dB.', example: '0'},
    sensitivity: {doc: 'How strongly the visuals react to the audio. 1 is normal.', example: '1'},
};

const MODE: KeyDoc = {doc: 'The visual mode.', choices: 'modes', example: '"tunnel"'};

export const SCHEMA: Record<TableName, Record<string, KeyDoc>> = {
    show: {
        title: {doc: 'The show\'s name.', example: '"My Show"'},
        out: {doc: 'Where a render goes, relative to this file.', example: '"renders/my-show.mp4"'},
        size: {doc: 'The render\'s frame size, "WIDTHxHEIGHT". Default "1920x1080".', example: '"1920x1080"'},
        fps: {doc: 'The render\'s frame rate. Default 60.', example: '60'},
    },
    defaults: {...LOOK, ...AUDIO},
    song: {
        source: {doc: 'The .strudel song, relative to this file (~ works).', example: '"../Songs/my-song.strudel"'},
        mode: {...MODE, doc: 'The mode for sections not listed. Required unless the song has shots.'},
        shots: {doc: 'Modes to cut between, in turn, through every section not listed.', choices: 'modes', table: 'shot', list: true, example: '["tunnel", "plasma"]'},
        passes: {doc: 'Times through the song\'s form before the next song. Default 1.', example: '1'},
        fade: {doc: 'Bars fading up from black at the start and down at the end: { in, out }.', table: 'fade', example: '{ in = 2, out = 2 }'},
        performance: {doc: 'A performance-export directory to render from. Without it, the render exports the song itself.', example: '"performance"'},
        sections: {doc: 'Looks for the song\'s sections, by label.', table: 'sections'},
        ...LOOK,
        ...AUDIO,
    },
    // Keys here are the song's section labels; each is a mode, or a table.
    sections: {},
    section: {
        mode: {...MODE, doc: 'The mode for this section, held through it.'},
        shots: {doc: 'Modes to cut between through this section. Give mode or shots, not both.', choices: 'modes', table: 'shot', list: true, example: '["tunnel", "plasma"]'},
        title: {doc: 'This section\'s title card text, in place of // LABEL. Turns the card on.', example: '"INTRO"'},
        text: {doc: 'Words on screen: a list of { say, at, hold, place, style }.', table: 'caption', list: true, example: '[{ say = "hello", at = 1 }]'},
        ...LOOK,
    },
    camera: {
        move: {doc: 'drift, push, pull, orbit, still or shake.', choices: CAMERA_MOVES, example: '"orbit"'},
        punch: {doc: 'The slam out on each cut. 1 is normal, 0 none, 4 at most.', example: '1'},
        kick: {doc: 'The bump on each kick drum. 1 is normal, 0 none, 4 at most.', example: '1'},
    },
    code: {
        follow: {doc: 'hide shows none, off all of it, fold collapses the sections not playing, solo shows only the playing one.', choices: CODE_FOLLOW, example: '"solo"'},
        size: {doc: 'Text size in px at 1080p, 10 to 96.', example: '22'},
        place: {doc: 'left, center or right.', choices: CODE_PLACES, example: '"right"'},
        opacity: {doc: '0 to 1, to sit the code back behind the visuals.', example: '0.6'},
        scrim: {doc: 'The dark backing behind each row.', literals: BOOL, example: 'false'},
        type: {doc: 'Bars over which the code types in from the section\'s downbeat. false to show it whole.', literals: ['false'], example: '2'},
    },
    transition: {
        kind: {doc: 'cut, flash, fade, black or glitch.', choices: TRANSITION_KINDS, example: '"fade"'},
        bars: {doc: 'Bars the transition takes.', example: '1'},
    },
    strobe: {
        on: {doc: 'kick, snare or beat.', choices: STROBE_ON, example: '"kick"'},
        strength: {doc: '0 to 1; 1 is a full white flash. Default 0.6.', example: '0.3'},
    },
    fade: {
        in: {doc: 'Bars fading up from black at the song\'s start.', example: '2'},
        out: {doc: 'Bars fading down to black at the end of its last pass.', example: '2'},
    },
    shot: {
        mode: MODE,
        bars: {doc: 'Bars this shot holds. Default: the look\'s every.', example: '2'},
        camera: LOOK.camera,
        palette: LOOK.palette,
    },
    caption: {
        say: {doc: 'The words. Quotes inside need \\".', example: '"hello"'},
        at: {doc: 'Bars into the section it appears. Default 0.', example: '1'},
        hold: {doc: 'Bars it stays before fading. Default 2.', example: '2'},
        place: {doc: 'bottom, center or top. Default bottom for a line, center for a card.', choices: CAPTION_PLACES, example: '"top"'},
        style: {doc: 'line is a caption that types in; card is a big glitching card.', choices: CAPTION_STYLES, example: '"card"'},
    },
};

/** The keys a table takes. */
export function keysOf(table: TableName): readonly string[] {
    return Object.keys(SCHEMA[table]);
}

/** The closest of `options` to a misspelled `word`, if one is near enough to suggest. */
export function closest(word: string, options: readonly string[]): string | null {
    let best: string | null = null;
    let bestDistance = Math.max(1, Math.floor(word.length / 3)) + 1;
    for (const option of options) {
        const d = distance(word.toLowerCase(), option.toLowerCase());
        if (d < bestDistance) {
            best = option;
            bestDistance = d;
        }
    }
    return best;
}

/** Edit distance, counting a swap of two neighbours as one. */
function distance(a: string, b: string): number {
    const d: number[][] = Array.from({length: a.length + 1}, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}
