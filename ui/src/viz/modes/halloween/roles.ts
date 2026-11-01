/**
 * What a hap is to the Halloween scenes. Drum sounds split finer than
 * `instrumentFamily` (toms and crashes get their own cue), and pitched notes
 * are classed by register, not by sound name, so a piano drone and a saw bass
 * land in the same row.
 */

export type Role = 'kick' | 'snare' | 'tom' | 'crash' | 'hat' | 'perc' | 'bass' | 'mid' | 'lead';

/** A note this long or longer is a ghost rather than a dancer. */
export const LONG_NOTE = 0.75;

export function halloweenRole(name: string, note: number): Role {
    if (Number.isFinite(note)) return note < 48 ? 'bass' : note < 72 ? 'mid' : 'lead';
    const lower = name.toLowerCase();
    // A machine voice spelled out, `RolandTR909_sd`, is classed by its voice.
    const voice = lower.indexOf('_');
    return voice > 0 ? drumRole(lower.slice(voice + 1)) : drumRole(lower);
}

function drumRole(n: string): Role {
    if (/^(bd|kick|808)/.test(n)) return 'kick';
    if (/^(sd|sn|cp|clap|rim)/.test(n)) return 'snare';
    if (/^(cr|crash|ride|rd)/.test(n)) return 'crash';
    if (/^(lt|mt|ht|tom)/.test(n)) return 'tom';
    if (/^(hh|oh|hat|shaker|tb|tamb|cb|cow)/.test(n)) return 'hat';
    return 'perc';
}

export function isLong(begin: number, end: number): boolean {
    return end - begin >= LONG_NOTE;
}

/** Where a pitch sits inside its register, 0..1. */
export function registerPos(note: number): number {
    const lo = note < 48 ? 24 : note < 72 ? 48 : 72;
    const hi = note < 48 ? 48 : note < 72 ? 72 : 96;
    const t = (note - lo) / (hi - lo);
    return t < 0 ? 0 : t > 1 ? 1 : t;
}
