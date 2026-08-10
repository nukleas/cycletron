/**
 * MIDI capture → strudel code.
 *
 * Records what you play (note-on AND note-off, so we know how long each note is
 * held) and converts it into a `note("…").sound("<instrument>")` line.
 *
 * Two things make the output musical rather than a frantic wall of rests:
 *
 *  1. **Cycle-aware bars.** strudel fits every top-level token of `note("…")`
 *     into a SINGLE cycle, so a flat string of dozens of slots plays absurdly
 *     fast. We quantize onsets to a sixteenth grid, group the slots into bars of
 *     16 (one 4/4 bar = one cycle at cps = bpm/240) and emit a slowcat
 *     `<[bar0] [bar1] …>` — one bar per cycle.
 *
 *  2. **Sustain, not silence.** Each note holds for its captured duration: the
 *     slots it covers are filled with `_` (extend previous element) rather than
 *     `~` (rest). Only genuine gaps become rests. Simultaneous notes stack as a
 *     chord `[c4,e4,g4]`.
 */

/** Strudel pitch-class spelling — matches `PC_LOWER` in the gen crate. */
const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

/** Notes whose onsets fall within this many ms are treated as one chord. */
const CHORD_WINDOW_MS = 45;

/** Sixteenth-note slots per bar in 4/4 — one bar maps to one cycle. */
const SLOTS_PER_BAR = 16;

interface CapturedNote {
    note: number;
    velocity: number;
    onset: number;
    durMs: number;
}

/** MIDI note number → strudel token, e.g. 60 → "c4". */
export function midiToNoteName(midi: number): string {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
}

function currentBpm(): number {
    const el = document.getElementById('bpmSlider') as HTMLInputElement | null;
    const v = el ? parseFloat(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 120;
}

type Slot = {kind: 'note' | 'hold' | 'rest'; tok: string};

class MidiCapture {
    private notes: CapturedNote[] = [];
    /** Notes currently held down: note number → onset time. */
    private active = new Map<number, {velocity: number; onset: number}>();
    /** Last event time seen, used to close still-held notes at commit. */
    private lastT = 0;

    noteOn(note: number, velocity: number, t: number): void {
        this.lastT = t;
        // A re-press without a note-off closes the previous sounding of this note.
        if (this.active.has(note)) this.noteOff(note, t);
        this.active.set(note, {velocity, onset: t});
    }

    noteOff(note: number, t: number): void {
        this.lastT = t;
        const a = this.active.get(note);
        if (!a) return;
        this.active.delete(note);
        this.notes.push({note, velocity: a.velocity, onset: a.onset, durMs: Math.max(1, t - a.onset)});
    }

    clear(): void {
        this.notes = [];
        this.active.clear();
    }

    count(): number {
        return this.notes.length + this.active.size;
    }

    hasNotes(): boolean {
        return this.count() > 0;
    }

    /** All notes, including any still held down (closed at the last seen time). */
    private flushed(): CapturedNote[] {
        const out = [...this.notes];
        for (const [note, a] of this.active) {
            out.push({note, velocity: a.velocity, onset: a.onset, durMs: Math.max(1, this.lastT - a.onset)});
        }
        return out;
    }

    /**
     * Build a `note("…").sound("<instrument>")` string from the buffered notes,
     * or `null` if nothing was captured.
     */
    toStrudel(instrument: string): string | null {
        const all = this.flushed();
        if (all.length === 0) return null;

        const sorted = all.sort((a, b) => a.onset - b.onset);

        // Group near-simultaneous onsets into chords; the group sustains for the
        // longest member note.
        const groups: {onset: number; notes: number[]; durMs: number}[] = [];
        for (const n of sorted) {
            const last = groups[groups.length - 1];
            if (last && n.onset - last.onset <= CHORD_WINDOW_MS) {
                last.notes.push(n.note);
                last.durMs = Math.max(last.durMs, n.durMs);
            } else {
                groups.push({onset: n.onset, notes: [n.note], durMs: n.durMs});
            }
        }

        const t0 = groups[0].onset;
        const stepMs = (60_000 / currentBpm()) / 4; // a sixteenth note
        const slotOf = (ms: number) => Math.round((ms - t0) / stepMs);

        // How many slots in total: cover the last note's release, padded to bars.
        let lastEnd = 1;
        for (const g of groups) {
            lastEnd = Math.max(lastEnd, slotOf(g.onset) + Math.max(1, Math.round(g.durMs / stepMs)));
        }
        const totalSlots = Math.ceil(lastEnd / SLOTS_PER_BAR) * SLOTS_PER_BAR;

        const slots: Slot[] = new Array(totalSlots);
        for (let i = 0; i < totalSlots; i++) slots[i] = {kind: 'rest', tok: '~'};

        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            const s = slotOf(g.onset);
            if (s < 0 || s >= totalSlots) continue;
            const uniqueSorted = [...new Set(g.notes)].sort((a, b) => a - b).map(midiToNoteName);
            const tok = uniqueSorted.length > 1 ? `[${uniqueSorted.join(',')}]` : uniqueSorted[0];
            slots[s] = {kind: 'note', tok};

            // Sustain across the held duration, but never past the next onset.
            const nextSlot = gi + 1 < groups.length ? slotOf(groups[gi + 1].onset) : totalSlots;
            const heldUntil = Math.min(s + Math.max(1, Math.round(g.durMs / stepMs)), nextSlot, totalSlots);
            for (let k = s + 1; k < heldUntil; k++) slots[k] = {kind: 'hold', tok};
        }

        const body = this.render(slots, totalSlots / SLOTS_PER_BAR);
        return `note("${body}").sound("${instrument}")`;
    }

    /** Render slots into mini-notation, grouping into one bar per cycle. */
    private render(slots: Slot[], bars: number): string {
        const renderSlot = (slot: Slot, isBarStart: boolean): string => {
            if (slot.kind === 'rest') return '~';
            if (slot.kind === 'note') return slot.tok;
            // A sustain at the start of a bar can't use `_` (no previous element
            // in this slowcat cycle), so re-articulate the held note instead.
            return isBarStart ? slot.tok : '_';
        };

        if (bars <= 1) {
            return slots.map((s, i) => renderSlot(s, i === 0)).join(' ');
        }

        const barStrs: string[] = [];
        for (let b = 0; b < bars; b++) {
            const start = b * SLOTS_PER_BAR;
            const slice = slots.slice(start, start + SLOTS_PER_BAR);
            barStrs.push(`[${slice.map((s, i) => renderSlot(s, i === 0)).join(' ')}]`);
        }
        return `<${barStrs.join(' ')}>`;
    }
}

export const midiCapture = new MidiCapture();
window.midiCapture = midiCapture;
