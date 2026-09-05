/**
 * Pattern Scheduler
 *
 * Hot path (~10Hz):
 *   processor.queryEventsPacked(begin, end, cps)
 *     -> Rust writes N events into CHANNEL.event_input, does
 *        Atomics.store(event_count, N) [release fence] internally.
 *   Audio thread: Atomics.swap(event_count, 0) [acquire fence],
 *                 drainEventInput(N) reads CHANNEL.event_input directly.
 *
 * No postMessage in the scheduling hot path. No serialization. No GC pressure.
 */

import type {MainThreadProcessor, PatternHandle} from './pkg';
import type {StrudelAudioManager} from './audio-manager.js';
import {measure} from './query-profiler.js';

const INV_240 = 1 / 240;

/**
 * How far ahead (in cycles) to scan for sound banks that aren't loaded yet.
 * Wider than the audio `lookahead` so soundfonts have time to fetch + decode
 * before the notes that reference them are due.
 */
const SOUNDFONT_LOOKAHEAD_CYCLES = 4;

/** Main-thread schedule cadence. Worker-driven so WKWebView doesn't throttle it. */
const SCHEDULE_MS = 100;
/** Extra cycle lookahead while the window is hidden (safety if a tick is delayed). */
const BACKGROUND_LOOKAHEAD_CYCLES = 0.75;

/**
 * Nudge applied when computing a launch boundary so arming *exactly* on one
 * targets the next boundary rather than resolving to the current instant.
 */
const BOUNDARY_EPS = 1e-6;

/**
 * Dedicated Worker whose `setInterval` keeps firing when the main document is
 * backgrounded. Chromium/WebKit throttle main-thread timers heavily on blur;
 * that starves our ~300ms audio lookahead and causes glitches / catch-up spikes.
 */
function createScheduleTimerWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    try {
        const src = `
            let id = null;
            self.onmessage = (e) => {
                const msg = e.data || {};
                if (msg.type === 'start') {
                    if (id != null) clearInterval(id);
                    const ms = typeof msg.ms === 'number' && msg.ms > 0 ? msg.ms : ${SCHEDULE_MS};
                    id = setInterval(() => self.postMessage({ type: 'tick' }), ms);
                } else if (msg.type === 'stop') {
                    if (id != null) clearInterval(id);
                    id = null;
                }
            };
        `;
        return new Worker(URL.createObjectURL(new Blob([src], {type: 'application/javascript'})));
    } catch (e) {
        console.warn('[scheduler] timer worker unavailable, falling back to setTimeout:', e);
        return null;
    }
}

export class PatternScheduler {
    private processor: MainThreadProcessor | null;
    private readonly audioContext: AudioContext;
    audioManager: StrudelAudioManager | null = null;

    pattern: PatternHandle | null = null;
    private bpm: number = 120;
    private cps: number = 0.5;

    /** Tempo, for anything reporting transport state outside the app. */
    get tempo(): {bpm: number; cps: number} {
        return {bpm: this.bpm, cps: this.cps};
    }

    /** Cycle position off the audio clock. Deliberately not the visualizer's
     *  cycle: that one rides requestAnimationFrame, which the OS throttles to
     *  a standstill whenever the window is hidden — precisely when something
     *  outside the app is the thing doing the reporting. */
    get cycle(): number {
        return this.running ? this._liveCurrentCycle() : this.pausedCycle;
    }

    private running: boolean = false;
    private startTime: number = 0;
    private scheduledTo: number = 0;
    private lookahead: number = 0.15; // Schedule 0.15 cycles ahead (~300ms at 120bpm)
    visualLatency: number = 0;

    /** Cycle position saved when pause() is called, so the UI can display it while frozen. */
    private pausedCycle: number = 0;

    /** When true, skip rAF UI updates (window hidden) but keep audio scheduling. */
    private uiPaused: boolean = false;

    /**
     * Launch quantization, in cycles. `0` swaps patterns the moment they
     * evaluate (the classic live-coding behaviour); a positive value holds the
     * incoming pattern until the transport crosses the next multiple of it, so
     * edits land musically instead of wherever the keystroke happened to fall.
     */
    launchQuantum: number = 0;

    /** Pattern waiting for {@link _pendingBoundary}; owned here until installed. */
    private _pending: PatternHandle | null = null;
    /** Absolute cycle the armed swap lands on. Meaningless while `_pending` is null. */
    private _pendingBoundary: number = 0;
    /** Tempo carried by the armed pattern's source, applied when it lands. */
    private _pendingBpm: number | undefined = undefined;

    onCycleUpdate: ((cycle: number) => void) | null = null;

    /**
     * Fired after a quantized swap installs, with the BPM the incoming source
     * declared (if any). The host applies the deferred side effects here —
     * tempo and visualizer cache — so they change with the audio, not ahead of it.
     */
    onPatternInstalled: ((bpm: number | undefined) => void) | null = null;

    /** Fired when a swap is armed or lands, so the UI can show the countdown. */
    onLaunchArmed: ((boundary: number | null) => void) | null = null;

    /**
     * Called each tick after scanning the lookahead window for sound banks that
     * the engine reports missing (e.g. `s("piano")` before its soundfont is
     * loaded). The host reads the missing-bank bitsets and kicks off loads.
     */
    onMissingBanks: (() => void) | null = null;

    private _animationId: number | null = null;
    private _scheduleTimer: ReturnType<typeof setTimeout> | null = null;
    private _timerWorker: Worker | null = null;
    private _usingWorkerTimer = false;

    /**
     * @param processor
     * @param audioContext
     */
    constructor(processor: MainThreadProcessor, audioContext: AudioContext) {
        this.processor = processor;
        this.audioContext = audioContext;
        this._timerWorker = createScheduleTimerWorker();
        if (this._timerWorker) {
            this._timerWorker.onmessage = (e: MessageEvent) => {
                if (e.data?.type === 'tick' && this.running) {
                    this.scheduleTick();
                }
            };
            this._timerWorker.onerror = (err) => {
                console.warn('[scheduler] timer worker error, falling back to setTimeout:', err);
                this._stopTimerDriver();
                this._timerWorker?.terminate();
                this._timerWorker = null;
                this._usingWorkerTimer = false;
                if (this.running) this._armTimeoutTick();
            };
        }
    }

    /**
     * Set the pattern to play (hot-swap if already running).
     *
     * If already running, snaps `scheduledTo` forward to the current cycle so
     * the new pattern is queried from *now* rather than waiting for the old
     * lookahead buffer to drain.
     */
    setPattern(pattern: PatternHandle, resetClock = false): void {
        if (this.pattern) {
            this.pattern.free();
            this.pattern = null;
        }
        this.pattern = pattern;

        // Main-thread processor needs the pattern to run queryEventsPacked().
        this.processor!.setPattern(pattern);

        if (this.running) {
            if (resetClock) {
                this.startTime = this.audioContext.currentTime;
                this.scheduledTo = 0;
                this.pausedCycle = 0;
                this.processor!.setStartTime(this.startTime);
                this.audioManager?.sendHush(); // clear worklet engine state
            }
            // Hot-swap: snap scheduledTo forward to the current cycle so the new
            // pattern is queried from *now* rather than waiting for the old
            // lookahead buffer to drain.
            const elapsed = this.audioContext.currentTime - this.startTime;
            const currentCycle = elapsed * this.cps;
            if (currentCycle > this.scheduledTo) {
                this.scheduledTo = currentCycle;
            }
            this.kickSchedule();
        }
    }

    /**
     * Swap in `pattern`, held until the next {@link launchQuantum} boundary.
     *
     * Returns `true` if the swap was armed (the caller must defer its own side
     * effects to {@link onPatternInstalled}), `false` if it applied immediately —
     * which is the case whenever quantization is off, nothing is playing yet, or
     * there is no outgoing pattern to hold.
     *
     * Re-arming while a swap is already pending replaces the incoming pattern
     * but keeps the original boundary, so hammering the eval key doesn't push
     * the landing further away.
     */
    setPatternQuantized(pattern: PatternHandle, bpm?: number): boolean {
        if (this.launchQuantum <= 0 || !this.running || !this.pattern) {
            this._cancelPending();
            this.setPattern(pattern, false);
            this._pendingBpm = undefined;
            this.onLaunchArmed?.(null);
            return false;
        }

        const boundary = this._pending ? this._pendingBoundary : this._nextBoundary();
        this._cancelPending();
        this._pending = pattern;
        this._pendingBoundary = boundary;
        this._pendingBpm = bpm;
        this.onLaunchArmed?.(boundary);
        this.kickSchedule();
        return true;
    }

    /**
     * The cycle an armed swap should land on.
     *
     * The lookahead may already have queued the outgoing pattern past that
     * boundary. Rather than slip a whole quantum — which is exactly what happens
     * when you hit evaluate just before the downbeat, the most common moment in
     * a performance — drop the queued events and rewind `scheduledTo` so the
     * span up to the boundary is re-queried from the outgoing pattern.
     */
    private _nextBoundary(): number {
        const q = this.launchQuantum;
        const now = this._liveCurrentCycle();
        const boundary = Math.ceil((now + BOUNDARY_EPS) / q) * q;
        if (this.scheduledTo > boundary) {
            this.audioManager?.sendHush(); // pending events only; voices ring out
            this.scheduledTo = now;
        }
        return boundary;
    }

    /** Drop an armed swap without installing it, freeing its handle. */
    private _cancelPending(): void {
        if (this._pending) {
            this._pending.free();
            this._pending = null;
        }
    }

    /**
     * Install the armed pattern and refill the lookahead from it in the same
     * tick, so the boundary is crossed with no gap. Called only once the
     * outgoing pattern has been queried right up to `_pendingBoundary`.
     */
    private _installPending(currentCycle: number, lookahead: number): void {
        if (!this._pending) return;
        this._swapInPending();

        const end = currentCycle + lookahead;
        if (end > this.scheduledTo) {
            const from = this.scheduledTo;
            measure('queryEventsPacked', currentCycle, () =>
                this.processor!.queryEventsPacked(from, end, this.cps));
            this.scheduledTo = end;
        }

        this._finishInstall();
    }

    /**
     * Install the armed pattern without waiting for its boundary.
     *
     * Used when the transport stops caring about the boundary — pause and seek.
     * A pending swap is the code the performer asked to hear, so it should be
     * what resumes or what the new position plays, not the pattern it replaced.
     */
    private _installPendingNow(): void {
        if (!this._pending) return;
        this._swapInPending();
        this._finishInstall();
    }

    private _swapInPending(): void {
        const pattern = this._pending!;
        this._pending = null;
        if (this.pattern) this.pattern.free();
        this.pattern = pattern;
        this.processor!.setPattern(pattern);
    }

    private _finishInstall(): void {
        const bpm = this._pendingBpm;
        this._pendingBpm = undefined;
        this.onLaunchArmed?.(null);
        // Last: the host may change tempo here, which re-anchors the clock.
        this.onPatternInstalled?.(bpm);
    }

    /**
     * Set tempo in BPM.
     *
     * Changing BPM invalidates the current scheduledTo position (cycle-space
     * is coupled to cps), so we reset to the current cycle and hush stale
     * queued events on the worklet engine.
     *
     * An unchanged BPM is a strict no-op. Every evaluate applies the tempo,
     * so this runs on each live-coding keystroke — flushing the lookahead
     * buffer here when nothing changed silences ~300ms of queued audio and
     * skips any onsets that pass before the next tick (an audible stumble on
     * every edit).
     */
    setBpm(bpm: number): void {
        const clamped = Math.max(30, Math.min(300, bpm));
        if (clamped === this.bpm) return;
        this.bpm = clamped;
        if (this.running) {
            // Snapshot cycle position with the old cps before changing it
            const currentCycle = this._liveCurrentCycle();
            this.cps = this.bpm * INV_240;

            // Reconstruct startTime so the same cycle maps to currentTime under new cps
            this.startTime = this.audioContext.currentTime - (currentCycle / this.cps);
            this.processor?.setStartTime(this.startTime);

            // scheduledTo is in cycle-space, which is coupled to cps.
            // Changing BPM invalidates the current scheduledTo position,
            // so reset to the current cycle and clear stale queued events.
            this.scheduledTo = currentCycle;
            // BPM change invalidates pre-scheduled events in the worklet engine.
            this.audioManager?.sendFlushPending();
            // Refill right after the worklet has consumed the flush flag. The
            // render block drains newly-published events BEFORE applying the
            // flush, so a synchronous requery here could be wiped along with
            // the stale queue — one block (~3ms) later is deterministic, and
            // beats waiting up to SCHEDULE_MS for the next tick.
            setTimeout(() => this.kickSchedule(), 8);
        } else {
            this.cps = this.bpm * INV_240;
        }
    }

    /**
     * Jump the transport by `delta` cycles (negative = backward), clamped at 0.
     *
     * Re-anchors `startTime` exactly like `setBpm`/`resume` so playback continues
     * in phase from the target cycle, rewinds `scheduledTo` so the target span is
     * re-queried (a backward jump would otherwise be skipped by the
     * `queryEnd > scheduledTo` guard), and hushes stale queued events on the
     * worklet (active voices ring out; only pending events are dropped).
     *
     * No-op when nothing is loaded. While paused, it moves the saved position so
     * a later `resume()` starts from the new cycle.
     */
    seekBy(delta: number): void {
        this.seekTo((this.running ? this._liveCurrentCycle() : this.pausedCycle) + delta);
    }

    /** Seek to an absolute cycle (clamped at 0). See {@link seekBy}. */
    seekTo(cycle: number): void {
        if (!this.pattern) return;
        // The armed boundary refers to a timeline we are about to leave.
        this._installPendingNow();
        const target = Math.max(0, cycle);
        if (this.running) {
            this.startTime = this.audioContext.currentTime - target / this.cps;
            this.processor?.setStartTime(this.startTime);
            this.scheduledTo = target;
            this.audioManager?.sendHush(); // drop pending events; we jumped
            this.kickSchedule(); // re-query from the target immediately
        } else {
            this.pausedCycle = target;
        }
        if (this.onCycleUpdate) this.onCycleUpdate(target);
    }

    /**
     * Start playback from cycle 0.
     */
    start(): void {
        if (this.running) return;

        this.running = true;
        this.pausedCycle = 0;

        this.startTime = this.audioContext.currentTime;
        this.scheduledTo = 0;

        this.processor!.setStartTime(this.startTime);

        this._startTimerDriver();
        // Immediate tick so the first events land before the first interval.
        this.scheduleTick();
        if (!this.uiPaused) this.updateUI();
    }

    /**
     * Pause playback. Saves the current cycle position so resume() can
     * reconstruct startTime correctly. The AudioContext is intentionally
     * NOT suspended here - suspending causes an OS-level discontinuity click
     * regardless of what the graph is outputting. Instead the GainNode in
     * StrudelAudioManager is faded to zero, and the render loop keeps running
     * so the worklet is never starved of samples.
     */
    pause(): void {
        if (!this.running) return;

        this.running = false;
        this._installPendingNow();
        this._stopUiLoop();
        this._stopTimerDriver();

        // currentTime keeps advancing while paused (context stays running),
        // so we capture the cycle position now for startTime reconstruction.
        this.pausedCycle = this._liveCurrentCycle();

        // Flush pre-scheduled future events from the worklet engine queue.
        // Active voices ring out naturally - hush() only removes pending events.
        this.audioManager?.sendHush();
    }

    /**
     * Resume from the position saved by pause().
     *
     * Because the AudioContext was never suspended, currentTime kept advancing,
     * so startTime must be reconstructed from pausedCycle and the live clock.
     */
    resume(): void {
        if (this.running || !this.pattern || !this.processor) return;

        // Reconstruct startTime so that pausedCycle aligns with the current
        // audio clock position, keeping the pattern in the right phase.
        this.startTime = this.audioContext.currentTime - (this.pausedCycle / this.cps);
        this.processor.setStartTime(this.startTime);

        this.scheduledTo = this.pausedCycle;
        this.running = true;

        this._startTimerDriver();
        this.scheduleTick();
        if (!this.uiPaused) this.updateUI();
    }

    /**
     * Stop playback completely. Frees the pattern.
     */
    stop(): void {
        this.running = false;
        this._cancelPending();
        this.onLaunchArmed?.(null);
        this.pausedCycle = 0;
        this._stopUiLoop();
        this._stopTimerDriver();

        // hush() works correctly regardless of AudioContext state - no
        // resume() call needed, so there is no async race on stop.
        this.audioManager?.sendHush();

        if (this.pattern) {
            this.pattern.free();
            this.pattern = null;
        }

        // Drop the processor's Arc clone so the pattern tree is actually freed.
        this.processor?.clearPattern();
    }

    /**
     * Low-frequency scheduling tick (~10Hz).
     *
     * Queries packed events from the Rust pattern engine and stores them in
     * CHANNEL.event_input so the audio thread picks them up on its next render block.
     *
     * Driven by a Worker timer when available so background tabs keep filling
     * the lookahead buffer. Falls back to main-thread setTimeout otherwise.
     */
    scheduleTick = (): void => {
        if (!this.running || !this.pattern || !this.processor) {
            this.running = false;
            this._stopTimerDriver();
            return;
        }

        // Drain any alloc log entries written by the OOM handler since the last tick.
        // No-op in steady state (two Atomics.load + equality check).
        this.audioManager?.flushAllocLog();

        // Prefer a longer buffer while hidden — main-thread catch-up is costly.
        const lookahead = this.uiPaused
            ? Math.max(this.lookahead, BACKGROUND_LOOKAHEAD_CYCLES)
            : this.lookahead;

        const cps = this.cps;
        const elapsed = this.audioContext.currentTime - this.startTime;
        const currentCycle = elapsed * cps;

        // While a swap is armed the outgoing pattern is never queried past the
        // boundary — everything from there belongs to the incoming one, so the
        // two meet exactly on the beat with nothing dropped or doubled.
        const boundary = this._pending ? this._pendingBoundary : Infinity;
        const queryEnd = Math.min(currentCycle + lookahead, boundary);

        if (queryEnd > this.scheduledTo) {
            const from = this.scheduledTo;
            measure('queryEventsPacked', currentCycle, () =>
                this.processor!.queryEventsPacked(from, queryEnd, cps));
            this.scheduledTo = queryEnd;
        }

        if (this._pending && this.scheduledTo >= boundary) {
            this._installPending(currentCycle, lookahead);
        }

        // Scan further ahead for sound banks not yet loaded (soundfonts/samples)
        // so the host can fetch them before their notes are due.
        if (this.onMissingBanks) {
            measure('queryMissingBanks', currentCycle, () =>
                this.pattern!.queryMissingBanks(currentCycle, currentCycle + SOUNDFONT_LOOKAHEAD_CYCLES));
            this.onMissingBanks();
        }

        // Worker interval re-arms itself; only setTimeout needs a follow-up.
        if (!this._usingWorkerTimer) {
            this._armTimeoutTick();
        }
    };

    /**
     * Force an immediate scheduling tick, cancelling any pending timer.
     * Call this after a pattern swap so new events are queued without
     * waiting up to 100ms for the next regular tick.
     */
    kickSchedule(): void {
        if (!this.running) return;
        if (this._scheduleTimer !== null) {
            clearTimeout(this._scheduleTimer);
            this._scheduleTimer = null;
        }
        this.scheduleTick();
    }

    /**
     * Pause/resume the visual rAF loop when the window is hidden/shown.
     * Audio scheduling keeps running (Worker timer). Call with `true` on
     * `visibilitychange` when `document.hidden`.
     */
    setUiPaused(paused: boolean): void {
        if (this.uiPaused === paused) return;
        this.uiPaused = paused;
        if (paused) {
            this._stopUiLoop();
        } else if (this.running) {
            // Refill the event buffer immediately after a focus return, then
            // restart the visual loop.
            this.kickSchedule();
            this.updateUI();
        }
    }

    /**
     * High-frequency UI loop (~60fps). Skipped while the window is hidden.
     */
    updateUI = (): void => {
        if (!this.running || this.uiPaused) {
            this._animationId = null;
            return;
        }

        const visualElapsed = Math.max(
            0,
            this.audioContext.currentTime - this.startTime - this.visualLatency,
        );

        if (this.onCycleUpdate) {
            this.onCycleUpdate(visualElapsed * this.cps);
        }

        // Continue loop
        if (this.running && !this.uiPaused) {
            this._animationId = requestAnimationFrame(this.updateUI);
        }
    };

    private _startTimerDriver(): void {
        if (this._timerWorker) {
            this._usingWorkerTimer = true;
            this._timerWorker.postMessage({type: 'start', ms: SCHEDULE_MS});
            return;
        }
        this._usingWorkerTimer = false;
        this._armTimeoutTick();
    }

    private _stopTimerDriver(): void {
        if (this._timerWorker && this._usingWorkerTimer) {
            try {
                this._timerWorker.postMessage({type: 'stop'});
            } catch { /* ignore */ }
        }
        this._usingWorkerTimer = false;
        if (this._scheduleTimer !== null) {
            clearTimeout(this._scheduleTimer);
            this._scheduleTimer = null;
        }
    }

    private _armTimeoutTick(): void {
        if (this._scheduleTimer !== null) {
            clearTimeout(this._scheduleTimer);
        }
        this._scheduleTimer = setTimeout(this.scheduleTick, SCHEDULE_MS);
    }

    private _stopUiLoop(): void {
        if (this._animationId !== null) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
    }

    /**
     * Live cycle position directly from the audio clock.
     * Always valid while the AudioContext is running.
     */
    _liveCurrentCycle(): number {
        return (this.audioContext.currentTime - this.startTime) * this.cps;
    }

    isPlaying(): boolean {
        return this.running;
    }

    dispose(): void {
        this.stop();
        if (this._timerWorker) {
            try {
                this._timerWorker.terminate();
            } catch { /* ignore */ }
            this._timerWorker = null;
        }
        this.onCycleUpdate = null;
        this.onMissingBanks = null;
        this.onPatternInstalled = null;
        this.onLaunchArmed = null;
        this.processor = null;
        this.audioManager = null;
    }
}
