/**
 * Stage Mode's code layer — the performer's pattern, drawn onto the visualizer
 * canvas.
 *
 * Why draw it rather than show CodeMirror: a DOM editor cannot be rasterized
 * into a canvas, so the stage would have a hole where the code belongs. The
 * editor stays the source of truth — this layer never reads back from its DOM,
 * it only consumes the snapshots the editor pushes.
 *
 * Tokenizing reuses the same headless lezer path as the chat's code blocks
 * (see `code-highlight.ts`), so colors match the editor without a third copy
 * of the palette.
 */

import {parser} from '@lezer/javascript';
import {highlightTree, tagHighlighter} from '@lezer/highlight';
import {DEFAULT_TOKEN_KEY, resolveSyntaxColors, syntaxTagMap} from '../../syntax-palette.js';
import type {EditorSnapshot} from '../../editor.js';
import type {VizLayer, VizServices} from '../types.js';

/**
 * The "class" here is the bare semantic key rather than a CSS class name, so a
 * highlight callback can look the color up directly.
 */
const stageHighlighter = tagHighlighter(
    syntaxTagMap.map(({tag, key}) => ({tag, class: key}))
);

const FONT_STACK = "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, ui-monospace, monospace";

/** Design metrics, authored against a 1080p frame and scaled from there. */
const REFERENCE_HEIGHT = 1080;
const DEFAULT_FONT_PX = 28;
const LINE_HEIGHT_RATIO = 1.5;
/** A touch under full opacity so the code sits in the scene rather than on it. */
const CODE_ALPHA = 0.92;
/** Fraction of frame width the code column occupies. */
const COLUMN_WIDTH = 0.56;
const MARGIN_X = 0.055;
const MARGIN_Y = 0.075;
/** Continuation rows hang under their source line by this many characters. */
const WRAP_INDENT = 2;

/**
 * Backdrop strength behind the code. Deliberately light, and painted only
 * behind rows that actually have text — the visuals are the point of the
 * stage, and a full-column slab blanks the frame beside short lines.
 */
const SCRIM_ALPHA = 0.4;
/** Horizontal padding around a row's backing, in characters. */
const SCRIM_PAD = 0.75;
/** Width of each row backing's trailing fade, in characters. */
const SCRIM_FADE = 2.5;

/** Seconds an active-event highlight takes to fade once the note stops. */
const ACTIVE_FADE = 0.12;
/** Seconds an evaluate flash takes to fade. */
const FLASH_FADE = 0.5;
const CARET_BLINK = 0.53;

interface Segment {
    text: string;
    color: string;
    /** Column offset within the row, in characters. */
    col: number;
}

interface Row {
    /** Document offsets covered by this visual row. */
    from: number;
    to: number;
    /** Leading columns before the text starts (source indent + wrap hang). */
    indent: number;
    segments: Segment[];
}

export class StageCodeLayer implements VizLayer {
    private snapshot: EditorSnapshot = {code: '', cursor: 0, selFrom: 0, selTo: 0};
    /** Per-character token key, rebuilt only when the text actually changes. */
    private charKeys: string[] = [];
    private rows: Row[] = [];
    private colors: Record<string, string> = {};

    private fontPx = DEFAULT_FONT_PX;

    private charW = 0;
    private lineH = 0;
    private cols = 0;
    private box = {x: 0, y: 0, w: 0, h: 0};

    private scrollPx = 0;
    private caretPhase = 0;

    /**
     * Note highlights keyed by range. `live` is re-asserted by each
     * setActiveRanges call; anything not re-asserted starts fading, so the
     * effect never depends on how often the app pushes updates.
     */
    private readonly active = new Map<
        string, {from: number; to: number; t: number; live: boolean}
    >();
    private flash: {from: number; to: number; t: number} | null = null;

    /** Detached context used only for text metrics — layout() has no ctx. */
    private readonly measure: CanvasRenderingContext2D;

    private needsRewrap = true;

    constructor() {
        const canvas = document.createElement('canvas');
        this.measure = canvas.getContext('2d')!;
    }

    // ---- input -------------------------------------------------------------

    setSnapshot(snapshot: EditorSnapshot): void {
        const textChanged = snapshot.code !== this.snapshot.code;
        this.snapshot = snapshot;
        if (textChanged) {
            this.retokenize(snapshot.code);
            this.needsRewrap = true;
        }
        // Solid caret while typing reads better than one blinking mid-keystroke.
        this.caretPhase = 0;
    }

    setActiveRanges(ranges: {from: number; to: number}[]): void {
        for (const entry of this.active.values()) entry.live = false;
        for (const range of ranges) {
            const key = `${range.from}-${range.to}`;
            const existing = this.active.get(key);
            if (existing) {
                existing.t = 1;
                existing.live = true;
            } else {
                this.active.set(key, {from: range.from, to: range.to, t: 1, live: true});
            }
        }
    }

    /** Let highlights fade out rather than popping off — a hard cut reads as a glitch. */
    clearActiveRanges(): void {
        for (const entry of this.active.values()) entry.live = false;
    }

    flashRange(from: number, to: number): void {
        this.flash = {from, to, t: 1};
    }

    // ---- VizLayer ----------------------------------------------------------

    layout(s: VizServices): void {
        this.colors = resolveSyntaxColors();

        this.fontPx = Math.max(10, Math.round(DEFAULT_FONT_PX * (s.height / REFERENCE_HEIGHT)));
        this.lineH = Math.round(this.fontPx * LINE_HEIGHT_RATIO);

        this.measure.font = `${this.fontPx}px ${FONT_STACK}`;
        // JetBrains Mono is not bundled (no @font-face in style.css), so the
        // fallback's advance width differs — always measure, never assume.
        this.charW = this.measure.measureText('M').width || this.fontPx * 0.6;

        this.box = {
            x: Math.round(s.width * MARGIN_X),
            y: Math.round(s.height * MARGIN_Y),
            w: Math.round(s.width * COLUMN_WIDTH),
            h: Math.round(s.height * (1 - MARGIN_Y * 2)),
        };
        this.cols = Math.max(8, Math.floor(this.box.w / this.charW));

        this.rewrap();
    }

    update(dt: number, _s: VizServices): void {
        this.caretPhase += dt;

        for (const [key, entry] of this.active) {
            if (entry.live) continue;
            entry.t -= dt / ACTIVE_FADE;
            if (entry.t <= 0) this.active.delete(key);
        }

        if (this.flash) {
            this.flash.t -= dt / FLASH_FADE;
            if (this.flash.t <= 0) this.flash = null;
        }

        this.followCaret(dt);
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.needsRewrap) this.rewrap();
        if (!this.rows.length) return;

        ctx.save();
        ctx.beginPath();
        // Wide enough for a full-width row's trailing scrim fade to complete.
        const bleed = this.charW * (SCRIM_PAD + SCRIM_FADE + 1);
        ctx.rect(this.box.x - bleed, this.box.y, this.box.w + bleed * 2, this.box.h);
        ctx.clip();

        const first = Math.max(0, Math.floor(this.scrollPx / this.lineH) - 1);
        const last = Math.min(
            this.rows.length - 1,
            Math.ceil((this.scrollPx + this.box.h) / this.lineH) + 1,
        );

        this.drawScrim(ctx, s, first, last);
        this.drawSelection(ctx, s, first, last);
        this.drawFlash(ctx, s, first, last);
        this.drawActive(ctx, s, first, last);
        this.drawText(ctx, first, last);
        this.drawCaret(ctx, s);

        ctx.restore();
    }

    // ---- tokenizing + wrapping --------------------------------------------

    private retokenize(code: string): void {
        this.charKeys = new Array<string>(code.length).fill(DEFAULT_TOKEN_KEY);
        try {
            const tree = parser.parse(code);
            // highlightTree (not highlightCode) hands back char offsets directly,
            // and only fires for styled ranges — gaps keep the default key.
            highlightTree(tree, stageHighlighter, (from, to, classes) => {
                const key = classes.split(' ')[0];
                for (let i = from; i < to; i++) this.charKeys[i] = key;
            });
        } catch {
            // @lezer/javascript is error-tolerant, but mirror code-highlight.ts's
            // guard: worst case every token falls back to the default color.
        }
    }

    private rewrap(): void {
        this.needsRewrap = false;
        this.rows = [];
        if (this.charW <= 0) return;

        const {code} = this.snapshot;
        let lineStart = 0;

        for (const line of code.split('\n')) {
            const indent = Math.min(
                line.length - line.trimStart().length,
                Math.max(0, this.cols - WRAP_INDENT * 2),
            );

            if (line.length === 0) {
                this.rows.push({from: lineStart, to: lineStart, indent: 0, segments: []});
            } else {
                let offset = 0;
                let isFirst = true;
                while (offset < line.length) {
                    const hang = isFirst ? 0 : indent + WRAP_INDENT;
                    const take = Math.max(1, this.cols - hang);
                    const from = lineStart + offset;
                    const to = Math.min(lineStart + offset + take, lineStart + line.length);
                    this.rows.push({
                        from,
                        to,
                        indent: hang,
                        segments: this.segmentsFor(from, to, hang),
                    });
                    offset += to - from;
                    isFirst = false;
                }
            }
            lineStart += line.length + 1; // +1 for the newline
        }
    }

    /** Coalesce a row's characters into same-color runs. */
    private segmentsFor(from: number, to: number, indent: number): Segment[] {
        const segments: Segment[] = [];
        const {code} = this.snapshot;
        let runStart = from;

        for (let i = from; i <= to; i++) {
            const atEnd = i === to;
            const changed = !atEnd && this.charKeys[i] !== this.charKeys[runStart];
            if (!atEnd && !changed) continue;
            if (i > runStart) {
                segments.push({
                    text: code.slice(runStart, i),
                    color: this.colors[this.charKeys[runStart]] ?? this.colors[DEFAULT_TOKEN_KEY],
                    col: indent + (runStart - from),
                });
            }
            runStart = i;
        }
        return segments;
    }

    // ---- scrolling ---------------------------------------------------------

    /**
     * Keep the caret inside the middle half of the visible rows and ease toward
     * it.
     *
     * Deliberately the stage's own scroll rather than a mirror of CodeMirror's:
     * the wrap points differ (different width, no gutter), so mirroring
     * `scrollTop` would drift line-by-line down a long pattern.
     */
    private followCaret(dt: number): void {
        const visible = Math.max(1, Math.floor(this.box.h / this.lineH));
        const maxScroll = Math.max(0, this.rows.length - visible) * this.lineH;

        const caretRow = this.rowIndexFor(this.snapshot.cursor);
        const caretPx = caretRow * this.lineH;
        const lo = caretPx - this.box.h * 0.75;
        const hi = caretPx - this.box.h * 0.25;

        let target = Math.min(Math.max(this.scrollPx, lo), hi);
        target = Math.min(Math.max(target, 0), maxScroll);

        this.scrollPx += (target - this.scrollPx) * Math.min(1, dt * 12);
        if (Math.abs(target - this.scrollPx) < 0.5) this.scrollPx = target;
    }

    private rowIndexFor(offset: number): number {
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            if (offset >= row.from && offset <= row.to) return i;
        }
        return Math.max(0, this.rows.length - 1);
    }

    // ---- drawing -----------------------------------------------------------

    /**
     * A soft dark backing behind each row of text.
     *
     * Per-row rather than one column-wide slab: the visualizer is the point of
     * the stage, and a full-height wash blanks the frame beside short lines and
     * everywhere below the code. Each backing hugs its row's actual extent and
     * fades out at the trailing edge, so the only thing dimmed is what sits
     * directly behind glyphs. Legibility still can't depend on the mode's
     * palette — the underlying visuals range from near-black to white flashes —
     * hence a backing at all rather than none.
     */
    private drawScrim(
        ctx: CanvasRenderingContext2D, s: VizServices, first: number, last: number,
    ): void {
        const [r, g, b] = s.theme.bgRgb;
        const pad = this.charW * SCRIM_PAD;
        const fade = this.charW * SCRIM_FADE;
        const x = this.box.x - pad;

        for (let i = first; i <= last; i++) {
            const row = this.rows[i];
            if (!row.segments.length) continue;

            const cols = row.indent + (row.to - row.from);
            const solid = cols * this.charW + pad;
            const y = this.box.y + i * this.lineH - this.scrollPx;

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${SCRIM_ALPHA})`;
            ctx.fillRect(x, y, solid, this.lineH);

            const grad = ctx.createLinearGradient(x + solid, 0, x + solid + fade, 0);
            grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${SCRIM_ALPHA})`);
            grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
            ctx.fillStyle = grad;
            ctx.fillRect(x + solid, y, fade, this.lineH);
        }
    }

    private drawText(ctx: CanvasRenderingContext2D, first: number, last: number): void {
        ctx.font = `${this.fontPx}px ${FONT_STACK}`;
        ctx.textBaseline = 'top';
        ctx.globalAlpha = CODE_ALPHA;

        for (let i = first; i <= last; i++) {
            const y = this.box.y + i * this.lineH - this.scrollPx;
            for (const seg of this.rows[i].segments) {
                ctx.fillStyle = seg.color;
                ctx.fillText(seg.text, this.box.x + seg.col * this.charW, y);
            }
        }

        ctx.globalAlpha = 1;
    }

    private drawSelection(
        ctx: CanvasRenderingContext2D, s: VizServices, first: number, last: number,
    ): void {
        const {selFrom, selTo} = this.snapshot;
        if (selFrom === selTo) return;

        ctx.fillStyle = `hsla(${s.theme.neonHue}, 92%, 70%, 0.18)`;
        this.forEachRangeRect(selFrom, selTo, first, last, (x, y, w) => {
            ctx.fillRect(x, y, w, this.lineH);
        });
    }

    private drawActive(
        ctx: CanvasRenderingContext2D, s: VizServices, first: number, last: number,
    ): void {
        if (!this.active.size) return;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const entry of this.active.values()) {
            const alpha = Math.max(0, Math.min(1, entry.t));
            ctx.fillStyle = `hsla(${s.theme.activeHue}, 100%, 62%, ${0.3 * alpha})`;
            this.forEachRangeRect(entry.from, entry.to, first, last, (x, y, w) => {
                ctx.fillRect(x, y - this.lineH * 0.08, w, this.lineH * 0.96);
            });
        }
        ctx.restore();
    }

    private drawFlash(
        ctx: CanvasRenderingContext2D, s: VizServices, first: number, last: number,
    ): void {
        if (!this.flash) return;
        const alpha = Math.max(0, Math.min(1, this.flash.t));
        ctx.fillStyle = `hsla(${s.theme.secondaryHue}, 100%, 68%, ${0.22 * alpha})`;
        this.forEachRangeRect(this.flash.from, this.flash.to, first, last, (x, y, w) => {
            ctx.fillRect(x, y, w, this.lineH);
        });
    }

    private drawCaret(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.caretPhase % (CARET_BLINK * 2) > CARET_BLINK) return;

        const row = this.rowIndexFor(this.snapshot.cursor);
        const col = this.rows[row].indent + (this.snapshot.cursor - this.rows[row].from);
        const x = this.box.x + col * this.charW;
        const y = this.box.y + row * this.lineH - this.scrollPx;

        ctx.fillStyle = s.theme.neon;
        ctx.fillRect(x, y, Math.max(2, this.fontPx * 0.08), this.lineH);
    }

    /** Visit the on-screen rect of each visible row slice of `[from, to)`. */
    private forEachRangeRect(
        from: number,
        to: number,
        first: number,
        last: number,
        draw: (x: number, y: number, w: number) => void,
    ): void {
        for (let i = first; i <= last; i++) {
            const row = this.rows[i];
            const start = Math.max(from, row.from);
            const end = Math.min(to, row.to);
            if (end <= start) continue;

            const x = this.box.x + (row.indent + (start - row.from)) * this.charW;
            draw(x, this.box.y + i * this.lineH - this.scrollPx, (end - start) * this.charW);
        }
    }
}
