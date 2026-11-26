/**
 * Live capture of the performance mix to a lossless WAV file.
 *
 * Taps the master bus's capture point — the full mix at unity, before
 * monitoring level and before cue signals — so a recording sounds the same no
 * matter how loud you happen to be listening, and never contains the metronome.
 * See `audio-manager.ts` for the bus layout.
 *
 * Audio is streamed to disk as it is produced (`wav-capture.ts`), so a take is
 * bounded only by free space rather than by memory, and an interrupted one
 * leaves a recoverable partial file.
 *
 * "Stop after N bars" is measured on the audio clock rather than a timer, so it
 * can't drift over a long take. A tempo change mid-take moves the boundary,
 * since the target is computed from the BPM at the moment you start.
 */

import {invoke, isTauri} from './tauri.js';
import {notify} from './notifications.js';
import {addTask, removeTask} from './dock-badge.js';
import {confirmDialog, warnDialog, saveFileDialog} from './dialog.js';
import {basename, dirname} from './paths.js';
import {currentBpm} from './bpm.js';
import {wavCapture, type CaptureResult} from './wav-capture.js';
import type {RecordingOrphan} from './types/tauri-commands.js';

const LAST_RECORDING_DIR_KEY = 'cycletron-last-recording-dir';

type RecorderState = 'idle' | 'recording' | 'finalizing';

/** Beats per bar. Matches strudel's default cycle. */
const BEATS_PER_BAR = 4;
const TICK_MS = 250;

class AudioRecorder {
    private state: RecorderState = 'idle';
    /** Audio-clock seconds at which to auto-stop; null means manual. */
    private stopAfterSeconds: number | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;

    private btn: HTMLButtonElement | null = null;
    private barsInput: HTMLInputElement | null = null;
    private statusEl: HTMLElement | null = null;

    init(): void {
        this.btn = document.getElementById('recordBtn') as HTMLButtonElement | null;
        this.barsInput = document.getElementById('recordBars') as HTMLInputElement | null;
        this.statusEl = document.getElementById('recordStatus');
        this.btn?.addEventListener('click', () => { void this.toggle(); });
        this.updateUi();
    }

    isRecording(): boolean {
        return this.state === 'recording';
    }

    async toggle(): Promise<void> {
        if (this.state === 'idle') await this.start();
        else if (this.state === 'recording') await this.stop();
    }

    /**
     * Commit whatever has been captured and tear down, without prompting.
     *
     * Used when the audio graph is about to go away — a crash, or a rebuild
     * during recovery. Keeping the partial take is always better than losing
     * the set, so this commits rather than discards.
     */
    async salvage(): Promise<void> {
        if (this.state !== 'recording') return;
        this.state = 'finalizing';
        this.updateUi();
        try {
            const result = await this.finish(true);
            if (result) {
                void notify('Recording saved', `${basename(result.path)} — up to the interruption`);
            }
        } catch (e) {
            console.warn('[recorder] salvage failed:', e);
        }
    }

    /**
     * Check the last recording directory and library root for partial `.part`
     * takes left behind by an interrupted session and offer to recover or
     * discard each one.
     */
    async checkOrphans(): Promise<void> {
        if (!isTauri) return;
        const dirs = new Set<string>();
        try {
            const last = localStorage.getItem(LAST_RECORDING_DIR_KEY);
            if (last) dirs.add(last);
        } catch { /* storage unavailable */ }
        try {
            const root = await invoke<string>('get_library_root');
            if (root) dirs.add(root);
        } catch { /* ignore */ }

        for (const dir of dirs) {
            let orphans: RecordingOrphan[];
            try {
                orphans = await invoke<RecordingOrphan[]>('recording_orphans', {dir});
            } catch (e) {
                console.warn('[recorder] recording_orphans failed:', e);
                continue;
            }
            for (const orphan of orphans) {
                const mb = (orphan.bytes / (1024 * 1024)).toFixed(1);
                const keep = await confirmDialog(
                    `An interrupted recording was found:\n\n${basename(orphan.final_path)} (${mb} MB)\n\nRecover it to a playable WAV file, or discard the partial take?`,
                    {
                        title: 'Recover Interrupted Recording',
                        kind: 'warning',
                        okLabel: 'Recover',
                        cancelLabel: 'Discard',
                    },
                );
                try {
                    const recovered = await invoke<string | null>('recording_recover', {
                        partPath: orphan.part_path,
                        keep,
                    });
                    if (recovered) {
                        void notify('Recording recovered', basename(recovered));
                    }
                } catch (e) {
                    await warnDialog(`Could not ${keep ? 'recover' : 'discard'} ${basename(orphan.part_path)}:\n${e}`);
                }
            }
        }
    }

    private async start(): Promise<void> {
        const manager = window.strudelApp?.audioManager;
        const ctx = manager?.getAudioContext?.();
        const tap = manager?.getCaptureTap?.();
        if (!ctx || !tap) {
            await warnDialog('Audio is not initialised. Press Play first.');
            return;
        }
        if (!isTauri) {
            await warnDialog('Recording requires the desktop app.');
            return;
        }

        const path = await saveFileDialog({
            defaultPath: defaultFileName(),
            filters: [{name: 'WAV Audio', extensions: ['wav']}],
        });
        if (!path) return;

        const parentDir = dirname(path);
        if (parentDir) {
            try { localStorage.setItem(LAST_RECORDING_DIR_KEY, parentDir); } catch { /* ignore */ }
        }

        this.stopAfterSeconds = this.barLimitSeconds();
        wavCapture.onFailure = (reason) => { void this.endEarly(reason); };

        try {
            const free = await wavCapture.start(ctx, tap, path);
            this.warnIfTight(free);
        } catch (e) {
            await warnDialog(`Could not start recording:\n${e}`);
            return;
        }

        this.state = 'recording';
        this.updateUi();
        addTask('recording');
        this.ticker = setInterval(() => this.tick(), TICK_MS);
    }

    private async stop(): Promise<void> {
        this.state = 'finalizing';
        this.updateUi();
        try {
            const result = await this.finish(true);
            if (!result) {
                await warnDialog('Nothing was recorded.');
                return;
            }
            const duration = result.seconds.toFixed(1);
            this.flash(`Saved (${duration}s)`);
            void notify('Recording saved', `${basename(result.path)} · ${duration}s`);
            if (result.truncated !== null) {
                await warnDialog(
                    `Recording stopped early after ${duration}s and was saved to ` +
                    `${basename(result.path)}.\n\nWriting to disk failed:\n` +
                    `${result.truncated}`,
                );
            } else if (result.overruns > 0) {
                await warnDialog(
                    `The recording saved, but ${result.overruns} audio block(s) were ` +
                    `dropped because the disk could not keep up. The file will have ` +
                    `brief gaps.`,
                );
            }
        } catch (e) {
            await warnDialog(`Could not save the recording:\n${e}`);
        }
    }

    /**
     * Wind up a take whose writes have started failing.
     *
     * The capture is already frozen at this point, so the only question is how
     * much of the set survives. Committing immediately keeps everything written
     * before the failure; waiting for the user to notice the clock has stopped
     * keeps exactly the same audio, just later and with more confusion.
     */
    private async endEarly(reason: string): Promise<void> {
        if (this.state !== 'recording') return;
        console.warn('[recorder] write failed, ending the take:', reason);
        await this.stop();
    }

    /** Shared teardown for both the normal stop and the salvage path. */
    private async finish(commit: boolean): Promise<CaptureResult | null> {
        if (this.ticker !== null) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        this.stopAfterSeconds = null;
        try {
            return await wavCapture.stop(commit);
        } finally {
            this.state = 'idle';
            this.updateUi();
            removeTask('recording');
        }
    }

    /** Drive the elapsed readout and the bar limit off the audio clock. */
    private tick(): void {
        if (this.state !== 'recording') return;
        const elapsed = wavCapture.elapsedSeconds();

        if (this.statusEl) this.statusEl.textContent = `● ${formatClock(elapsed)}`;

        if (this.stopAfterSeconds !== null && elapsed >= this.stopAfterSeconds) {
            void this.stop();
        }
    }

    private barLimitSeconds(): number | null {
        const bars = parseFloat(this.barsInput?.value ?? '');
        if (!Number.isFinite(bars) || bars <= 0) return null;
        const bpm = currentBpm();
        if (bpm <= 0) return null;
        return (bars * BEATS_PER_BAR * 60) / bpm;
    }

    /** ~23 MB/min at 48 kHz stereo float; warn when that buys under ~20 minutes. */
    private warnIfTight(freeBytes: number): void {
        const minutes = freeBytes / (23 * 1024 * 1024);
        if (minutes < 20) {
            this.flash(`~${Math.floor(minutes)} min of space`);
        }
    }

    private updateUi(): void {
        if (this.btn) {
            this.btn.classList.toggle('is-recording', this.state === 'recording');
            this.btn.disabled = this.state === 'finalizing';
            const label = this.btn.querySelector('.btn-text');
            if (label) {
                label.textContent =
                    this.state === 'recording' ? 'Stop' :
                    this.state === 'finalizing' ? 'Saving…' : 'Rec';
            }
        }
        if (this.statusEl && this.state !== 'recording') {
            this.statusEl.textContent = this.state === 'finalizing' ? 'Saving…' : '';
        }
    }

    private flash(text: string): void {
        if (!this.statusEl) return;
        const el = this.statusEl;
        const prev = el.textContent;
        el.textContent = text;
        setTimeout(() => { if (el.textContent === text) el.textContent = prev ?? ''; }, 2000);
    }
}

function formatClock(seconds: number): string {
    const total = Math.floor(seconds);
    const mins = String(Math.floor(total / 60)).padStart(2, '0');
    const secs = String(total % 60).padStart(2, '0');
    return `${mins}:${secs}`;
}

function defaultFileName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `cycletron-${stamp}.wav`;
}

export const audioRecorder = new AudioRecorder();
window.audioRecorder = audioRecorder;
