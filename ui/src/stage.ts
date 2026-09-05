/**
 * Stage Mode — the performance view.
 *
 * One composed Canvas 2D scene: the visualizer as background with the
 * performer's code drawn on top of the same canvas, at a locked output
 * resolution letterboxed into the window. No header, no panels, no status bar.
 *
 * Composing into a single canvas is what makes the view worth capturing. The
 * locked resolution means a screen or window recording stays a stable 16:9 no
 * matter how the window is resized, and everything in frame is one image. The
 * rule that follows — anything visible on stage is drawn *into* the canvas —
 * is why the readout is a layer rather than DOM.
 *
 * Entering occludes the app rather than hiding it. The DOM stays mounted, laid
 * out, and focused behind an opaque overlay, so CodeMirror keeps its measure
 * cycle, keymaps, history, and IME handling; `display:none` would zero its
 * geometry and break caret positioning outright.
 */

import {ambientViz} from './ambient-viz.js';
import {diag} from './diagnostics.js';
import {isTauri} from './tauri.js';
import type {FixedResolution, FullscreenVisualizer} from './fullscreen-viz.js';
import {DEFAULT_FONT_PX, StageCodeLayer} from './viz/stage/code-layer.js';
import {StageHudLayer} from './viz/stage/hud-layer.js';

export interface StagePreset extends FixedResolution {
    id: string;
    label: string;
}

export interface StageTextSize {
    id: string;
    label: string;
    /** Authored against a 1080p frame; larger outputs scale up from it. */
    px: number;
}

/**
 * How large the code is drawn — and, because the column is sized to hold a
 * fixed number of characters, how much of the frame it covers. Smaller is not
 * only more readable-at-a-distance in reverse, it hands width back to the
 * visuals, which is usually the reason to reach for this.
 */
export const STAGE_TEXT_SIZES: readonly StageTextSize[] = [
    {id: 'xs', label: 'Extra Small', px: 18},
    {id: 's', label: 'Small', px: 22},
    {id: 'm', label: 'Medium', px: DEFAULT_FONT_PX},
    {id: 'l', label: 'Large', px: 36},
];

/**
 * Output presets. 1080p is the default; the higher ones exist because a 1080p
 * bitmap upscaled onto a Retina display looks soft *in the preview* (a capture
 * reads the bitmap and is unaffected), and because OBS window captures want a
 * 1:1 match with the canvas.
 */
export const STAGE_PRESETS: readonly StagePreset[] = [
    {id: '1080p', label: '1080p · 1920×1080', width: 1920, height: 1080},
    {id: '1440p', label: '1440p · 2560×1440', width: 2560, height: 1440},
    {id: '2160p', label: '4K · 3840×2160', width: 3840, height: 2160},
];

const RESOLUTION_KEY = 'stage-resolution';
const HUD_KEY = 'stage-hud';
const OS_FULLSCREEN_KEY = 'stage-os-fullscreen';
const TEXT_SIZE_KEY = 'stage-text-size';

const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.userAgent);
const EXIT_HINT = IS_MAC ? '⌘⇧F' : 'Ctrl+Shift+F';

export class Stage {
    private root: HTMLDivElement | null = null;
    private viz: FullscreenVisualizer | null = null;

    private readonly codeLayer = new StageCodeLayer();
    private readonly hudLayer = new StageHudLayer(
        EXIT_HINT,
        () => this.viz?.getMode() ?? 0,
    );

    private active = false;
    /** True only when *we* put the window into fullscreen, so exiting is safe. */
    private ownsFullscreen = false;
    private wired = false;

    /** Fired after entering/leaving or a settings change, so menus can refresh. */
    onStateChange: (() => void) | null = null;

    init(): void {
        if (this.wired) return;
        this.wired = true;

        this.root = document.getElementById('stageRoot') as HTMLDivElement | null;
        this.hudLayer.setVisible(this.isHudVisible());
        this.codeLayer.setBaseFontPx(this.textSize().px);

        // Capture phase: CodeMirror has focus on stage, and its keymap would
        // otherwise see the event first.
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
                e.preventDefault();
                e.stopPropagation();
                void this.toggle();
                return;
            }

            // ⌘+ / ⌘− is the editor's zoom, which does nothing visible on stage
            // — the code here is drawn, not shown. Rather than leave the one
            // shortcut everybody reaches for doing nothing, point it at the
            // size that is actually on screen.
            if (!this.active || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
            const step = e.key === '=' || e.key === '+' ? 1 : e.key === '-' ? -1 : 0;
            if (step === 0) return;
            e.preventDefault();
            e.stopPropagation();
            this.stepTextSize(step);
        }, {capture: true});
    }

    isActive(): boolean {
        return this.active;
    }

    async toggle(): Promise<void> {
        if (this.active) await this.exit();
        else await this.enter();
    }

    async enter(): Promise<void> {
        if (this.active) return;

        const viz = ambientViz.ensureVisualizer();
        if (!viz || !this.root) return;
        this.viz = viz;

        // Metrics are measured, not assumed — JetBrains Mono isn't bundled, so
        // the fallback's advance width has to be known before the first layout.
        if (document.fonts?.ready) await document.fonts.ready;

        this.active = true;
        this.root.removeAttribute('hidden');
        document.body.classList.add('stage-active');

        // Claim the shared visualizer: an ambient toggle (⌘⇧V) while on stage
        // would otherwise stop the rAF loop and blank the frame.
        ambientViz.setBorrowed(true);
        viz.reparent(this.root);
        viz.setFixedResolution(this.resolution());
        this.hudLayer.showHint();
        viz.setLayers([this.codeLayer, this.hudLayer]);
        viz.start();

        const editor = window.strudelApp?.editor;
        if (editor) {
            editor.onSnapshot = (snapshot) => this.codeLayer.setSnapshot(snapshot);
            editor.onFlash = (from, to) => this.codeLayer.flashRange(from, to);
            editor.pushSnapshotNow();
            // CM tooltips would render behind the overlay while you type.
            editor.suspendAssist(true);
            editor.focus();
        }

        if (this.isOsFullscreen()) await this.setOsFullscreen(true);
        this.onStateChange?.();
    }

    async exit(): Promise<void> {
        if (!this.active) return;
        this.active = false;

        const editor = window.strudelApp?.editor;
        if (editor) {
            editor.onSnapshot = null;
            editor.onFlash = null;
            editor.suspendAssist(false);
        }

        const viz = this.viz;
        if (viz) {
            viz.setLayers([]);
            viz.setFixedResolution(null);
            const home = ambientViz.homeContainer();
            if (home) viz.reparent(home);
        }

        this.root?.setAttribute('hidden', '');
        document.body.classList.remove('stage-active');
        // Hand the visualizer back, then let ambient settle it into whatever
        // state it should be in — including any toggle made while on stage.
        ambientViz.setBorrowed(false);
        ambientViz.reapply();

        if (this.ownsFullscreen) await this.setOsFullscreen(false);
        editor?.focus();
        this.onStateChange?.();
    }

    /** Forwarded from the app's active-note update; ignored when off stage. */
    setActiveRanges(ranges: {from: number; to: number}[]): void {
        if (this.active) this.codeLayer.setActiveRanges(ranges);
    }

    clearActiveRanges(): void {
        if (this.active) this.codeLayer.clearActiveRanges();
    }

    // ---- settings ----------------------------------------------------------

    resolution(): StagePreset {
        const id = localStorage.getItem(RESOLUTION_KEY);
        return STAGE_PRESETS.find((preset) => preset.id === id) ?? STAGE_PRESETS[0];
    }

    setResolution(id: string): void {
        if (!STAGE_PRESETS.some((preset) => preset.id === id)) return;
        localStorage.setItem(RESOLUTION_KEY, id);
        if (this.active) this.viz?.setFixedResolution(this.resolution());
        this.onStateChange?.();
    }

    textSize(): StageTextSize {
        const id = localStorage.getItem(TEXT_SIZE_KEY);
        return STAGE_TEXT_SIZES.find((size) => size.id === id)
            ?? STAGE_TEXT_SIZES.find((size) => size.px === DEFAULT_FONT_PX)!;
    }

    setTextSize(id: string): void {
        const size = STAGE_TEXT_SIZES.find((entry) => entry.id === id);
        if (!size) return;
        localStorage.setItem(TEXT_SIZE_KEY, size.id);
        this.codeLayer.setBaseFontPx(size.px);
        this.onStateChange?.();
    }

    /** Step through the sizes, clamped at both ends. */
    stepTextSize(delta: number): void {
        const at = STAGE_TEXT_SIZES.indexOf(this.textSize());
        const next = Math.min(Math.max(at + delta, 0), STAGE_TEXT_SIZES.length - 1);
        this.setTextSize(STAGE_TEXT_SIZES[next].id);
    }

    isHudVisible(): boolean {
        return localStorage.getItem(HUD_KEY) !== '0';
    }

    setHudVisible(on: boolean): void {
        localStorage.setItem(HUD_KEY, on ? '1' : '0');
        this.hudLayer.setVisible(on);
        this.onStateChange?.();
    }

    isOsFullscreen(): boolean {
        return localStorage.getItem(OS_FULLSCREEN_KEY) !== '0';
    }

    setOsFullscreenPref(on: boolean): void {
        localStorage.setItem(OS_FULLSCREEN_KEY, on ? '1' : '0');
        if (this.active) void this.setOsFullscreen(on);
        this.onStateChange?.();
    }

    // ---- OS window ---------------------------------------------------------

    private async setOsFullscreen(on: boolean): Promise<void> {
        if (!isTauri) return;
        try {
            const {getCurrentWindow} = await import('@tauri-apps/api/window');
            const win = getCurrentWindow();
            // Don't claim ownership of a fullscreen the user entered themselves,
            // or exiting the stage would yank them out of it.
            if (on && await win.isFullscreen()) return;
            await win.setFullscreen(on);
            this.ownsFullscreen = on;
        } catch (e) {
            // Non-fatal — the stage still fills the webview viewport.
            void diag('warn', 'stage', `setFullscreen(${on}) failed: ${String(e)}`);
        }
    }
}

export const stage = new Stage();
window.stage = stage;
