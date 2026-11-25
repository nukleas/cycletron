/**
 * Mixer — mute and solo the `$:` tracks of the current buffer, live.
 *
 * The editor buffer stays the source of truth. Mixer state is an override
 * layer applied on the way to the engine: muted tracks are blanked out of the
 * source handed to `parsePattern`, and the file on disk never changes.
 *
 * Blanking replaces a track's characters with spaces rather than deleting the
 * lines, which keeps every byte offset in the transformed source identical to
 * the editor's. That matters: the engine reports active-note locations as byte
 * offsets into the code it parsed, and `App.updateActiveNotes` maps them back
 * onto the editor document. Delete a line and every highlight below it lands on
 * the wrong token.
 *
 * Gain faders are deliberately absent. `.gain()` overwrites rather than scales
 * on this engine — `s("bd").gain(0.8).gain(0.5)` yields 0.5 — so an appended
 * gain would silently discard whatever the pattern set for itself. A real
 * fader needs per-orbit bus gain in the DSP engine; until then the mixer only
 * does what it can do exactly.
 */

/** A `$:` track located in the buffer. Offsets are character indices. */
export interface MixTrack {
    /** Position in the file, 0-based. The key mixer state is stored under. */
    index: number;
    label: string;
    /** Start of the `$:` line. */
    start: number;
    /** One past the track's last character. */
    end: number;
}

/** Line prefixes that end a track expression, mirroring the engine's file parser. */
const TERMINATORS = /^\s*(\$:|setbpm\b|setcpm\b|setcps\b|const\s|let\s|function\s|\/\/)/;
const TRACK_HEADER = /^\s*\$:/;
const COMMENT_LINE = /^\s*\/\//;

/**
 * Locate the `$:` tracks in `code`.
 *
 * A track runs from its `$:` line to the line before the next top-level
 * construct — another track, a directive, a binding, or a comment — matching
 * where the engine's own parser stops reading an expression.
 */
export function parseTracks(code: string): MixTrack[] {
    const lines = code.split('\n');

    // Character offset of each line start, plus a sentinel for EOF.
    const offsets: number[] = new Array(lines.length + 1);
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
        offsets[i] = at;
        at += lines[i].length + 1; // +1 for the '\n' we split on
    }
    offsets[lines.length] = code.length;

    const tracks: MixTrack[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (!TRACK_HEADER.test(lines[i])) continue;

        let end = i + 1;
        while (end < lines.length && !TERMINATORS.test(lines[end])) end++;

        tracks.push({
            index: tracks.length,
            label: labelFor(lines, i),
            start: offsets[i],
            // Clamp to the code length so a file with no trailing newline
            // doesn't produce an offset past the end.
            end: Math.min(offsets[end], code.length),
        });

        i = end - 1;
    }

    return tracks;
}

/**
 * Name a track: the comment directly above it if there is one, otherwise the
 * first sound or note it plays, otherwise its position.
 */
function labelFor(lines: string[], headerLine: number): string {
    for (let i = headerLine - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.trim() === '') continue;
        if (!COMMENT_LINE.test(line)) break;
        const text = line.replace(/^\s*\/\/+\s*/, '').trim();
        if (text) return text.slice(0, 28);
        break;
    }

    const expr = lines[headerLine];
    const sound = expr.match(/\b(?:s|sound)\(\s*["'`]([^"'`]*)/);
    if (sound?.[1]) {
        const first = sound[1].trim().split(/[\s*<>[\]({,]/).find(Boolean);
        if (first) return first.slice(0, 28);
    }
    if (/\bnote\(|\bn\(/.test(expr)) return 'note';

    return `Track ${headerLine + 1}`;
}

class Mixer {
    private muted = new Set<number>();
    private soloed = new Set<number>();
    private tracks: MixTrack[] = [];
    private list: HTMLElement | null = null;
    private panel: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private onChange: (() => void) | null = null;
    private _onSave: ((track: MixTrack) => void) | null = null;
    /** Label list of the last render, so keystrokes don't rebuild an identical panel. */
    private signature = '';

    /** When set, each row gets a button that hands its track to this. */
    get onSave(): ((track: MixTrack) => void) | null {
        return this._onSave;
    }

    set onSave(handler: ((track: MixTrack) => void) | null) {
        if (this._onSave === handler) return;
        this._onSave = handler;
        this.render();
    }

    /** `onChange` fires whenever the audible set changes and a re-eval is due. */
    init(onChange: () => void): void {
        this.onChange = onChange;
        this.panel = document.getElementById('mixerPanel');
        this.list = document.getElementById('mixerList');
        this.countEl = document.getElementById('mixerCount');
        this.render();
    }

    /** True when nothing is muted or soloed — the transform is then a no-op. */
    get isNeutral(): boolean {
        return this.muted.size === 0 && this.soloed.size === 0;
    }

    private audible(index: number): boolean {
        return this.soloed.size > 0 ? this.soloed.has(index) : !this.muted.has(index);
    }

    /**
     * Apply the current mute/solo state to `code`, returning what the engine
     * should actually parse. Length and every byte offset are preserved, except
     * for a trailing silent track appended when nothing is left audible — the
     * engine rejects a source with no tracks at all.
     */
    transform(code: string): string {
        if (this.isNeutral) return code;

        const tracks = parseTracks(code);
        if (tracks.length === 0) return code;

        const silenced = tracks.filter(t => !this.audible(t.index));
        if (silenced.length === 0) return code;

        const out = code.split('');
        for (const track of silenced) {
            for (let i = track.start; i < track.end; i++) {
                if (out[i] !== '\n') out[i] = ' ';
            }
        }

        const result = out.join('');
        return silenced.length === tracks.length ? `${result}\n$: silence\n` : result;
    }

    /**
     * Re-read the buffer's tracks and redraw. Mixer state is keyed by track
     * position, so entries beyond the current track count are dropped — editing
     * a track away releases its mute rather than leaving it stuck on a
     * neighbour that shifted up.
     */
    refresh(code: string): void {
        this.tracks = parseTracks(code);

        // Runs on every keystroke-driven evaluate; skip the DOM rebuild unless
        // the track list actually looks different.
        const signature = this.tracks.map(t => t.label).join('\0');
        const unchanged = signature === this.signature;
        this.signature = signature;

        const n = this.tracks.length;
        let changed = false;
        for (const set of [this.muted, this.soloed]) {
            for (const i of [...set]) {
                if (i >= n) {
                    set.delete(i);
                    changed = true;
                }
            }
        }
        if (!unchanged || changed) this.render();
        if (changed) this.onChange?.();
    }

    toggleMute(index: number): void {
        if (this.muted.has(index)) this.muted.delete(index);
        else this.muted.add(index);
        this.render();
        this.onChange?.();
    }

    toggleSolo(index: number): void {
        if (this.soloed.has(index)) this.soloed.delete(index);
        else this.soloed.add(index);
        this.render();
        this.onChange?.();
    }

    /**
     * Forget everything, without announcing a change.
     *
     * For loading a different document: mixer state is keyed by track position,
     * which means nothing once the buffer is a different piece of music. The
     * caller is already re-evaluating, so no `onChange` is fired.
     */
    reset(): void {
        this.muted.clear();
        this.soloed.clear();
        this.render();
    }

    /** Drop every mute and solo — the "everything back on" panic button. */
    clear(): void {
        if (this.isNeutral) return;
        this.muted.clear();
        this.soloed.clear();
        this.render();
        this.onChange?.();
    }

    private render(): void {
        if (!this.list) return;

        if (this.panel) this.panel.hidden = this.tracks.length === 0;
        if (this.countEl) {
            this.countEl.textContent = this.tracks.length ? `(${this.tracks.length})` : '';
        }

        this.list.replaceChildren(...this.tracks.map(track => {
            const row = document.createElement('div');
            row.className = 'mixer-row';
            if (!this.audible(track.index)) row.classList.add('mixer-row--silent');

            row.append(
                this.button('M', 'mute', track.index, this.muted.has(track.index),
                    `Mute ${track.label}`),
                this.button('S', 'solo', track.index, this.soloed.has(track.index),
                    `Solo ${track.label}`),
            );

            const name = document.createElement('span');
            name.className = 'mixer-name';
            name.textContent = track.label;
            name.title = track.label;
            row.append(name);

            if (this.onSave) {
                const save = document.createElement('button');
                save.type = 'button';
                save.className = 'mixer-btn';
                save.textContent = '+';
                save.setAttribute('aria-label', `Save ${track.label} as a part`);
                save.dataset.tooltip = 'Save as part';
                save.addEventListener('click', () => this.onSave?.(track));
                row.append(save);
            }

            return row;
        }));
    }

    private button(
        text: string,
        kind: 'mute' | 'solo',
        index: number,
        on: boolean,
        tip: string,
    ): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `mixer-btn mixer-btn--${kind}${on ? ' is-on' : ''}`;
        btn.textContent = text;
        btn.setAttribute('aria-label', tip);
        btn.setAttribute('aria-pressed', String(on));
        btn.dataset.tooltip = tip;
        btn.addEventListener('click', () => {
            if (kind === 'mute') this.toggleMute(index);
            else this.toggleSolo(index);
        });
        return btn;
    }
}

export const mixer = new Mixer();
