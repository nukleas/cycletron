/**
 * MIDI pad → action mapping with a "learn" workflow.
 *
 * The runtime matcher is always active (fed by `midi-input.ts`): an incoming
 * note/CC that matches an assignment fires its action against `StrudelApp`.
 * The learn workflow is driven by the Preferences UI — it calls `startLearn`,
 * the next MIDI message is captured as that action's trigger, and `onLearned`
 * fires so the UI can refresh and persist.
 */

import type {PadAssignment} from './types/tauri-commands.js';
import type {NativeMidiEvent} from './midi-input.js';
import {midiCapture} from './midi-capture.js';

/** Canonical action list — also drives the Preferences pad table. */
export const PAD_ACTIONS: ReadonlyArray<{id: string; label: string; hint: string}> = [
    {id: 'togglePlay', label: 'Play / Stop', hint: 'Toggle transport'},
    {id: 'stop', label: 'Stop', hint: 'Stop playback'},
    {id: 'hush', label: 'Hush', hint: 'Clear queued events, let voices ring out'},
    {id: 'panic', label: 'Panic', hint: 'Silence all voices immediately'},
    {id: 'evaluate', label: 'Evaluate editor', hint: 'Re-evaluate the current pattern'},
    {id: 'commit', label: 'Commit as loop', hint: 'Add captured notes as a new $: track and play it'},
    {id: 'replace', label: 'Replace line', hint: 'Swap the current $: track with the captured notes'},
    {id: 'deleteLine', label: 'Delete line', hint: 'Remove the current $: track (hot-swaps live)'},
    {id: 'clear', label: 'Clear capture', hint: 'Discard the capture buffer'},
    {id: 'newTrack', label: 'New track', hint: 'Insert a blank $: line'},
];

class MidiPads {
    private assignments: PadAssignment[] = [];
    private learningAction: string | null = null;
    private captureInstrument = 'gm_piano';

    /** Fired after a successful learn so the UI can refresh + persist. */
    onLearned: ((assignments: PadAssignment[]) => void) | null = null;

    getAssignments(): PadAssignment[] {
        return this.assignments;
    }

    setAssignments(list: PadAssignment[]): void {
        this.assignments = Array.isArray(list) ? [...list] : [];
    }

    setCaptureInstrument(name: string): void {
        this.captureInstrument = name;
    }

    /** Restore persisted state. */
    applyFromSettings(opts: {pad_assignments?: PadAssignment[]; monitor_instrument?: string}): void {
        this.setAssignments(opts.pad_assignments ?? []);
        if (opts.monitor_instrument) this.captureInstrument = opts.monitor_instrument;
    }

    startLearn(action: string): void {
        this.learningAction = action;
    }

    cancelLearn(): void {
        this.learningAction = null;
    }

    isLearning(): boolean {
        return this.learningAction !== null;
    }

    /** Return the assignment bound to `action`, if any. */
    assignmentFor(action: string): PadAssignment | undefined {
        return this.assignments.find((a) => a.action === action);
    }

    /**
     * Process an incoming MIDI event. Returns `true` if the event was consumed
     * (learned or matched a pad), so the caller can skip monitor/capture for it.
     */
    handle(evt: NativeMidiEvent): boolean {
        // Learn mode: bind the next note-on / CC to the pending action.
        if (this.learningAction) {
            if (evt.event_type === 'note_off') return true; // swallow, keep waiting
            const kind: 'cc' | 'note' = evt.event_type === 'cc' ? 'cc' : 'note';
            const action = this.learningAction;
            this.learningAction = null;
            // Drop any existing binding for this action or this exact trigger.
            this.assignments = this.assignments.filter(
                (a) => a.action !== action && !(a.trigger.kind === kind && a.trigger.value === evt.note),
            );
            this.assignments.push({trigger: {kind, value: evt.note}, action});
            this.onLearned?.(this.assignments);
            return true;
        }

        // Match mode: only note-on and CC fire actions (note-off is ignored).
        if (evt.event_type === 'note_off') return false;
        for (const a of this.assignments) {
            if (this.matches(a, evt)) {
                this.dispatch(a.action);
                return true;
            }
        }
        return false;
    }

    private matches(a: PadAssignment, evt: NativeMidiEvent): boolean {
        if (a.trigger.kind === 'cc') {
            return evt.event_type === 'cc' && evt.note === a.trigger.value;
        }
        return evt.event_type === 'note_on' && evt.note === a.trigger.value;
    }

    private dispatch(action: string): void {
        const app = window.strudelApp;
        if (!app) return;
        switch (action) {
            case 'togglePlay':
                void app.togglePlayPause?.();
                break;
            case 'stop':
                app.stop?.();
                break;
            case 'hush':
                app.audioManager?.sendHush?.();
                break;
            case 'panic':
                try { app.processor?.panic?.(); } catch { /* engine not ready */ }
                break;
            case 'evaluate': {
                const code = app.editor?.getCode?.() ?? '';
                if (code.trim()) void app.evaluate?.(code);
                break;
            }
            case 'commit': {
                // Add the captured part as a new looping track and start it.
                const code = midiCapture.toStrudel(this.captureInstrument);
                if (code && app.editor) {
                    app.editor.appendLine(`$: ${code}`);
                    midiCapture.clear();
                    this.reeval(true);
                }
                break;
            }
            case 'replace': {
                // Swap the current track's contents with the captured part.
                const code = midiCapture.toStrudel(this.captureInstrument);
                if (code && app.editor) {
                    app.editor.replaceCurrentLine(`$: ${code}`);
                    midiCapture.clear();
                    this.reeval(true);
                }
                break;
            }
            case 'deleteLine':
                app.editor?.deleteCurrentLine?.();
                this.reeval(false); // hot-swap only if already playing
                break;
            case 'clear':
                midiCapture.clear();
                break;
            case 'newTrack':
                app.editor?.appendLine?.('$: ');
                break;
            default:
                break;
        }
    }

    /**
     * Re-evaluate the editor so track edits take effect live. `start=true`
     * lets `evaluate` begin playback if stopped (commit/replace = "play it");
     * `start=false` only hot-swaps when already playing (delete shouldn't
     * suddenly start the transport).
     */
    private reeval(start: boolean): void {
        const app = window.strudelApp;
        if (!app?.editor) return;
        const playing = app.scheduler?.isPlaying?.() ?? false;
        if (!start && !playing) return;
        void app.evaluate?.(app.editor.getCode());
    }
}

export const midiPads = new MidiPads();
(window as any).midiPads = midiPads;
