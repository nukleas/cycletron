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
 *
 * "Follow the music": a long-form pattern switches between sections
 * (`pickRestart`, `arrange`), and the audience wants to see the one that is
 * sounding. The app pushes the source spans of the notes playing right now;
 * whichever section contains them is the playing one, and the layer either
 * folds the idle sections away or shows the playing one alone under a
 * breadcrumb of the form. See `form-map.ts` for how sections are found.
 */

import {parser} from '@lezer/javascript';
import {highlightTree, tagHighlighter} from '@lezer/highlight';
import {DEFAULT_TOKEN_KEY, resolveSyntaxColors, syntaxTagMap} from '../../syntax-palette.js';
import type {EditorSnapshot} from '../../editor.js';
import type {VizLayer, VizServices} from '../types.js';
import {parseForms, topLevelStatements, type Branch, type Form, type Range} from './form-map.js';

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
export const DEFAULT_FONT_PX = 28;
const LINE_HEIGHT_RATIO = 1.5;
/** A touch under full opacity so the code sits in the scene rather than on it. */
const CODE_ALPHA = 0.92;
/** Folded sections and breadcrumb context sit back from the live code. */
const DIM_ALPHA = 0.45;
/**
 * Characters per line.
 *
 * The column is sized from this and the measured advance width, rather than
 * being a fixed fraction of the frame: shrinking the text has to mean less of
 * the frame covered, not the same column packed with more characters. The
 * visuals are the reason to be on stage, so width the code gives up goes back
 * to them. At the default size on a 1080p frame this lands where the old fixed
 * 56% column did.
 */
const CODE_COLUMNS = 64;
/** Ceiling on the column, so the largest text still can't swallow the frame. */
const MAX_COLUMN_WIDTH = 0.62;
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
/**
 * Seconds a caret move keeps the scroll on the caret while following the
 * music. Long enough to edit a line; short enough that the playing section
 * comes back before the audience loses it.
 */
const CARET_STEAL = 3;

const FOLD_MARK = '⋯';
const CRUMB_SEP = ' · ';

/**
 * How the layer treats sections while the pattern plays.
 * - `off`: the whole document, as written.
 * - `fold`: the whole document with idle sections collapsed to one row each.
 * - `solo`: only the playing section, under a breadcrumb of the form.
 */
export type StageFollow = 'off' | 'fold' | 'solo';

interface Segment {
    text: string;
    color: string;
    /** Column offset within the row, in characters. */
    col: number;
    /** Overrides the row's opacity — the playing breadcrumb on a dim row. */
    alpha?: number;
}

interface Row {
    /**
     * Document offsets covered by this visual row. Synthetic rows (breadcrumbs,
     * spacers) carry `-1`; folded rows carry the folded range so the caret can
     * still be located, but never draw document geometry.
     */
    from: number;
    to: number;
    /** Leading columns before the text starts (source indent + wrap hang). */
    indent: number;
    /** Total width in characters, indent included. */
    cols: number;
    segments: Segment[];
    /** Not document text — highlights and the caret skip it. */
    synthetic: boolean;
    dim: boolean;
}

type Piece =
    | {kind: 'slice'; from: number; to: number; dedent: number}
    | {kind: 'row'; segments: Segment[]; indent: number; dim: boolean; from: number; to: number};

export class StageCodeLayer implements VizLayer {
    private snapshot: EditorSnapshot = {code: '', cursor: 0, selFrom: 0, selTo: 0};
    /** Per-character token key, rebuilt only when the text actually changes. */
    private charKeys: string[] = [];
    private rows: Row[] = [];
    private colors: Record<string, string> = {};
    private accent = '#fff';

    /** Authored size at 1080p, before the frame-height scale. User-settable. */
    private basePx = DEFAULT_FONT_PX;
    private fontPx = DEFAULT_FONT_PX;

    private charW = 0;
    private lineH = 0;
    private cols = 0;
    private box = {x: 0, y: 0, w: 0, h: 0};

    private scrollPx = 0;
    private caretPhase = 0;
    private clock = 0;

    private follow: StageFollow = 'off';
    private forms: Form[] = [];
    private statements: Range[] = [];
    /**
     * The section shown per form, by label. Labels rather than ranges so the
     * choice survives edits and re-evaluation; kept when playback stops so the
     * frame doesn't jump at the end of a set.
     */
    private held: (string | null)[] = [];
    /** Until this clock time, the scroll follows the caret rather than the music. */
    private caretStolenUntil = 0;
    private wasStolen = false;

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
    private needsRelayout = false;

    constructor() {
        const canvas = document.createElement('canvas');
        this.measure = canvas.getContext('2d')!;
    }

    // ---- input -------------------------------------------------------------

    /**
     * Set the authored font size (at 1080p; larger frames scale up from it).
     *
     * Deferred to the next frame rather than laid out here: the caller is a
     * menu click or a keystroke and has no `VizServices` to lay out against.
     */
    setBaseFontPx(px: number): void {
        if (px === this.basePx) return;
        this.basePx = px;
        this.needsRelayout = true;
    }

    setFollow(mode: StageFollow): void {
        if (mode === this.follow) return;
        this.follow = mode;
        this.scrollPx = 0;
        this.needsRewrap = true;
    }

    setSnapshot(snapshot: EditorSnapshot): void {
        const textChanged = snapshot.code !== this.snapshot.code;
        const caretMoved = snapshot.cursor !== this.snapshot.cursor;
        this.snapshot = snapshot;
        if (textChanged) {
            this.retokenize(snapshot.code);
            this.needsRewrap = true;
        }
        if (this.follow !== 'off') {
            // The caret's own section is always shown, so a move can change
            // what is on screen; and the performer editing wants the scroll.
            if (caretMoved) {
                this.needsRewrap = true;
                this.caretStolenUntil = this.clock + CARET_STEAL;
            }
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
        this.trackPlaying(ranges);
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
        this.needsRelayout = false;
        this.colors = resolveSyntaxColors();
        this.accent = `hsl(${s.theme.activeHue}, 100%, 70%)`;

        this.fontPx = Math.max(10, Math.round(this.basePx * (s.height / REFERENCE_HEIGHT)));
        this.lineH = Math.round(this.fontPx * LINE_HEIGHT_RATIO);

        this.measure.font = `${this.fontPx}px ${FONT_STACK}`;
        // JetBrains Mono is not bundled (no @font-face in style.css), so the
        // fallback's advance width differs — always measure, never assume.
        this.charW = this.measure.measureText('M').width || this.fontPx * 0.6;

        this.box = {
            x: Math.round(s.width * MARGIN_X),
            y: Math.round(s.height * MARGIN_Y),
            w: Math.round(Math.min(CODE_COLUMNS * this.charW, s.width * MAX_COLUMN_WIDTH)),
            h: Math.round(s.height * (1 - MARGIN_Y * 2)),
        };
        this.cols = Math.max(8, Math.floor(this.box.w / this.charW));

        this.rewrap();
    }

    update(dt: number, _s: VizServices): void {
        this.caretPhase += dt;
        this.clock += dt;

        for (const [key, entry] of this.active) {
            if (entry.live) continue;
            entry.t -= dt / ACTIVE_FADE;
            if (entry.t <= 0) this.active.delete(key);
        }

        if (this.flash) {
            this.flash.t -= dt / FLASH_FADE;
            if (this.flash.t <= 0) this.flash = null;
        }

        const stolen = this.caretStolen();
        if (stolen !== this.wasStolen) {
            this.wasStolen = stolen;
            if (this.follow === 'solo') this.needsRewrap = true;
        }

        if (this.needsRewrap) this.rewrap();
        this.scroll(dt);
    }

    /** True for a few seconds after the caret moves — the performer is editing. */
    private caretStolen(): boolean {
        return this.clock < this.caretStolenUntil;
    }

    render(ctx: CanvasRenderingContext2D, s: VizServices): void {
        if (this.needsRelayout) this.layout(s);
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

    // ---- tokenizing + form structure --------------------------------------

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
            this.forms = parseForms(tree, code);
            this.statements = topLevelStatements(tree);
        } catch {
            // @lezer/javascript is error-tolerant, but mirror code-highlight.ts's
            // guard: worst case every token falls back to the default color.
            this.forms = [];
            this.statements = [];
        }
        // Re-match the shown sections by label: an edit or re-evaluation must
        // not lose the performer's place in the form.
        this.held = this.forms.map((form, i) => {
            const label = this.held[i];
            return label && form.branches.some((b) => b.label === label) ? label : null;
        });
    }

    /** Decide, per form, which section the playing notes belong to. */
    private trackPlaying(ranges: {from: number; to: number}[]): void {
        let changed = false;
        this.forms.forEach((form, i) => {
            const branch = form.branches.find((b) => ranges.some((r) => contains(b, r)));
            if (!branch || branch.label === this.held[i]) return;
            this.held[i] = branch.label;
            changed = true;
            if (this.follow !== 'off') this.flashRange(branch.from, branch.to);
        });
        if (changed && this.follow !== 'off') {
            this.needsRewrap = true;
            if (this.follow === 'solo') this.scrollPx = 0;
        }
    }

    private heldBranch(i: number): Branch | null {
        const label = this.held[i];
        return label ? this.forms[i].branches.find((b) => b.label === label) ?? null : null;
    }

    /** The section the caret sits in, if any, so the performer can edit on stage. */
    private caretBranch(): {form: number; branch: Branch} | null {
        const at = this.snapshot.cursor;
        for (let i = 0; i < this.forms.length; i++) {
            const branch = this.forms[i].branches.find((b) => b.from <= at && at <= b.to);
            if (branch) return {form: i, branch};
        }
        return null;
    }

    // ---- pieces: what the rows are built from -----------------------------

    private pieces(): Piece[] {
        const {code} = this.snapshot;
        const whole: Piece[] = [{kind: 'slice', from: 0, to: code.length, dedent: 0}];
        if (this.follow === 'off' || !this.forms.length) return whole;

        const caret = this.caretBranch();
        const shown = (i: number, b: Branch): boolean =>
            b.label === this.held[i] || (caret?.form === i && caret.branch === b);

        if (this.follow === 'fold') return this.foldPieces(shown);
        return this.soloPieces(shown, caret) ?? whole;
    }

    /** The whole document, with every idle multi-line section as one dim row. */
    private foldPieces(shown: (i: number, b: Branch) => boolean): Piece[] {
        const {code} = this.snapshot;
        const folds: {from: number; to: number; branch: Branch}[] = [];
        this.forms.forEach((form, i) => {
            for (const b of form.branches) {
                if (shown(i, b)) continue;
                const from = lineStart(code, b.from);
                const to = lineEnd(code, b.to);
                // A single-line section gains nothing from folding, and one
                // sharing its line with a shown section must not take it along.
                if (lineEnd(code, b.from) === to) continue;
                folds.push({from, to, branch: b});
            }
        });
        folds.sort((a, b) => a.from - b.from);

        const pieces: Piece[] = [];
        let pos = 0;
        for (const fold of folds) {
            if (fold.from < pos) continue; // nested inside an earlier fold
            if (fold.from > pos) pieces.push({kind: 'slice', from: pos, to: fold.from - 1, dedent: 0});
            const indent = fold.branch.from - fold.from;
            pieces.push({
                kind: 'row',
                indent,
                dim: true,
                from: fold.from,
                to: fold.to,
                segments: [
                    {text: fold.branch.label, color: this.colors['property'] ?? this.accent, col: indent},
                    {text: `: ${FOLD_MARK}`, color: this.colors[DEFAULT_TOKEN_KEY], col: indent + fold.branch.label.length},
                ],
            });
            pos = Math.min(code.length, fold.to + 1);
        }
        if (pos < code.length) pieces.push({kind: 'slice', from: pos, to: code.length, dedent: 0});
        return pieces;
    }

    /** Per form: a breadcrumb, then only the playing section; then the caret's, if elsewhere. */
    private soloPieces(
        shown: (i: number, b: Branch) => boolean,
        caret: {form: number; branch: Branch} | null,
    ): Piece[] | null {
        const {code} = this.snapshot;
        const pieces: Piece[] = [];
        const spacer = (): Piece => ({kind: 'row', segments: [], indent: 0, dim: false, from: -1, to: -1});

        this.forms.forEach((form, i) => {
            const playing = this.heldBranch(i);
            if (!playing) return;
            if (pieces.length) pieces.push(spacer());
            pieces.push(...this.crumbRows(form, playing.label));
            pieces.push(spacer());
            pieces.push({kind: 'slice', from: playing.from, to: playing.to, dedent: commonIndent(code, playing)});
        });
        if (!pieces.length) return null;

        // The performer's caret, when it is not in a section already on screen.
        if (caret && !shown(caret.form, caret.branch)) {
            pieces.push(spacer(), {
                kind: 'slice', from: caret.branch.from, to: caret.branch.to,
                dedent: commonIndent(code, caret.branch),
            });
        } else if (!caret && this.caretStolen()) {
            // Outside any section, the caret is usually just parked (a fresh
            // load leaves it at the top). Only while it is actually moving
            // does its statement belong on stage.
            const at = this.snapshot.cursor;
            const inForm = this.forms.some((f) => f.from <= at && at <= f.to);
            const stmt = inForm ? null : this.statements.find((s) => s.from <= at && at <= s.to);
            if (stmt) pieces.push(spacer(), {kind: 'slice', from: stmt.from, to: stmt.to, dedent: 0});
        }
        return pieces;
    }

    /** `intro · build1 · [drop1a] · …`, wrapped on section boundaries. */
    private crumbRows(form: Form, playing: string): Piece[] {
        const rows: Piece[] = [];
        let segments: Segment[] = [];
        let col = 0;
        const flush = (): void => {
            // Idle labels read as context, the playing one as the headline.
            if (segments.length) rows.push({kind: 'row', segments, indent: 0, dim: true, from: -1, to: -1});
            segments = [];
            col = 0;
        };
        form.crumbs.forEach((label, i) => {
            const isPlaying = label === playing;
            const text = isPlaying ? `[${label}]` : label;
            const sep = i === 0 || col === 0 ? '' : CRUMB_SEP;
            if (col > 0 && col + sep.length + text.length > this.cols) flush();
            const lead = col === 0 ? '' : sep;
            if (lead) {
                segments.push({text: lead, color: this.colors[DEFAULT_TOKEN_KEY], col});
                col += lead.length;
            }
            segments.push(isPlaying
                ? {text, color: this.accent, col, alpha: CODE_ALPHA}
                : {text, color: this.colors[DEFAULT_TOKEN_KEY], col});
            col += text.length;
        });
        flush();
        return rows;
    }

    // ---- wrapping ----------------------------------------------------------

    private rewrap(): void {
        this.needsRewrap = false;
        this.rows = [];
        if (this.charW <= 0) return;

        for (const piece of this.pieces()) {
            if (piece.kind === 'row') {
                const width = piece.segments.reduce((w, s) => Math.max(w, s.col + s.text.length), piece.indent);
                this.rows.push({
                    from: piece.from, to: piece.to, indent: piece.indent, cols: width,
                    segments: piece.segments, synthetic: true, dim: piece.dim,
                });
            } else {
                this.wrapSlice(piece.from, piece.to, piece.dedent);
            }
        }
    }

    /**
     * Wrap `[from, to)` of the document into rows, one source line at a time.
     *
     * `dedent` strips that many leading columns from every line so a nested
     * section can sit at the left edge; the first line, which may start
     * mid-line, keeps its column relative to the same origin.
     */
    private wrapSlice(from: number, to: number, dedent: number): void {
        const {code} = this.snapshot;
        let lineFrom = from;
        let first = true;

        while (lineFrom <= to) {
            const nl = code.indexOf('\n', lineFrom);
            const lineTo = nl === -1 || nl > to ? to : nl;
            const line = code.slice(lineFrom, lineTo);
            const leading = line.length - line.trimStart().length;

            let start = lineFrom;
            let indent = 0;
            if (first) {
                indent = Math.max(0, lineFrom - lineStart(code, lineFrom) - dedent);
            } else {
                start = lineFrom + Math.min(dedent, leading);
            }
            const shownIndent = first ? indent + leading : leading - Math.min(dedent, leading);
            const sourceIndent = Math.min(shownIndent, Math.max(0, this.cols - WRAP_INDENT * 2));

            if (start >= lineTo) {
                this.rows.push({from: start, to: start, indent: 0, cols: 0, segments: [], synthetic: false, dim: false});
            } else {
                let offset = start;
                let isFirstRow = true;
                while (offset < lineTo) {
                    const hang = isFirstRow ? indent : sourceIndent + WRAP_INDENT;
                    const take = Math.max(1, this.cols - hang);
                    const rowTo = Math.min(offset + take, lineTo);
                    this.rows.push({
                        from: offset,
                        to: rowTo,
                        indent: hang,
                        cols: hang + (rowTo - offset),
                        segments: this.segmentsFor(offset, rowTo, hang),
                        synthetic: false,
                        dim: false,
                    });
                    offset = rowTo;
                    isFirstRow = false;
                }
            }

            if (nl === -1 || nl >= to) break;
            lineFrom = nl + 1;
            first = false;
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
     * Ease the scroll toward its target: the caret, or — while following the
     * music — the top of the playing section, unless the caret just moved and
     * the performer needs to see what they type.
     *
     * Deliberately the stage's own scroll rather than a mirror of CodeMirror's:
     * the wrap points differ (different width, no gutter), so mirroring
     * `scrollTop` would drift line-by-line down a long pattern.
     */
    private scroll(dt: number): void {
        const visible = Math.max(1, Math.floor(this.box.h / this.lineH));
        const maxScroll = Math.max(0, this.rows.length - visible) * this.lineH;

        let target = this.scrollPx;
        const anchor = this.follow !== 'off' && !this.caretStolen()
            ? this.playingRow()
            : -1;
        if (anchor >= 0) {
            // Keep the playing section in the top third, so what follows it is
            // what fills the column.
            target = anchor * this.lineH - this.box.h * 0.2;
        } else {
            const caretRow = this.rowIndexFor(this.snapshot.cursor);
            if (caretRow >= 0) {
                const caretPx = caretRow * this.lineH;
                target = Math.min(Math.max(this.scrollPx, caretPx - this.box.h * 0.75), caretPx - this.box.h * 0.25);
            }
        }
        target = Math.min(Math.max(target, 0), maxScroll);

        this.scrollPx += (target - this.scrollPx) * Math.min(1, dt * 12);
        if (Math.abs(target - this.scrollPx) < 0.5) this.scrollPx = target;
    }

    /** First row of the first playing section, or -1. */
    private playingRow(): number {
        for (let i = 0; i < this.forms.length; i++) {
            const branch = this.heldBranch(i);
            if (branch) return this.rowIndexFor(branch.from);
        }
        return -1;
    }

    /** The row holding `offset`, or -1 when it is not on screen at all. */
    private rowIndexFor(offset: number): number {
        for (let i = 0; i < this.rows.length; i++) {
            const row = this.rows[i];
            if (row.from >= 0 && offset >= row.from && offset <= row.to) return i;
        }
        return -1;
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

            const solid = row.cols * this.charW + pad;
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

        for (let i = first; i <= last; i++) {
            const row = this.rows[i];
            const y = this.box.y + i * this.lineH - this.scrollPx;
            const rowAlpha = row.dim ? DIM_ALPHA : CODE_ALPHA;
            for (const seg of row.segments) {
                ctx.globalAlpha = seg.alpha ?? rowAlpha;
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
        // Off screen (inside a hidden section) or on a folded row: no caret is
        // more honest than one at a made-up column.
        if (row < 0 || this.rows[row].synthetic) return;
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
            if (row.synthetic) continue;
            const start = Math.max(from, row.from);
            const end = Math.min(to, row.to);
            if (end <= start) continue;

            const x = this.box.x + (row.indent + (start - row.from)) * this.charW;
            draw(x, this.box.y + i * this.lineH - this.scrollPx, (end - start) * this.charW);
        }
    }
}

// ---- helpers -----------------------------------------------------------------

function contains(branch: Branch, r: {from: number; to: number}): boolean {
    if (branch.from <= r.from && r.to <= branch.to) return true;
    return branch.refs.some((ref) => ref.from <= r.from && r.to <= ref.to);
}

function lineStart(code: string, at: number): number {
    return code.lastIndexOf('\n', at - 1) + 1;
}

function lineEnd(code: string, at: number): number {
    const nl = code.indexOf('\n', at);
    return nl === -1 ? code.length : nl;
}

/**
 * Columns to strip so a section sits flush left: the smallest indent across
 * its lines, counting the first line from where the section starts.
 */
function commonIndent(code: string, range: Range): number {
    let min = range.from - lineStart(code, range.from);
    let pos = lineEnd(code, range.from) + 1;
    while (pos < range.to) {
        const end = lineEnd(code, pos);
        const line = code.slice(pos, end);
        if (line.trim()) min = Math.min(min, line.length - line.trimStart().length);
        pos = end + 1;
    }
    return min;
}
