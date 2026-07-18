/**
 * Ambient/immersive visualization wiring: owns the FullscreenVisualizer
 * instance, the auto-hiding HUD, and the keyboard shortcuts.
 *
 * Ported from the Robostrudel desktop app-side wiring. The visualizer starts
 * with the first audio init (that's when an AnalyserNode exists) and can be
 * toggled with Ctrl/Cmd+Shift+V, the HUD's HIDE button, or the header's
 * Visuals menu; [ / ] cycle modes. attach() is safe to call again after an
 * engine re-init — it just swaps in the fresh analyser.
 *
 * Enabled state and mode persist across reloads. Before the first attach()
 * there is no visualizer yet, so toggling just arms/disarms the persisted
 * flag (same pattern as the metronome) and attach() honors it.
 */

import {FullscreenVisualizer, FullscreenVizMode, MODE_COUNT} from './fullscreen-viz.js';

export const MODE_NAMES: Record<FullscreenVizMode, string> = {
    [FullscreenVizMode.NeonCircuit]: 'NEON CIRCUIT',
    [FullscreenVizMode.MarbleCore]: 'MARBLE CORE',
    [FullscreenVizMode.MarbleDrop]: 'MARBLE DROP',
    [FullscreenVizMode.FlameGraph]: 'FLAME GRAPH',
    [FullscreenVizMode.Lissajous]: 'LISSAJOUS SCOPE',
    [FullscreenVizMode.WaveTerrain]: 'WAVE TERRAIN',
    [FullscreenVizMode.Tunnel]: 'TUNNEL',
    [FullscreenVizMode.StrangeAttractor]: 'STRANGE ATTRACTOR',
    [FullscreenVizMode.Plasma]: 'PLASMA',
    [FullscreenVizMode.Kaleidoscope]: 'KALEIDOSCOPE',
    [FullscreenVizMode.AsciiArt]: 'ASCII SCOPE',
    [FullscreenVizMode.MatrixRain]: 'MATRIX RAIN',
};

const AUTO_CYCLE_KEY = 'viz-auto-cycle';
const ENABLED_KEY = 'ambient-viz-enabled';
const MODE_KEY = 'ambient-viz-mode';
/** Pattern cycles between automatic mode switches (~30s at 120 BPM). */
const AUTO_CYCLE_EVERY = 16;

function loadPersistedMode(): FullscreenVizMode {
    const m = parseInt(localStorage.getItem(MODE_KEY) ?? '', 10);
    return Number.isInteger(m) && m >= 0 && m < MODE_COUNT
        ? (m as FullscreenVizMode)
        : FullscreenVizMode.NeonCircuit;
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

    /** Fired after any enabled/mode/auto-cycle change so UI (menu) can refresh. */
    onStateChange: (() => void) | null = null;

    /** Called after (each) audio init with a live analyser. */
    attach(analyser: AnalyserNode): void {
        this.container = document.getElementById('fullscreenViz') as HTMLDivElement | null;
        if (!this.container) return;

        if (!this.viz) {
            this.viz = new FullscreenVisualizer(this.container);
            this.viz.setMode(loadPersistedMode());
        }
        this.viz.setAnalyser(analyser);

        if (!this.wired) {
            this.wired = true;
            this.wireHud();
            if (this.enabled) this.start();
        } else if (this.enabled && !this.container.hasAttribute('hidden')) {
            this.viz.start();
        }
    }

    updateCycle(cycle: number): void {
        this.viz?.updateCycle(cycle);
        this.latestCycle = cycle;

        // Stop/start resets cycle-space; re-anchor instead of switching early.
        if (cycle < this.lastSwitchCycle) this.lastSwitchCycle = cycle;

        if (this.autoCycle
            && this.container && !this.container.hasAttribute('hidden')
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

    getMode(): FullscreenVizMode {
        return this.viz ? this.viz.getMode() : loadPersistedMode();
    }

    setMode(mode: FullscreenVizMode): void {
        localStorage.setItem(MODE_KEY, String(mode));
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
     * switchMode() for callers outside this file — e.g. robostrudel's native
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
        if (this.container && this.viz) {
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
        if (this.container) {
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
        localStorage.setItem(MODE_KEY, String(mode));
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

        document.getElementById('bpmSlider')?.addEventListener('input', () => this.updateHudBpm());

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
        if (label && this.viz) label.textContent = MODE_NAMES[this.viz.getMode()] ?? '';
    }

    private updateHudBpm(): void {
        const el = document.getElementById('fsBpm');
        const slider = document.getElementById('bpmSlider') as HTMLInputElement | null;
        if (el && slider) el.textContent = slider.value;
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
