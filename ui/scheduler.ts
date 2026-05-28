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

const INV_240 = 1 / 240;

export class PatternScheduler {
    private processor: MainThreadProcessor | null;
    private readonly audioContext: AudioContext;
    audioManager: StrudelAudioManager | null = null;

    pattern: PatternHandle | null = null;
    private bpm: number = 120;
    private cps: number = 0.5;

    private running: boolean = false;
    private startTime: number = 0;
    private scheduledTo: number = 0;
    private lookahead: number = 0.15; // Schedule 0.15 cycles ahead (~300ms at 120bpm)
    visualLatency: number = 0;

    /** Cycle position saved when pause() is called, so the UI can display it while frozen. */
    private pausedCycle: number = 0;

    onCycleUpdate: ((cycle: number) => void) | null = null;

    private _animationId: number | null = null;
    private _scheduleTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * @param processor
     * @param audioContext
     */
    constructor(processor: MainThreadProcessor, audioContext: AudioContext) {
        this.processor = processor;
        this.audioContext = audioContext;
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
     * Set tempo in BPM.
     *
     * Changing BPM invalidates the current scheduledTo position (cycle-space
     * is coupled to cps), so we reset to the current cycle and hush stale
     * queued events on the worklet engine.
     */
    setBpm(bpm: number): void {
        this.bpm = Math.max(30, Math.min(300, bpm));
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
        } else {
            this.cps = this.bpm * INV_240;
        }
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

        this.updateUI();
        this.scheduleTick();
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

        if (this._animationId !== null) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }

        if (this._scheduleTimer !== null) {
            clearTimeout(this._scheduleTimer);
            this._scheduleTimer = null;
        }

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

        this.updateUI();
        this.scheduleTick();
    }

    /**
     * Stop playback completely. Frees the pattern.
     */
    stop(): void {
        this.running = false;
        this.pausedCycle = 0;

        if (this._animationId !== null) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }

        if (this._scheduleTimer !== null) {
            clearTimeout(this._scheduleTimer);
            this._scheduleTimer = null;
        }

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
     */
    scheduleTick = (): void => {
        if (!this.running || !this.pattern || !this.processor) {
            this.running = false;
            return;
        }

        // Drain any alloc log entries written by the OOM handler since the last tick.
        // No-op in steady state (two Atomics.load + equality check).
        this.audioManager?.flushAllocLog();

        const cps = this.cps;
        const elapsed = this.audioContext.currentTime - this.startTime;
        const currentCycle = elapsed * cps;
        const queryEnd = currentCycle + this.lookahead;

        if (queryEnd > this.scheduledTo) {
            this.processor.queryEventsPacked(this.scheduledTo, queryEnd, cps);
            this.scheduledTo = queryEnd;
        }

        this._scheduleTimer = setTimeout(this.scheduleTick, 100);
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
     * High-frequency UI loop (~60fps).
     */
    updateUI = (): void => {
        if (!this.running) return;

        const visualElapsed = Math.max(
            0,
            this.audioContext.currentTime - this.startTime - this.visualLatency,
        );

        if (this.onCycleUpdate) {
            this.onCycleUpdate(visualElapsed * this.cps);
        }

        // Continue loop
        if (this.running) {
            this._animationId = requestAnimationFrame(this.updateUI);
        }
    };

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
        this.onCycleUpdate = null;
        this.processor = null;
        this.audioManager = null;
    }
}
