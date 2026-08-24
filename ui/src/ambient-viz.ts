/**
 * Ambient/immersive visualization wiring: owns the FullscreenVisualizer
 * instance, the auto-hiding HUD, and the keyboard shortcuts.
 *
 * Desktop app-side ambient visualizer wiring. The visualizer starts
 * with the first audio init (that's when an AnalyserNode exists) and can be
 * toggled with Ctrl/Cmd+Shift+V, the HUD's HIDE button, or the header's
 * Visuals menu; [ / ] cycle modes. attach() is safe to call again after an
 * engine re-init — it just swaps in the fresh analyser.
 *
 * Enabled state and mode persist across reloads. Before the first attach()
 * there is no visualizer yet, so toggling just arms/disarms the persisted
 * flag (same pattern as the metronome) and attach() honors it.
 */

import {FullscreenVisualizer} from './fullscreen-viz.js';
import {VIZ_MODES, modeIndexById} from './viz/registry.js';
import type {PatternSource} from './viz/types.js';
import {currentBpm} from './bpm.js';

const AUTO_CYCLE_KEY = 'viz-auto-cycle';
const ENABLED_KEY = 'ambient-viz-enabled';
const MODE_KEY = 'ambient-viz-mode';
/** Pattern cycles between automatic mode switches (~30s at 120 BPM). */
const AUTO_CYCLE_EVERY = 16;

/** Modes persist by stable id; unknown/stale values fall back to mode 0. */
function loadPersistedMode(): number {
    return modeIndexById(localStorage.getItem(MODE_KEY));
}

function persistMode(index: number): void {
    localStorage.setItem(MODE_KEY, VIZ_MODES[index].id);
}

export class AmbientViz {
    private viz: FullscreenVisualizer | null = null;
    private container: HTMLDivElement | null = null;
    private hudHideTimer: ReturnType<typeof setTimeout> | null = null;
    private wired = false;
    private autoCycle = localStorage.getItem(AUTO_CYCLE_KEY) === '1';
    // Missing key = enabled, preserving the historical auto-start-on-init behavior.
    private enabled = localStorage.getItem(ENABLED_KEY) !== '0';
    private lastSwitchCycle = 0;
    private latestCycle = 0;
    /** True while Stage Mode has borrowed the shared visualizer. */
    private borrowed = false;

    /** Fired after any enabled/mode/auto-cycle change so UI (menu) can refresh. */
    onStateChange: (() => void) | null = null;

    /**
     * Called after (each) audio init with a live analyser, plus pattern-data
     * access for the schedule-driven modes (ISO CITY). Re-attaching after an
     * engine re-init refreshes both.
     */
    attach(analyser: AnalyserNode, patternSource?: PatternSource): void {
        const viz = this.ensureVisualizer();
        if (!viz) return;

        viz.setAnalyser(analyser);
        if (patternSource) viz.setPatternSource(patternSource);

        if (!this.wired) {
            this.wired = true;
            this.wireHud();
            if (this.enabled) this.start();
        } else if (this.enabled && this.vizVisible()) {
            viz.start();
        }
    }

    /**
     * Construct the visualizer without requiring audio.
     *
     * `attach()` used to be the only construction site, so nothing visual
     * existed until the first Play. Stage Mode can be entered before that;
     * `updateAudioFeatures()` already no-ops without an analyser.
     */
    ensureVisualizer(): FullscreenVisualizer | null {
        this.container ??= document.getElementById('fullscreenViz') as HTMLDivElement | null;
        if (!this.container) return null;

        if (!this.viz) {
            this.viz = new FullscreenVisualizer(this.container);
            this.viz.setMode(loadPersistedMode());
        }
        return this.viz;
    }

    /** The ambient visualizer's own container, for Stage Mode to hand it back to. */
    homeContainer(): HTMLDivElement | null {
        return this.container;
    }

    /**
     * Mark the visualizer as on loan to Stage Mode.
     *
     * There is one visualizer instance, so an ambient toggle while on stage
     * would otherwise stop the shared rAF loop and blank the frame. While
     * borrowed, enable/disable still records the preference but leaves the
     * canvas alone; `reapply()` settles it on exit.
     */
    setBorrowed(on: boolean): void {
        this.borrowed = on;
    }

    /** Whether the visualizer is currently painting somewhere the user can see. */
    private vizVisible(): boolean {
        return this.borrowed || (!!this.container && !this.container.hasAttribute('hidden'));
    }

    /**
     * Re-apply the persisted enabled state. Stage Mode calls this on exit, once
     * it has returned the canvas, so ambient resumes exactly as the user left it.
     */
    reapply(): void {
        this.setEnabled(this.enabled);
    }

    updateCycle(cycle: number): void {
        this.viz?.updateCycle(cycle);
        this.latestCycle = cycle;

        // Stop/start resets cycle-space; re-anchor instead of switching early.
        if (cycle < this.lastSwitchCycle) this.lastSwitchCycle = cycle;

        if (this.autoCycle
            && this.vizVisible()
            && cycle - this.lastSwitchCycle >= AUTO_CYCLE_EVERY) {
            this.switchMode(+1);
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    isAutoCycle(): boolean {
        return this.autoCycle;
    }

    /** True once audio has initialized and the visualizer actually exists. */
    isAttached(): boolean {
        return this.viz !== null;
    }

    getMode(): number {
        return this.viz ? this.viz.getMode() : loadPersistedMode();
    }

    setMode(mode: number): void {
        persistMode(((mode % VIZ_MODES.length) + VIZ_MODES.length) % VIZ_MODES.length);
        this.lastSwitchCycle = this.latestCycle;
        if (this.viz) {
            this.viz.setMode(mode);
            this.updateHudLabel();
            this.flashHud();
        }
        this.onStateChange?.();
    }

    /**
     * Cycle to the next ambient mode. Public wrapper around the private
     * switchMode() for callers outside this file — e.g. Cycletron's native
     * View menu ("Next Visualization"), which strudio (web, no OS menu)
     * doesn't need.
     */
    next(): void {
        this.switchMode(+1);
    }

    setAutoCycle(on: boolean): void {
        if (this.autoCycle === on) return;
        this.toggleAutoCycle();
    }

    private toggleAutoCycle(): void {
        this.autoCycle = !this.autoCycle;
        this.lastSwitchCycle = this.latestCycle;
        localStorage.setItem(AUTO_CYCLE_KEY, this.autoCycle ? '1' : '0');
        this.updateAutoButton();
        this.flashHud();
        this.onStateChange?.();
    }

    private updateAutoButton(): void {
        document.getElementById('fsVizAuto')?.classList.toggle('is-on', this.autoCycle);
    }

    setEnabled(on: boolean): void {
        if (on) this.start();
        else this.stop();
    }

    toggle(): void {
        this.setEnabled(!this.enabled);
    }

    private start(): void {
        this.enabled = true;
        localStorage.setItem(ENABLED_KEY, '1');
        // Pre-audio: just arm the flag; attach() will start the viz.
        // On loan to the stage: arm it too, and let reapply() settle it on exit.
        if (!this.borrowed && this.container && this.viz) {
            this.container.removeAttribute('hidden');
            document.body.classList.add('immersive-viz-active');
            this.viz.start();
            this.updateHudLabel();
            this.updateHudBpm();
            this.flashHud();
        }
        this.onStateChange?.();
    }

    private stop(): void {
        this.enabled = false;
        localStorage.setItem(ENABLED_KEY, '0');
        if (!this.borrowed && this.container) {
            this.viz?.stop();
            this.container.setAttribute('hidden', '');
            document.body.classList.remove('immersive-viz-active');
            document.getElementById('fullscreenVizHUD')?.setAttribute('hidden', '');
        }
        this.onStateChange?.();
    }

    private switchMode(delta: number): void {
        if (!this.viz) return;
        // Manual or automatic, a switch restarts the auto-cycle countdown.
        this.lastSwitchCycle = this.latestCycle;
        const mode = this.viz.cycleMode(delta);
        persistMode(mode);
        this.updateHudLabel();
        this.flashHud();
        this.onStateChange?.();
    }

    private wireHud(): void {
        document.getElementById('fsVizExit')?.addEventListener('click', () => this.toggle());
        document.getElementById('fsVizPrev')?.addEventListener('click', () => this.switchMode(-1));
        document.getElementById('fsVizNext')?.addEventListener('click', () => this.switchMode(+1));
        document.getElementById('fsVizAuto')?.addEventListener('click', () => this.toggleAutoCycle());
        this.updateAutoButton();

        document.addEventListener('keydown', (e: KeyboardEvent) => {
            // Ctrl/Cmd+Shift+V toggles the viz anywhere.
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
                e.preventDefault();
                this.toggle();
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            const t = e.target;
            const inEditable = t instanceof HTMLElement && (
                t.tagName === 'INPUT' ||
                t.tagName === 'TEXTAREA' ||
                t.isContentEditable ||
                !!t.closest('.cm-editor')
            );
            if (inEditable) return;

            if (e.key === '[') {
                e.preventDefault();
                this.switchMode(-1);
            } else if (e.key === ']') {
                e.preventDefault();
                this.switchMode(+1);
            }
        });

        // Moving the mouse over the viz peeks the HUD.
        this.container?.addEventListener('mousemove', () => this.flashHud());
    }

    private updateHudLabel(): void {
        const label = document.getElementById('fsVizModeLabel');
        if (label && this.viz) label.textContent = VIZ_MODES[this.viz.getMode()]?.name ?? '';
    }

    private updateHudBpm(): void {
        const el = document.getElementById('fsBpm');
        if (el) el.textContent = String(currentBpm());
    }

    /** Reveal the HUD briefly, then auto-hide. */
    private flashHud(): void {
        if (!this.container || this.container.hasAttribute('hidden')) return;
        const hud = document.getElementById('fullscreenVizHUD');
        if (!hud) return;
        hud.removeAttribute('hidden');
        if (this.hudHideTimer) clearTimeout(this.hudHideTimer);
        this.hudHideTimer = setTimeout(() => hud.setAttribute('hidden', ''), 2000);
    }
}

export const ambientViz = new AmbientViz();
