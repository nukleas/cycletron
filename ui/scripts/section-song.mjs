#!/usr/bin/env node
// Section a flat MIDI import into a `pickRestart` form, so a show file can
// cue it. Reads a song as the MIDI Lab writes it (frontmatter, `setcpm`, a
// `// Track N: name` or `// Track N (key)` comment where it writes one, and one
// `$: note(`<…>`)…` or `$: s(`<…>`)…` per track, every top-level step one
// bar, `step@N` an N-bar phrase) and
// writes the same music as
//
//   "<intro@5 verse@8 …>".slow(1).pickRestart({ intro: stack(…), … })
//
// one `stack` per section holding only the tracks that sound in it. This is
// not a mini-notation parser: it slices the import's own output and refuses
// anything else.
//
// Usage:
//   node scripts/section-song.mjs <flat.strudel> --sections label:from-to,… [--fast label=r]
//     [--name "Title"] [--tags a,b] [-o out.strudel]
//
// Bars count from 0; `from-to` is half-open, so `intro:0-5,verse:5-13`. A
// phrase that crosses a boundary is split at the bar line: the half with the
// note's onset keeps it, the other half rests, and the cut is reported. The
// `pickRestart` form, and everything that reads it, counts whole cycles, so
// `--fast label=r` plays that section's bars `r` times faster in a slot of
// `ceil(bars / r)` cycles, padded with rests so the slot never wraps back
// into the music. Use it where the MIDI changes tempo.

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const STEPS_PER_LINE = 4;
/** Rest bars appended after a `--fast` section's music, at least. */
const FAST_PAD = 4;

// ---- parsing ----------------------------------------------------------------

/** The flat song: frontmatter lines, the setcpm line, and its tracks. */
export function parseSong(src) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(src);
    const frontmatter = fm ? fm[1].split('\n') : [];
    const setcpm = /^setcpm\([^)]*\)/m.exec(src)?.[0] ?? null;
    const tracks = [];
    // The import writes `// Track N: name` or `// Track N (key)` above a track, and nothing above drums.
    const re = /(?:\/\/ (Track [^\n]+)\n)?\$: (note|s)\(`<([\s\S]*?)>`\)([^\n]*)/g;
    for (let m; (m = re.exec(src));) {
        const comment = m[1] ?? (m[2] === 's' ? `Track ${tracks.length + 1}: drums` : `Track ${tracks.length + 1}`);
        tracks.push({comment, fn: m[2], steps: tokenize(m[3]), chain: m[4].trim()});
    }
    if (!tracks.length) throw new Error('no `$: note(`<…>`)` or `$: s(`<…>`)` tracks found');
    return {frontmatter, setcpm, tracks};
}

/** Top-level steps of a `< >` body: `{text, w}`, where `text@w` was written. */
export function tokenize(body) {
    const out = [];
    let depth = 0;
    let tok = '';
    for (const c of body) {
        if (c === '[' || c === '<') depth++;
        if (c === ']' || c === '>') depth--;
        if (/\s/.test(c) && depth === 0) {
            if (tok) out.push(step(tok));
            tok = '';
        } else {
            tok += c;
        }
    }
    if (tok) out.push(step(tok));
    return out;
}

function step(tok) {
    const m = /@(\d+)$/.exec(tok);
    if (m && balanced(tok.slice(0, m.index))) return {text: tok.slice(0, m.index), w: Number(m[1])};
    return {text: tok, w: 1};
}

function balanced(s) {
    let d = 0;
    for (const c of s) {
        if (c === '[') d++;
        if (c === ']') d--;
    }
    return d === 0;
}

// ---- slicing ----------------------------------------------------------------

/**
 * Bars `[from, to)` of a track as steps. A step crossing either edge is cut
 * at the bar line with {@link portion}; `cuts` collects the reports.
 */
export function slice(steps, from, to, cuts, where) {
    const out = [];
    let bar = 0;
    for (const s of steps) {
        const end = bar + s.w;
        if (end <= from) { bar = end; continue; }
        if (bar >= to) break;
        if (bar >= from && end <= to) {
            out.push(s);
        } else {
            const lo = Math.max(bar, from) - bar;
            const hi = Math.min(end, to) - bar;
            out.push(...portion(s, lo, hi, cuts, `${where} bar ${bar + lo}`));
        }
        bar = end;
    }
    while (bar < to) { out.push(REST); bar++; }
    return out;
}

const REST = {text: '-', w: 1};

/**
 * Bars `[lo, hi)` of one multi-bar step, by inner weight. A note whose onset
 * lies inside keeps its time up to the edge; one that started before it
 * rests. Returns one step of `hi - lo` bars, or that many rests.
 */
export function portion(s, lo, hi, cuts, where) {
    const bars = hi - lo;
    if (s.text === '-') return Array(bars).fill(REST);
    const inner = innerTokens(s, where);
    const units = inner.reduce((n, t) => n + t.k, 0);
    if (units % s.w !== 0) throw new Error(`${where}: ${s.text}@${s.w} has ${units} units, not a multiple of ${s.w} bars`);
    const perBar = units / s.w;
    const cutLo = lo * perBar;
    const cutHi = hi * perBar;
    const kept = [];
    let at = 0;
    for (const t of inner) {
        const start = at;
        const end = at + t.k;
        at = end;
        if (end <= cutLo || start >= cutHi) continue;
        if (start < cutLo) {
            // Continuation of a note from before the edge: rest for what's inside.
            pushRest(kept, Math.min(end, cutHi) - cutLo);
            continue;
        }
        const k = Math.min(end, cutHi) - start;
        if (t.text === '-') pushRest(kept, k);
        else kept.push({text: t.text, k});
        if (end > cutHi) cuts.push(`${where}: ${t.text} cut, ${end - cutHi}/${perBar} bar of sustain dropped`);
    }
    if (kept.every((t) => t.text === '-')) return Array(bars).fill(REST);
    const text = '[' + kept.map((t) => (t.k === 1 ? t.text : `${t.text}@${t.k}`)).join(' ') + ']';
    return [{text, w: bars}];
}

function pushRest(kept, k) {
    const last = kept[kept.length - 1];
    if (last && last.text === '-') last.k += k;
    else kept.push({text: '-', k});
}

/** The weighted tokens inside `[…]`; a bare atom is one token of the step's weight. */
function innerTokens(s, where) {
    if (!s.text.startsWith('[')) return [{text: s.text, k: s.w}];
    const body = s.text.slice(1, -1);
    const toks = [];
    let depth = 0;
    let tok = '';
    for (const c of body) {
        if (c === '[') depth++;
        if (c === ']') depth--;
        if (/\s/.test(c) && depth === 0) {
            if (tok) toks.push(tok);
            tok = '';
        } else {
            if (/\s/.test(c)) throw new Error(`${where}: can't split ${s.text} at a bar line (nested sequence)`);
            tok += c;
        }
    }
    if (tok) toks.push(tok);
    return toks.map((t) => {
        const m = /^(.*?)(?:@(\d+))?$/.exec(t);
        const text = m[1];
        if (/[_!*/?()]/.test(text)) throw new Error(`${where}: can't split ${s.text} at a bar line (${text})`);
        return {text, k: m[2] ? Number(m[2]) : 1};
    });
}

// ---- emitting ---------------------------------------------------------------

/**
 * Runs of an identical one-bar step become `step!N`; longer steps keep `@w`.
 * A slowcat that is nothing but one `step!N` is left as N plain steps:
 * strudel-rs plays a one-element `<x!N>` (and `<x@N>`) inside a single
 * cycle, unlike `<x!N y>`.
 */
export function compact(steps) {
    const out = [];
    for (const s of steps) {
        const last = out[out.length - 1];
        if (s.w === 1 && last && last.w === 1 && last.text === s.text) last.n++;
        else out.push({text: s.text, w: s.w, n: 1});
    }
    if (out.length === 1 && out[0].n > 1) return Array(out[0].n).fill(out[0].text);
    if (out.length === 1 && out[0].w > 1) throw new Error(`a section can't be one ${out[0].w}-bar phrase alone: strudel-rs plays <x@${out[0].w}> in one cycle`);
    return out.map((s) => (s.n > 1 ? `${s.text}!${s.n}` : s.w > 1 ? `${s.text}@${s.w}` : s.text));
}

export function isSilent(steps) {
    return steps.every((s) => s.text === '-');
}

/** `label:from-to,…` → `[{label, from, to}]`, contiguous from bar 0. */
export function parseSections(spec) {
    const sections = spec.split(',').map((part) => {
        const m = /^([A-Za-z_][\w-]*):(\d+)-(\d+)$/.exec(part.trim());
        if (!m) throw new Error(`bad section "${part}": want label:from-to`);
        return {label: m[1], from: Number(m[2]), to: Number(m[3])};
    });
    let at = 0;
    for (const s of sections) {
        if (s.from !== at) throw new Error(`section ${s.label} starts at ${s.from}, expected ${at}`);
        if (s.to <= s.from) throw new Error(`section ${s.label} is empty`);
        at = s.to;
    }
    return sections;
}

/** `label=r,…` → Map of fast factors. */
export function parseFast(spec) {
    const fast = new Map();
    for (const part of spec ? spec.split(',') : []) {
        const m = /^([\w-]+)=([\d.]+)$/.exec(part.trim());
        if (!m || !(Number(m[2]) > 0)) throw new Error(`bad --fast "${part}": want label=r`);
        fast.set(m[1], Number(m[2]));
    }
    return fast;
}

/**
 * The sectioned song. `fast` maps a label to its factor; that section's slot
 * is `ceil(bars / r)` cycles and its music is padded with rests.
 */
export function sectionSong(song, sections, fast = new Map(), opts = {}) {
    const total = song.tracks[0].steps.reduce((n, s) => n + s.w, 0);
    for (const t of song.tracks) {
        const n = t.steps.reduce((a, s) => a + s.w, 0);
        if (n !== total) throw new Error(`${t.comment} is ${n} bars; ${song.tracks[0].comment} is ${total}`);
    }
    const last = sections[sections.length - 1];
    if (last.to !== total) throw new Error(`sections end at bar ${last.to}; the song has ${total} bars`);

    const cuts = [];
    const selector = [];
    const blocks = [];
    for (const sec of sections) {
        const bars = sec.to - sec.from;
        const r = fast.get(sec.label);
        const weight = r ? Math.ceil(bars / r) : bars;
        const pad = r ? Math.max(FAST_PAD, Math.ceil(weight * r) - bars) : 0;
        selector.push(weight > 1 ? `${sec.label}@${weight}` : sec.label);
        const parts = [];
        for (const t of song.tracks) {
            const steps = slice(t.steps, sec.from, sec.to, cuts, `${t.comment.split(':')[0]}`);
            if (isSilent(steps)) continue;
            if (pad) steps.push(...Array(pad).fill(REST));
            parts.push(`    // ${t.comment}\n    ${t.fn}(\`<\n${lines(compact(steps))}>\`)${t.chain}`);
        }
        if (!parts.length) throw new Error(`section ${sec.label} is silent`);
        const tail = r ? `).fast(${r})` : ')';
        blocks.push(`  ${sec.label}: stack(\n${parts.join(',\n')}\n  ${tail}`);
    }

    const head = [];
    if (song.frontmatter.length) {
        const fm = song.frontmatter.map((line) => {
            if (opts.name && /^name:/.test(line)) return `name: ${JSON.stringify(opts.name)}`;
            if (opts.tags && /^tags:/.test(line)) return `tags: [${opts.tags}]`;
            return line;
        });
        head.push('---', ...fm, '---');
    }
    head.push(`// FORM: ${sections.map((s) => `${s.label} ${fast.has(s.label) ? `${Math.ceil((s.to - s.from) / fast.get(s.label))} (${s.to - s.from} bars at ${fast.get(s.label)}x)` : s.to - s.from}`).join(' | ')}`);
    if (opts.source) head.push(`// Sectioned from ${opts.source} with ui/scripts/section-song.mjs.`);
    if (song.setcpm) head.push(song.setcpm);
    head.push('');
    const code = `"<${selector.join(' ')}>".slow(1).pickRestart({\n${blocks.join(',\n')}\n})\n`;
    return {code: head.join('\n') + '\n' + code, cuts, total};
}

function lines(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i += STEPS_PER_LINE) {
        out.push('      ' + tokens.slice(i, i + STEPS_PER_LINE).join(' '));
    }
    return out.join('\n');
}

// ---- CLI --------------------------------------------------------------------

function main() {
    const args = process.argv.slice(2);
    const flag = (name) => {
        const i = args.indexOf(name);
        if (i < 0) return undefined;
        const v = args[i + 1];
        args.splice(i, 2);
        return v;
    };
    const sectionsSpec = flag('--sections');
    const fastSpec = flag('--fast');
    const name = flag('--name');
    const tags = flag('--tags');
    const out = flag('-o') ?? flag('--out');
    const input = args[0];
    if (!input || !sectionsSpec || args.length !== 1) {
        console.error('usage: section-song.mjs <flat.strudel> --sections label:from-to,… [--fast label=r] [--name "Title"] [--tags a,b] [-o out.strudel]');
        process.exit(2);
    }
    const song = parseSong(readFileSync(input, 'utf8'));
    const {code, cuts, total} = sectionSong(song, parseSections(sectionsSpec), parseFast(fastSpec), {
        name, tags, source: path.basename(input),
    });
    if (out) writeFileSync(out, code);
    else process.stdout.write(code);
    console.error(`${song.tracks.length} tracks, ${total} bars, ${cuts.length} cut${cuts.length === 1 ? '' : 's'}`);
    for (const c of cuts) console.error(`warn: ${c}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
