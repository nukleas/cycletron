/**
 * Ableton Link — follow a shared tempo and start on the shared bar line.
 *
 * The backend (`src-tauri/src/link.rs`) owns the session and documents why the
 * timelines line up; this module owns the policy: what Cycletron does with what
 * Link reports.
 *
 * Two behaviours, both deliberately one-directional — Cycletron follows the
 * session and never writes to it:
 *
 *   - **Tempo.** Polled and pushed through `applyBpm`, which is the app's sole
 *     tempo writer. While Link is on, the session tempo also *overrides* the
 *     one a pattern carries: evaluating `setbpm 140` mid-session would
 *     otherwise silently desync you from everyone else. See {@link resolveBpm}.
 *
 *   - **Start alignment.** Play and Resume wait for the bar line, so pressing
 *     play at any point in a bar still lands you in phase. This reuses nothing
 *     from launch quantization — that grid is relative to Cycletron's own
 *     transport, whereas this one is the session's.
 *
 * Once started, the two clocks free-run: Cycletron's transport is anchored to
 * `AudioContext.currentTime` and Link's to the host clock, so they drift by the
 * skew between those two oscillators. That is slow (parts per million) but not
 * zero, and nothing here corrects it — continuous phase-locking needs the
 * scheduler to re-anchor mid-flight, which flushes its lookahead and is audible.
 */

import {invoke, isTauri} from './tauri.js';

const STORAGE_KEY = 'linkSync';

/** How often to re-read the session. Tempo changes are rare; this is not a clock. */
const POLL_MS = 250;

/** Mirror of the Rust `LinkSnapshot`. */
export interface LinkSnapshot {
    enabled: boolean;
    peers: number;
    tempo: number;
    beat: number;
    phase: number;
    seconds_to_next_bar: number;
}

export interface LinkSettings {
    enabled: boolean;
}

export const LINK_DEFAULTS: LinkSettings = {enabled: false};

class LinkSync {
    settings: LinkSettings = {...LINK_DEFAULTS};

    /** Last reading, for the Preferences readout. Null until the first poll. */
    snapshot: LinkSnapshot | null = null;

    private timer: number | null = null;
    private onTempo: ((bpm: number) => void) | null = null;
    private onUpdate: (() => void) | null = null;

    /**
     * Restore the stored setting and rejoin if it was on.
     *
     * `onTempo` receives the session tempo whenever it changes — wire it to the
     * app's tempo writer. `onUpdate` fires on every poll for the readout.
     */
    async init(onTempo: (bpm: number) => void, onUpdate?: () => void): Promise<void> {
        this.onTempo = onTempo;
        this.onUpdate = onUpdate ?? null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) this.settings = {...LINK_DEFAULTS, ...JSON.parse(raw)};
        } catch {
            this.settings = {...LINK_DEFAULTS};
        }
        if (this.settings.enabled) await this.apply(this.settings.enabled);
    }

    /** True when Cycletron is in a session and should defer to it. */
    get active(): boolean {
        return this.settings.enabled && !!this.snapshot?.enabled;
    }

    /** Peers currently sharing the timeline. Zero is a valid, working session. */
    get peers(): number {
        return this.snapshot?.peers ?? 0;
    }

    /**
     * Join or leave the session. Returns an error string on failure, leaving
     * Link off rather than half-joined.
     */
    async apply(enabled: boolean, bpm = 120): Promise<string | null> {
        this.settings = {enabled};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));

        if (!isTauri) {
            this.settings.enabled = false;
            this.snapshot = null;
            return enabled ? 'Ableton Link needs the desktop app.' : null;
        }

        try {
            this.snapshot = await invoke<LinkSnapshot>('link_enable', {enabled, bpm});
        } catch (e) {
            this.settings.enabled = false;
            this.snapshot = null;
            this._stopPolling();
            return String(e);
        }

        if (enabled) {
            this._startPolling();
            // Adopt the session tempo immediately rather than up to a poll
            // later, so joining mid-jam doesn't play a bar at the old one.
            this._pushTempo();
        } else {
            this._stopPolling();
        }
        this.onUpdate?.();
        return null;
    }

    /**
     * The tempo that should actually apply, given a requested one.
     *
     * While Link is on the session wins, so a pattern's `setbpm` and the BPM
     * slider both resolve to it. This keeps the override in one place: the
     * app's tempo writer runs this over every value it receives, including the
     * ones this module pushes — which are already the session tempo, so they
     * pass through unchanged.
     */
    resolveBpm(requested: number): number {
        return this.active ? this._sessionBpm() : requested;
    }

    /**
     * Wait until the session's next bar line, so a start lands in phase.
     * Resolves immediately when there is nothing to sync to.
     *
     * Alone in a session there is no phase worth waiting for, so this returns
     * at once rather than making Play feel broken for up to a bar. Peers
     * arriving later still line up — Link aligns *them* to the timeline
     * Cycletron has been holding all along.
     *
     * @returns milliseconds waited, for the caller to surface as feedback.
     */
    async waitForBar(): Promise<number> {
        if (!this.active || this.peers === 0) return 0;

        let snapshot: LinkSnapshot;
        try {
            snapshot = await invoke<LinkSnapshot>('link_snapshot');
        } catch {
            return 0; // never block the transport on a failed read
        }
        const seconds = snapshot.enabled ? snapshot.seconds_to_next_bar : 0;
        if (!(seconds > 0)) return 0;

        const ms = seconds * 1000;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return ms;
    }

    private _sessionBpm(): number {
        // Two decimals: Link carries a float, and the app's tempo writer
        // compares stringified values to decide whether to touch the DOM.
        return Math.round((this.snapshot?.tempo ?? 120) * 100) / 100;
    }

    private _startPolling(): void {
        if (this.timer !== null) return;
        this.timer = window.setInterval(() => void this._poll(), POLL_MS);
    }

    private _stopPolling(): void {
        if (this.timer === null) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    private async _poll(): Promise<void> {
        try {
            this.snapshot = await invoke<LinkSnapshot>('link_snapshot');
        } catch {
            return; // transient IPC failure — keep the last reading
        }
        this._pushTempo();
        this.onUpdate?.();
    }

    /** Hand the session tempo to the app. A no-op when it hasn't moved. */
    private _pushTempo(): void {
        if (!this.active) return;
        this.onTempo?.(this._sessionBpm());
    }
}

export const linkSync = new LinkSync();
