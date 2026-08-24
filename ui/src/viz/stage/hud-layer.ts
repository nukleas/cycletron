/**
 * Stage Mode's readout — mode name, tempo, cycle, and the exit hint.
 *
 * Drawn into the canvas for the same reason the code layer is: the existing
 * `#fullscreenVizHUD` is fixed-position DOM, visible on screen but absent from
 * any capture of the canvas.
 *
 * The exit hint is the load-bearing part — Stage Mode hides every affordance,
 * so the way out has to be on screen when you arrive.
 */

import {currentBpm} from '../../bpm.js';
import {VIZ_MODES} from '../registry.js';
import type {VizLayer, VizServices} from '../types.js';

const REFERENCE_HEIGHT = 1080;
const MARGIN = 0.055;
/** Seconds the exit hint stays up after entering the stage. */
const HINT_HOLD = 6;
const HINT_FADE = 1.2;

export class StageHudLayer implements VizLayer {
    private visible = true;
    private hintAge = 0;

    private fontPx = 15;
    private labelPx = 22;
    private margin = 60;

    /**
     * @param exitHint     Exit-key label, e.g. "⌘⇧F".
     * @param getModeIndex Read live so the readout tracks mode changes from the
     *                     menu or accelerators without a subscription.
     */
    constructor(
        private readonly exitHint: string,
        private readonly getModeIndex: () => number,
    ) {}

    setVisible(on: boolean): void {
        this.visible = on;
    }

    /** Re-show the exit hint — called on entry, and whenever the stage is re-armed. */
    showHint(): void {
        this.hintAge = 0;
    }

    layout(s: VizServices): void {
        const scale = s.height / REFERENCE_HEIGHT;
        this.fontPx = Math.max(10, Math.round(15 * scale));
        this.labelPx = Math.max(13, Math.round(22 * scale));
        this.margin = Math.round(s.height * MARGIN);
    }

    update(dt: number, _s: VizServices): void {
        this.hintAge += dt;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const hintAlpha = this.hintAlpha();
        if (!this.visible && hintAlpha <= 0) return;

        ctx.save();
        ctx.textBaseline = 'alphabetic';

        if (this.visible) this.drawReadout(ctx, s);
        if (hintAlpha > 0) this.drawHint(ctx, s, hintAlpha);

        ctx.restore();
    }

    private hintAlpha(): number {
        if (this.hintAge >= HINT_HOLD + HINT_FADE) return 0;
        if (this.hintAge <= HINT_HOLD) return 1;
        return 1 - (this.hintAge - HINT_HOLD) / HINT_FADE;
    }

    /** Bottom-right: what mode you're in, how fast, and where you are. */
    private drawReadout(ctx: CanvasRenderingContext2D, s: VizServices): void {
        const x = s.width - this.margin;
        const y = s.height - this.margin;

        ctx.textAlign = 'right';

        ctx.font = `600 ${this.labelPx}px ${FONT}`;
        ctx.fillStyle = s.theme.neon;
        ctx.globalAlpha = 0.85;
        ctx.fillText(VIZ_MODES[this.getModeIndex()]?.name ?? '', x, y);

        ctx.font = `${this.fontPx}px ${FONT}`;
        const [r, g, b] = s.theme.textRgb;
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.globalAlpha = 0.6;
        ctx.fillText(
            `${currentBpm()} BPM   ·   CYCLE ${Math.floor(s.cycle)}`,
            x,
            y + this.fontPx * 1.7,
        );

        ctx.globalAlpha = 1;
    }

    /** Bottom-left: the way out. */
    private drawHint(ctx: CanvasRenderingContext2D, s: VizServices, alpha: number): void {
        ctx.textAlign = 'left';
        ctx.font = `${this.fontPx}px ${FONT}`;
        const [r, g, b] = s.theme.textRgb;
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.globalAlpha = 0.55 * alpha;
        ctx.fillText(`${this.exitHint}  EXIT STAGE`, this.margin, s.height - this.margin);
        ctx.globalAlpha = 1;
    }
}

const FONT = "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, ui-monospace, monospace";
