/**
 * Shared tempo access. The header slider is the single readable source of
 * truth for the current BPM, and `StrudelApp.applyBpm` is the sole writer —
 * every "read the tempo" or "nudge the tempo" path goes through here instead
 * of re-implementing slider parsing with its own fallback.
 */

/** The current tempo as shown in the transport, or `fallback` before boot. */
export function currentBpm(fallback = 120): number {
    const slider = document.getElementById('bpmSlider') as HTMLInputElement | null;
    const v = slider ? parseFloat(slider.value) : NaN;
    return Number.isFinite(v) ? v : fallback;
}

/** Nudge the tempo by `delta` BPM, clamped to the transport's 30–300 range. */
export function adjustBpm(delta: number): void {
    const next = Math.max(30, Math.min(300, Math.round(currentBpm()) + delta));
    window.strudelApp?.applyBpm?.(next);
}
