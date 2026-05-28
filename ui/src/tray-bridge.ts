/**
 * Keeps the system tray label + tooltip in sync with playback state,
 * and routes tray menu clicks (Play/Pause, Stop) back into the app.
 */

const isTauri = !!(window as any).__TAURI__;

export async function initTrayBridge(): Promise<void> {
    if (!isTauri) return;
    const {listen} = (window as any).__TAURI__.event;

    // Tray menu → app
    await listen('tray:play_pause', () => {
        void window.strudelApp?.togglePlayPause?.();
    });
    await listen('tray:stop', () => {
        window.strudelApp?.stop?.();
    });

    // App → tray. StrudelApp doesn't emit today, so wrap its state setters.
    hookPlaybackEmitter();
}

function hookPlaybackEmitter(): void {
    const app = window.strudelApp as any;
    if (!app) return;

    const push = async (state: 'playing' | 'paused' | 'stopped') => {
        try {
            await (window as any).__TAURI__.core.invoke('tray_set_playback', {state});
        } catch (e) {
            console.warn('[tray] update failed:', e);
        }
    };

    // Watch the liveIndicator classList — the simplest truth source for
    // on-screen playback state; avoids intrusive patching of transport methods.
    const indicator = document.getElementById('liveIndicator');
    if (!indicator) return;
    const observer = new MutationObserver(() => {
        if (indicator.classList.contains('active')) push('playing');
        else if (indicator.classList.contains('indicator-paused')) push('paused');
        else push('stopped');
    });
    observer.observe(indicator, {attributes: true, attributeFilter: ['class']});
    // Initial push
    push('stopped');
}
