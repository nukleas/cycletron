/**
 * Fitting a part to a song's key. The song's key is read from its notes, the
 * part is shifted by the fewest semitones that put it on the same seven notes,
 * and its note names are rewritten so the code still says what plays.
 */

export interface Key {
    /** Pitch class of the tonic, C = 0. */
    root: number;
    mode: string;
}

const LETTERS: Record<string, number> = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11};
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Semitones from a mode's tonic up to the major key with the same notes. */
const TO_MAJOR: Record<string, number> = {
    major: 0,
    ionian: 0,
    pentatonic: 0,
    locrian: 1,
    minor: 3,
    aeolian: 3,
    blues: 3,
    'harmonic minor': 3,
    'melodic minor': 3,
    mixolydian: 5,
    lydian: 7,
    phrygian: 8,
    'phrygian dominant': 8,
    dorian: 10,
};

// Krumhansl-Kessler key profiles: how strongly each scale step belongs to a key.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const NOTE_CALL = /\bnote\(\s*(["'`])([\s\S]*?)\1/g;
const NOTE_NAME = /(?<![\w#])([A-Ga-g])([#bs]?)(-?\d)?(?![\w#])/g;
const SCALE_CALL = /(\.scale\(\s*["'`])([A-Ga-g][#b]?)(\d?:)([a-z ]+)(?=["'`])/;

function accidentalShift(accidental: string): number {
    return accidental === '' ? 0 : accidental === 'b' ? -1 : 1;
}

function pitchClass(letter: string, accidental: string): number {
    return (LETTERS[letter.toLowerCase()] + accidentalShift(accidental) + 12) % 12;
}

function usesFlats(code: string): boolean {
    for (const call of code.matchAll(NOTE_CALL)) {
        for (const note of call[2].matchAll(NOTE_NAME)) if (note[2] === 'b') return true;
    }
    return false;
}

/** `"A:minor"` or `"Bb:harmonic minor"` as a key. */
export function parseKey(text: string | null | undefined): Key | null {
    const m = text?.match(/^([A-Ga-g])([#b]?):(.+)$/);
    return m ? {root: pitchClass(m[1], m[2]), mode: m[3].trim().toLowerCase()} : null;
}

export function keyName(key: Key): string {
    return `${SHARPS[key.root]} ${key.mode}`;
}

/** The key of some code: its `.scale(…)` when it names one, else the best fit to its notes. */
export function keyOf(code: string): Key | null {
    const scale = code.match(SCALE_CALL);
    if (scale) return parseKey(`${scale[2]}:${scale[4]}`);

    const counts = new Array<number>(12).fill(0);
    let total = 0;
    for (const call of code.matchAll(NOTE_CALL)) {
        if (isSwept(code, call.index + call[0].length)) continue;
        for (const note of call[2].matchAll(NOTE_NAME)) {
            counts[pitchClass(note[1], note[2])]++;
            total++;
        }
    }
    if (!total) return null;

    let best: Key | null = null;
    let bestFit = -Infinity;
    for (let root = 0; root < 12; root++) {
        for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
            const fit = correlation(counts, profile.map((_, i) => profile[(i - root + 12) % 12]));
            if (fit > bestFit) [best, bestFit] = [{root, mode}, fit];
        }
    }
    return best;
}

/**
 * True when the note call ending at `from` is swept an octave or more by a
 * pitch envelope: a synth kick or tom, whose written note says nothing of the key.
 */
function isSwept(code: string, from: number): boolean {
    const rest = code.slice(from);
    const chain = rest.slice(0, rest.search(/\bnote\(|\$:|$/));
    const depth = chain.match(/\.penv\(\s*(-?\d+(?:\.\d+)?)/);
    return depth !== null && Math.abs(Number(depth[1])) >= 12;
}

function correlation(a: number[], b: number[]): number {
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const [ma, mb] = [mean(a), mean(b)];
    let [top, da, db] = [0, 0, 0];
    for (let i = 0; i < a.length; i++) {
        top += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
    }
    return da && db ? top / Math.sqrt(da * db) : 0;
}

function majorRoot(key: Key): number {
    return (key.root + (TO_MAJOR[key.mode] ?? (key.mode.includes('minor') ? 3 : 0))) % 12;
}

/** Semitones, -6 to 5, that move a part in `from` onto the notes of `to`. */
export function shiftBetween(from: Key, to: Key): number {
    const up = (majorRoot(to) - majorRoot(from) + 12) % 12;
    return up > 5 ? up - 12 : up;
}

/**
 * `code` moved by `semitones`, note names and scale roots rewritten. Flats are
 * used when the code, or the song it is going into, already spells with them.
 */
export function transposed(code: string, semitones: number, song = ''): string {
    if (!semitones) return code;
    const names = usesFlats(code) || usesFlats(song) ? FLATS : SHARPS;
    let changed = false;

    let out = code.replace(NOTE_CALL, (call: string, _quote: string, body: string) => {
        const moved = body.replace(NOTE_NAME, (_name: string, letter: string, accidental: string, octave?: string) => {
            changed = true;
            // Not wrapped to 0..11: Cb3 is below C3, so the octave comes out right.
            const pitch = LETTERS[letter.toLowerCase()] + accidentalShift(accidental) + semitones;
            const name = names[((pitch % 12) + 12) % 12];
            const spelled = letter === letter.toLowerCase() ? name.toLowerCase() : name;
            return octave === undefined ? spelled : `${spelled}${Number(octave) + Math.floor(pitch / 12)}`;
        });
        return call.replace(body, () => moved);
    });

    out = out.replace(SCALE_CALL, (_all: string, open: string, root: string, sep: string, mode: string) => {
        changed = true;
        const at = (pitchClass(root[0], root.slice(1)) + semitones + 12) % 12;
        return `${open}${names[at]}${sep}${mode}`;
    });

    // Notes written some other way (numbers, chord symbols) are shifted as a whole.
    return changed ? out : `${code}.transpose(${semitones})`;
}

/** A pitched part's code fitted to the song, or as it is when either has no key. */
export function fitted(part: {code: string; key?: string | null; role?: string}, song: string): string {
    if (part.role === 'drums') return part.code;
    const from = parseKey(part.key) ?? keyOf(part.code);
    const to = keyOf(song);
    return from && to ? transposed(part.code, shiftBetween(from, to), song) : part.code;
}
