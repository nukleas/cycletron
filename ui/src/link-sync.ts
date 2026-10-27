/**
 * Ableton Link — follow a shared tempo and start on the shared bar line.
 *
 * The backend (`src-tauri/src/link.rs`) owns the session and documents why the
 * timelines line up; this module owns the policy: what Cycletron does with what
 * Link reports.
 *
 * Two behaviours:
 *
 *   - **Tempo.** Cycletron is a full peer. A local change (slider, `setbpm`,
 *     the assistant) goes to the session through `proposeBpm`; a peer's change
 *     is polled and pushed through `applyBpm`, the app's sole tempo writer.
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

    /** Why the last join failed, for the Preferences readout. Null when it worked. */
    lastError: string | null = null;

    private timer: number | null = null;
    /**
     * Bumped when a tempo push starts and again when it lands. A poll that
     * spans either edge read the session before the push took, so its tempo
     * would drag the app back to the old value for one poll.
     */
    private pushes = 0;
    private onTempo: ((bpm: number) => void) | null = null;
    private onUpdate: (() => void) | null = null;

    /**
     * Restore the stored setting and rejoin if it was on, at `bpm` if alone.
     *
     * `onTempo` receives the session tempo whenever it changes — wire it to the
     * app's tempo writer. `onUpdate` fires on every poll for the readout.
     *
     * @returns the join error, if rejoining failed. The stored setting stays
     *          on (see {@link apply}), so each launch retries and reports.
     */
    async init(onTempo: (bpm: number) => void, bpm: number, onUpdate?: () => void): Promise<string | null> {
        this.onTempo = onTempo;
        this.onUpdate = onUpdate ?? null;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) this.settings = {...LINK_DEFAULTS, ...JSON.parse(raw)};
        } catch {
            this.settings = {...LINK_DEFAULTS};
        }
        if (!this.settings.enabled) return null;
        return this.apply(true, bpm);
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
     * Join or leave the session; alone, `bpm` becomes the session tempo.
     * Returns an error string on failure, leaving Link off rather than
     * half-joined. The choice is stored before the backend answers, so a
     * failure is retried on the next launch rather than forgotten.
     */
    async apply(enabled: boolean, bpm: number): Promise<string | null> {
        this.settings = {enabled};
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));

        const fail = (error: string | null): string | null => {
            this.settings.enabled = false;
            this.snapshot = null;
            this._stopPolling();
            this.lastError = error;
            return error;
        };

        if (!isTauri) return fail(enabled ? 'Ableton Link needs the desktop app.' : null);

        try {
            this.snapshot = await invoke<LinkSnapshot>('link_enable', {enabled, bpm});
        } catch (e) {
            return fail(String(e));
        }
        this.lastError = null;

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
     * Send a local tempo change to the session.
     *
     * The app's tempo writer runs this over every value it receives, including
     * the ones this module pushes — those already match the session, so they
     * don't go back out.
     */
    proposeBpm(bpm: number): void {
        if (!this.active || bpm === this._sessionBpm()) return;
        // Show the new tempo now; the next poll would otherwise read the old one.
        this.snapshot = {...this.snapshot!, tempo: bpm};
        this.pushes++;
        void invoke<LinkSnapshot>('link_set_tempo', {bpm})
            .then(snapshot => {
                if (this.settings.enabled) this.snapshot = snapshot;
            })
            .catch(() => {})
            .finally(() => {
                this.pushes++;
            });
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
        const pushes = this.pushes;
        let snapshot: LinkSnapshot;
        try {
            snapshot = await invoke<LinkSnapshot>('link_snapshot');
        } catch {
            return; // transient IPC failure — keep the last reading
        }
        if (pushes !== this.pushes || !this.settings.enabled) return;
        this.snapshot = snapshot;
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
