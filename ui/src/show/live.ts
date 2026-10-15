/**
 * Plays a show file live: a setlist of songs, each section showing the mode
 * and code follow the show gives it, with the show file in a pane beside the
 * song.
 *
 * The playing song is the editor document — the stage draws the editor's
 * code, and the audience should see the song. The pane's buffer, not the file
 * on disk, is the show that plays: an edit takes effect after a short pause,
 * and a broken one is marked in the pane while the last good show plays on.
 *
 * Each song plays its form `passes` times, then the next starts on that
 * downbeat at its own cycle 0 and tempo (`PatternScheduler.setPatternAt`). A
 * few cycles ahead the next song is read, parsed and its sounds preloaded.
 * A song with unsaved edits holds the set — moving on would drop the edits —
 * and the last song loops.
 */

import {ambientViz} from '../ambient-viz.js';
import {confirmDialog, errorDialog, saveChangesDialog} from '../dialog.js';
import {fileManager} from '../file-manager.js';
import {basename} from '../paths.js';
import {stage} from '../stage.js';
import {invoke} from '../tauri.js';
import {VIZ_MODES} from '../viz/registry.js';
import {locate} from './locate.js';
import {showPane} from './show-pane.js';
import {
    cue, cueAt, formLength, parseShow, ShowError, type Cue, type FormSection, type ShowContext, type ShowSong,
} from './show.js';

/** How often the playing song's form and the show file on disk are checked for changes. */
const POLL_MS = 1500;
/** Cycles before a song ends that the next one is loaded and armed. */
const PREPARE_CYCLES = 4;
/** Cycles of the next song whose sounds are fetched ahead. */
const PRELOAD_CYCLES = 8;

interface LabeledSection {
    label: string;
    start_cycle: number;
    cycles: number;
}

interface SongDoc {
    path: string;
    code: string;
    frontmatter: {bpm?: number} | null;
}

/** A song of the setlist with its code and cued form. */
interface Planned {
    song: ShowSong;
    code: string;
    cues: Cue[];
}

/** The song to play next, loaded; armed in the scheduler when `songPending`. */
interface Next {
    index: number;
    source: string;
    code: string;
    /** The song's frontmatter tempo, for songs without `setbpm`. */
    bpm: number | undefined;
    /** At the end of the playing song, or at the next cycle (skipping). */
    at: 'end' | 'now';
}

class LiveShow {
    private path: string | null = null;
    private ctx: ShowContext | null = null;
    private plan: Planned[] = [];
    private current = 0;
    private next: Next | null = null;
    private preparing = false;
    /** A song failed to load; retried once the show is edited. */
    private stalled = false;
    /** The set is holding on unsaved song edits; reported once. */
    private holding = false;
    /** The song code the playing song's cues were made from. */
    private cuedCode = '';
    private playing: Cue | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** True while a reload prompt is up, so the poll doesn't stack them. */
    private asking = false;

    constructor() {
        // Opening another file ends the show; the song stays open as a plain song.
        document.addEventListener('file:changed', (e) => {
            const path = (e as CustomEvent<{path: string | null}>).detail.path;
            const playing = this.plan[this.current]?.song.source;
            if (this.path && path !== playing) void this.stop({cancellable: false});
        });
    }

    async open(path: string): Promise<void> {
        let text: string;
        let ctx: ShowContext;
        let plan: Planned[];
        try {
            text = await invoke<string>('read_text', {path});
            ctx = await context(path);
            plan = await planSongs(parseShow(text, ctx).songs);
        } catch (e) {
            await errorDialog(`Could not open show:\n${message(e)}`);
            return;
        }
        // Reopening a show (or opening another) first settles the one open.
        if (!(await this.stop())) return;
        // A set starts from its first song's cycle 0, not wherever the transport is.
        window.strudelApp?.stop();

        const first = plan[0].song.source;
        await fileManager.openPath(first);
        // Declined the unsaved-changes prompt, or the song failed to open.
        if (fileManager.filePath !== first) return;
        const app = window.strudelApp;
        if (!app?.editor) return;

        this.path = path;
        this.ctx = ctx;
        this.plan = plan;
        this.current = 0;
        this.cuedCode = app.editor.getCode();
        showPane.open(path, text, {
            onEdit: (edited) => void this.apply(edited),
            onClose: () => void this.stop(),
        });
        app.onSongStarted = () => void this.promote();
        app.onTick = (cycle) => this.advance(cycle);
        ambientViz.setModeDriver((cycle) => this.direct(cycle));
        this.timer = setInterval(() => void this.poll(), POLL_MS);
        // Song and show stay in view, to edit while it plays; ⌘⇧F is the stage.
        await app.play();
        this.announce();
    }

    /** End the show, offering to save an edited show file first. False if cancelled or the save failed. */
    async stop({cancellable = true} = {}): Promise<boolean> {
        if (!this.path) return true;
        if (showPane.isDirty) {
            const question = `Save your changes to "${basename(this.path)}"?`;
            const answer = cancellable
                ? await saveChangesDialog(question)
                : (await confirmDialog(question, {okLabel: 'Save', cancelLabel: 'Discard'})) ? 'save' : 'discard';
            if (answer === 'cancel') return false;
            if (answer === 'save') {
                try {
                    await showPane.save();
                } catch (e) {
                    await errorDialog(`Could not save show:\n${message(e)}`);
                    return false;
                }
            }
        }
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        const app = window.strudelApp;
        if (app) {
            app.cancelSong();
            app.onSongStarted = null;
            app.onTick = null;
        }
        this.path = null;
        this.ctx = null;
        this.plan = [];
        this.current = 0;
        this.next = null;
        this.stalled = false;
        this.holding = false;
        this.playing = null;
        showPane.close();
        ambientViz.setModeDriver(null);
        stage.setShowFollow(null);
        return true;
    }

    /** Skip to the next (+1) or previous (−1) song, from the next cycle. */
    async skip(delta: number): Promise<void> {
        const app = window.strudelApp;
        if (!this.path || !app) return;
        const target = this.current + delta;
        if (target < 0 || target >= this.plan.length) {
            status(delta > 0 ? 'Set: this is the last song' : 'Set: this is the first song');
            return;
        }
        if (this.preparing) {
            status('Set: loading the next song');
            return;
        }
        if (fileManager.isDirty && !(await confirmDialog(`Discard your unsaved changes to "${fileManager.fileName}" and move on?`, {kind: 'warning'}))) return;
        if (app.songPending && !app.cancelSong()) {
            status('Set: a song change is landing');
            return;
        }
        this.next = null;
        await this.prepare(target, 'now');
    }

    /** The section playing at `cycle` sets the code follow and names the mode. */
    private direct(cycle: number): string {
        const playing = cueAt(this.plan[this.current].cues, cycle);
        if (playing !== this.playing) {
            this.playing = playing;
            showPane.setPlaying(this.playingLine(showPane.text));
        }
        stage.setShowFollow(playing.look.code);
        return playing.look.mode;
    }

    /**
     * Each scheduling tick: load the next song near the end of this one, and
     * arm it — again after a pause, seek or stop disarmed it.
     */
    private advance(cycle: number): void {
        const app = window.strudelApp;
        if (!app || this.preparing) return;
        if (this.next) {
            if (!app.songPending) this.arm(cycle);
            return;
        }
        const target = this.current + 1;
        if (target >= this.plan.length || this.stalled) return;
        const {cues, song} = this.plan[this.current];
        if (cycle < formLength(cues) * song.passes - PREPARE_CYCLES) return;
        if (fileManager.isDirty) {
            if (!this.holding) status(`Set: holding on "${fileManager.fileName}" — save it to move on at the next section`);
            this.holding = true;
            return;
        }
        this.holding = false;
        void this.prepare(target, 'end');
    }

    private async prepare(index: number, at: Next['at']): Promise<void> {
        const app = window.strudelApp;
        if (!app) return;
        const {song} = this.plan[index];
        this.preparing = true;
        try {
            const doc = await invoke<SongDoc>('read_song', {path: song.source});
            const cues = cue(song, await form(doc.code));
            if (this.plan[index]?.song !== song) return;
            this.plan[index] = {song, code: doc.code, cues};
            const {pattern} = app.parseSong(doc.code);
            app.preloadSong(pattern, PRELOAD_CYCLES);
            pattern.free();
            this.next = {index, source: song.source, code: doc.code, bpm: doc.frontmatter?.bpm, at};
        } catch (e) {
            this.stalled = true;
            status(`Set: can't play "${basename(song.source)}": ${message(e)}`);
        } finally {
            this.preparing = false;
        }
    }

    /** Hand the next song to the scheduler, to start on its boundary. */
    private arm(cycle: number): void {
        const app = window.strudelApp;
        const next = this.next;
        if (!app || !next) return;
        try {
            const {pattern, bpm} = app.parseSong(next.code);
            app.startSongAt(pattern, this.boundary(cycle, next), bpm ?? next.bpm);
        } catch (e) {
            this.next = null;
            this.stalled = true;
            status(`Set: can't play "${basename(next.source)}": ${message(e)}`);
        }
    }

    /** The cycle the next song starts on: the playing song's end, or once a hold clears, the next section's start. */
    private boundary(cycle: number, next: Next): number {
        if (next.at === 'now') return Math.ceil(cycle);
        const {cues, song} = this.plan[this.current];
        const length = formLength(cues);
        const end = length * song.passes;
        if (cycle < end) return end;
        const pass = Math.floor(cycle / length) * length;
        const section = cues.find((c) => pass + c.startCycle > cycle);
        return section ? pass + section.startCycle : pass + length;
    }

    /** The next song is heard: it becomes the playing song and the editor's document. */
    private async promote(): Promise<void> {
        const next = this.next;
        if (!next || !this.path) return;
        this.next = null;
        // The setlist may have been edited since this song was loaded.
        const index = this.plan.findIndex((p) => p.song.source === next.source);
        this.current = index >= 0 ? index : next.index;
        this.cuedCode = next.code;
        this.playing = null;
        await fileManager.openPath(next.source, {force: true, playing: true});
        this.announce();
    }

    private announce(): void {
        if (this.plan.length > 1) {
            status(`Set ${this.current + 1}/${this.plan.length} · ${basename(this.plan[this.current].song.source)}`);
        }
    }

    /** The line that sets the playing section's look: its entry, or its song's `mode`. */
    private playingLine(text: string): number | null {
        if (!this.playing) return null;
        const at = `song[${this.plan[this.current].song.index}]`;
        const entry = locate(text, `${at}.sections.${this.playing.label}`);
        return entry.exact ? entry.line : locate(text, `${at}.mode`).line;
    }

    /** Re-plan from the pane's text and the playing song's code; a broken show is marked and the last good one plays on. */
    private async apply(text: string): Promise<void> {
        const ctx = this.ctx;
        const code = window.strudelApp?.editor?.getCode();
        if (!ctx || code === undefined) return;
        this.cuedCode = code;
        try {
            const songs = parseShow(text, ctx).songs;
            const playing = this.plan[this.current].song.source;
            const index = songs[this.current]?.source === playing ? this.current : songs.findIndex((s) => s.source === playing);
            if (index < 0) {
                throw new ShowError(`song[${this.current}].source`, 'the playing song has left the setlist; reopen the show to change songs this way');
            }
            const plan = await planSongs(songs, index, code, this.plan);
            if (ctx !== this.ctx) return;
            this.plan = plan;
            this.current = index;
            // Cue objects are new: re-mark the playing section on the next tick.
            this.playing = null;
            this.stalled = false;
            // The next song or its boundary may have changed: plan it again from
            // here — unless it is already landing, when promote() takes it.
            if (this.next?.at === 'end' && window.strudelApp?.cancelSong()) this.next = null;
            showPane.setProblem(null);
        } catch (e) {
            if (ctx !== this.ctx) return;
            // The edit may have moved lines: re-mark the playing section on the next tick.
            this.playing = null;
            showPane.setProblem(problem(e, text));
        }
    }

    /** Pick up an edited song form, and the show file changed outside the pane. */
    private async poll(): Promise<void> {
        const path = this.path;
        if (!path || this.asking) return;
        if (window.strudelApp?.editor?.getCode() !== this.cuedCode) await this.apply(showPane.text);

        let disk: string;
        try {
            disk = await invoke<string>('read_text', {path});
        } catch {
            return;
        }
        if (path !== this.path || disk === showPane.saved) return;
        if (showPane.isDirty) {
            this.asking = true;
            const reload = await confirmDialog(`"${basename(path)}" changed on disk. Discard your changes in the show pane and reload it?`, {kind: 'warning'});
            this.asking = false;
            if (path !== this.path) return;
            // Kept the pane's edits: they win over this disk version until the next save.
            if (!reload) {
                showPane.adopt(disk);
                return;
            }
        }
        showPane.replace(disk);
        await this.apply(disk);
    }
}

/**
 * Read and cue every song. The playing song (`playing`) is cued from the
 * editor's code, which may have unsaved edits; a song already in `known`
 * reuses its code and form (the next song is read again before it plays);
 * the rest are read from disk.
 */
async function planSongs(songs: ShowSong[], playing = -1, playingCode = '', known: readonly Planned[] = []): Promise<Planned[]> {
    return Promise.all(songs.map(async (song, i) => {
        const at = `song[${i}].source`;
        const prior = known.find((p) => p.song.source === song.source);
        if (i !== playing && prior) return {song, code: prior.code, cues: cue(song, prior.cues)};
        let code = playingCode;
        if (i !== playing) {
            try {
                code = (await invoke<SongDoc>('read_song', {path: song.source})).code;
            } catch (e) {
                throw new ShowError(at, message(e));
            }
        }
        let sections: FormSection[];
        try {
            sections = await form(code);
        } catch (e) {
            throw new ShowError(at, `${basename(song.source)}: ${message(e)}`);
        }
        return {song, code, cues: cue(song, sections)};
    }));
}

async function context(path: string): Promise<ShowContext> {
    const {homeDir} = await import('@tauri-apps/api/path');
    return {
        dir: path.replace(/[\\/][^\\/]*$/, ''),
        home: await homeDir(),
        modes: VIZ_MODES.map((m) => m.id),
    };
}

async function form(code: string): Promise<FormSection[]> {
    const sections = await invoke<LabeledSection[] | null>('song_form', {code});
    if (!sections) throw new ShowError('', 'the song has no section form: a show needs a "<a b …>".slow(n).pickRestart({…}) selector');
    return sections.map((s) => ({label: s.label, startCycle: s.start_cycle, cycles: s.cycles}));
}

function status(text: string): void {
    window.strudelApp?.setStatus(text);
}

function problem(e: unknown, text: string): {line: number; message: string} {
    if (e instanceof ShowError) return {line: e.line ?? locate(text, e.path).line, message: e.message};
    return {line: 1, message: message(e)};
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export const liveShow = new LiveShow();
