/**
 * The transport's link to the world outside the webview.
 *
 * Inbound: `transport:*` events from the tray, the global shortcuts, and
 * `cycletron <verb>` on the command line all arrive here and drive the app.
 *
 * Outbound: a snapshot of transport state goes to the backend, which fans it
 * out to the tray and to a JSON state file that desktop widgets can watch.
 */

import {invoke, isTauri, listen} from './tauri.js';
import {PlaybackState} from './types/app.js';
import {adjustBpm, currentBpm} from './bpm.js';
import {diag} from './diagnostics.js';
import {fileManager} from './file-manager.js';

/** How often to re-report while the transport is moving. The cycle counter
 *  is the only field that changes on its own, and a bar widget reading it
 *  once a second is already smoother than anyone needs. */
const TICK_MS = 1000;

interface PlaybackSnapshot {
    state: 'playing' | 'paused' | 'stopped';
    bpm: number;
    cps: number;
    cycle: number;
    file: string;
    path: string | null;
}

let lastPushed = '';

export async function initPlaybackBridge(): Promise<void> {
    if (!isTauri) return;

    // World → app.
    await listen('transport:play_pause', () => {
        void window.strudelApp?.togglePlayPause?.();
    });
    await listen('transport:play', () => {
        const app = window.strudelApp;
        if (!app) return;
        if (app.playbackState === PlaybackState.Playing) return;
        void app.togglePlayPause?.();
    });
    await listen('transport:pause', () => {
        const app = window.strudelApp;
        if (app?.playbackState === PlaybackState.Playing) app.pause?.();
    });
    await listen('transport:stop', () => {
        window.strudelApp?.stop?.();
    });
    await listen<number>('transport:tempo', ({payload}) => {
        if (Number.isFinite(payload)) window.strudelApp?.applyBpm?.(payload);
    });
    await listen<number>('transport:tempo_nudge', ({payload}) => {
        if (Number.isFinite(payload)) adjustBpm(payload);
    });

    // App → world.
    window.strudelApp?.onPlaybackStateChange?.(() => void push());
    setInterval(() => void push(), TICK_MS);
    void push();

    void diag('info', 'playback', 'transport bridge ready');
}

function snapshot(): PlaybackSnapshot {
    const app = window.strudelApp;
    const state =
        app?.playbackState === PlaybackState.Playing
            ? 'playing'
            : app?.playbackState === PlaybackState.Paused
              ? 'paused'
              : 'stopped';

    return {
        state,
        bpm: currentBpm(),
        // Zero until the audio graph exists — there is no cycle rate to report
        // before the scheduler is built.
        cps: app?.scheduler?.tempo.cps ?? 0,
        cycle: state === 'stopped' ? 0 : (app?.scheduler?.cycle ?? 0),
        file: fileManager.fileName,
        path: fileManager.filePath,
    };
}

/** Push only on real change, so an idle Cycletron writes nothing at all. */
async function push(): Promise<void> {
    const snap = snapshot();
    const body = JSON.stringify(snap);
    if (body === lastPushed) return;
    lastPushed = body;

    try {
        await invoke('set_playback_state', {snapshot: snap});
    } catch (e) {
        void diag('warn', 'playback', `state push failed: ${e}`);
    }
}
