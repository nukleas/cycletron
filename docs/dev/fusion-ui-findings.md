# Fusion UI findings (2026-08-13)

Investigation only. No code changes. Source: Fusion / Nukleas Discord notes plus
the strudel-rs commits they pointed at.

Out of scope: Fusion's local `Chain` struct work in strudel-rs `query` (concrete
`<P>` steps, `pattern.rs` wrapper). That is engine-side and not a Cycletron UI
bug.

Reference commits in the sibling `strudel-rs` checkout:

| Commit | What |
|---|---|
| `46b983a` `refactor(www): unify scrollbars` | One scrollbar token set; drop per-widget 4px bars |
| `253f428` `refactor(www): tooltips and synth categories` | `title=` → `data-tooltip` + `tooltip.ts` |
| `b6e9809` `fix(www): prevent visualizer jitter` | Pin `#visualizer` height, kill height transition |
| `1f84c7a` `fix(www): reduce layout shifting` | Broader layout-shift pass (header/files/modals) |

---

## 1. Custom scrollbars

Fusion: default scrollbars are ugly; worth a custom one.

Cycletron already styles *some* scrollers, but the system is the pre-unify
strudio state: two sizes, incomplete coverage, native Aqua leftover in WKWebView.

### What exists today (`ui/style.css`)

- Shared 10px bars: `.sidebar`, `#editor .cm-scroller` (~1940).
- Separate 4px neon bars: `.ex-grid`, `.ai-messages`, `.file-tree`,
  `#midiLabPreview`, `.cmd-palette-list`.
- `scrollbar-gutter: stable` only on `.sidebar`.
- No `--sb-thumb` / `--sb-track` / `--sb-size-*` tokens.

### Overflow containers with no custom bar

These still get the platform default (the ugly ones Fusion is reacting to):

- `#editor` itself (`overflow: auto` in addition to `.cm-scroller`)
- `.dropdown-menu` / visuals menu
- `.file-menu-popover`
- modal bodies (help, prefs, about, welcome, logs, history, MIDI lab)
- `.cm-inspect-panel` (`overflow-x: auto`)

Fusion's `46b983a` deleted the 4px one-offs, introduced CSS variables, and
applied one medium bar to sidebar + editor + dropdowns (larger only for the
memory-stats body, which Cycletron does not have).

### Suggested fix

Port `46b983a` into `ui/style.css`:

1. Add `--sb-thumb`, `--sb-track`, `--sb-size-medium` on `:root`.
2. Replace the 10px + 4px blocks with one rule list that includes every
   `overflow: auto|scroll` surface above.
3. Keep `scrollbar-width: thin` + `scrollbar-color` so Firefox / WKWebView
   overlay scrollbars match WebKit.

Do not invent a JS scrollbar.

---

## 2. `title=` → `data-tooltip` + `tooltip.ts`

Fusion: native `title` is unstyleable and a poor a11y hover. strudel-rs now
uses `data-tooltip` plus a single body-level tooltip so it is not clipped by
`overflow: auto` ancestors.

The commit to copy is `253f428` (`www/strudio/src/tooltip.ts`, `.js-tooltip`
CSS, and the `title` → `data-tooltip` edits). Synth-category HTML in that
commit is strudio-only and not needed here.

### Why not CSS `[data-tooltip]::after`

Fusion's file comment: file-tree, sidebar, dropdowns, and any `overflow: auto`
clip a `::after` tooltip and it walks off-screen at edges. `tooltip.ts`
appends one `.js-tooltip` to `document.body`, positions with
`getBoundingClientRect`, flips above/below, clamps horizontally, 300 ms show
delay, hide on scroll / resize / Escape / focusout.

### Cycletron has no tooltip module

There is no `ui/src/tooltip.ts`. CodeMirror's `.cm-tooltip` (autocomplete /
lint) is a different thing and should stay.

`initTooltips()` belongs in `ui/src/boot.ts` next to the other
`DOMContentLoaded` inits (Fusion put it next to `app.init()` in strudio).

### Static `title=` to migrate (`ui/index.html`)

| Line | Element | Current title |
|---|---|---|
| 23 | `#fileMenuBtn` | File menu (New, Open, Save, Recent) |
| 34 | `#skipBackBtn` | Back 5 cycles |
| 37 | `#skipFwdBtn` | Forward 5 cycles |
| 38 | `#metronomeBtn` | Metronome off (also written from JS) |
| 45 | `#midiInStatus` | MIDI input |
| 58 | `#bpmValue` | Click to type a BPM (30–300) |
| 80 | `#aiClear` | New song / clear chat |
| 81 | `#aiToggle` | Toggle AI panel |
| 114 | `#filesNewFile` | New file |
| 122 | `#filesNewFolder` | New folder |
| 129 | `#filesMidiImport` | Import MIDI… |
| 138 | `#filesRefresh` | Refresh |
| 144 | `#filesChangeRoot` | Change library location |
| 150 | `#filesToggle` | Toggle files panel |
| 155 | `#filesRootLabel` | `title=""` (filled from JS) |
| 171 | `#historyBtn` | Snapshots of this file… |
| 174 | `.record-group` | Record live audio to WAV… |
| 181 | `#editorMidiBtn` | Open MIDI Lab… |
| 184 | `#copyBtn` | Copy to clipboard |
| 188 | `#editorZoomOut` | Decrease font size (Ctrl+-) |
| 190 | `#editorZoomIn` | Increase font size (Ctrl+=) |
| 294–299 | `#fsVizPrev/Next/Auto/Exit` | viz HUD strings |

Keep existing `aria-label`s. Fusion wrapped the BPM number in
`<span data-tooltip … tabindex="0">` so the tooltip still works when the
input itself is focused for typing — worth doing the same here.

### Dynamic `el.title =` to migrate

Same pattern Fusion used: `el.setAttribute('data-tooltip', …)` /
`removeAttribute('data-tooltip')`.

| File | What |
|---|---|
| `ui/src/file-explorer.ts:181` | recents header `'Recently opened files'` |
| `ui/src/file-explorer.ts:214` | recents row `path` |
| `ui/src/file-explorer.ts:261` | tree row `entry.path` |
| `ui/src/file-explorer.ts:589` | `#filesRootLabel` full path |
| `ui/src/metronome.ts:103` | `'Metronome on' / 'Metronome off'` |
| `ui/src/sounds-browser.ts:104` | `` `Insert ${name}` `` on each chip |
| `ui/src/examples.ts:142` | example card blurb |
| `ui/src/preferences.ts:632,651` | pad hint / "Remove binding" |

Cycletron's recorder does **not** write `btn.title` (unlike strudio). The
static tooltip lives on `.record-group` in HTML.

### Leave alone (not hover tooltips)

- `document.title` in `ui/src/boot.ts` (window title)
- Tauri dialog `{title: …}` (`dialog.ts`, `app.ts` folder picker, updater)
- Command-palette item `.title` field
- Markdown link `title="…"` from marked (`markdown.ts`) — that is the HTML
  link title, not our chrome
- CodeMirror lint / autocomplete tooltips

---

## 3. Highlighter in the wrong place after a mid-play song swap

Fusion: switch songs while playing → source highlights sit on the wrong
tokens. Only Stop then Play fixes it. Nukleas: also seen when evaluate
errors.

This is the **active-note** highlight (`cm-active-note` in `ui/src/editor.ts`),
not the Lezer syntax highlighter (`ui/src/code-highlight.ts`).

### Path

```
recents click
  → file-explorer.ts:232 fileManager.openPath(path)
  → file-manager.ts:118 open_file IPC, then setEditorCode
  → file-manager.ts:381 if audio live: replaceCodeAndPlay(code)
  → app.ts:1062 setCode (full-doc replace) then evaluate
  → evaluate hot-swaps: scheduler.setPattern(pattern, resetClock=false)
  → every rAF: app.ts:205 updateActiveNotes(latestCycle)
       queryActiveLocations(cycle, 0.5)  // byte spans on the PLAYING pattern
       map through getByteToCharMap(editor.getCode())
       editor.setActiveNotes(ranges)
```

`open_file` already strips YAML frontmatter (`src-tauri/src/files.rs`), so
editor text and `parsePattern` see the same body. Frontmatter is not the
offset bug.

### Why Stop+Play "fixes" it

`stop()` (`app.ts:1251`) is the only path that calls `editor.clearActiveNotes()`
and also frees the scheduler pattern. `play()` then parses the *current*
editor and starts the clock at 0. That wipes both stale decorations and a
stale pattern handle.

### Ranked causes

**A. Evaluate fails → old pattern, new document (Nukleas's case).**
`evaluate` / `debouncedEvaluate` catch, `showError`, and return *without*
`setPattern`. The previous pattern keeps playing. `updateActiveNotes` still
reads that pattern's byte spans and applies them to the new editor text.
Any span that still fits `docLen` lights up the wrong tokens. Persistent
until Stop.

**B. `setCode` never clears active notes.**
`editor.setCode` (`editor.ts:385`) is a `{from:0, to:doc.length, insert:code}`
replace. `activeNoteField` first does `decorations.map(tr.changes)` through
that replace, which does not produce meaningful ranges. There is no
`clearActiveNotes` on this path. After a *successful* evaluate the next rAF
should replace them via `setActiveNotes`. If evaluate then fails (A), the
mapped garbage + leftover old spans stay.

**C. Hot-swap keeps `latestCycle`.**
`setPattern(pattern, false)` does not reset the clock (`scheduler.ts:128`).
Highlights are whatever of the *new* pattern is active at the *old* song's
cycle index. That is correct for audio continuity, but it looks "wrong" if
you expect the new file to highlight from bar 1. Stop+Play resets cycle to
0, which matches that expectation. Worth deciding: keep hot-swap and accept
mid-form highlights, or reset the clock on file-open (not on live edit).

**D. WASM tuple shape is a version-skew trap, not this bug.**
Cycletron's committed `ui/pkg` packs `(start, end, colorRGB)` — JS strides
by 3 (`app.ts:234`). Current strudel-rs `pattern.rs` packs `(start, end)`
and `www/wasm-repl/src/app.ts` strides by 2. A stride mismatch would break
highlights on *every* play, not only after a swap. Keep the JS stride in
lockstep with whatever WASM Cycletron actually ships.

### Suggested fix

1. `setCode` / `replaceCodeAndPlay`: `clearActiveNotes()` in the same
   dispatch (or immediately after) as the document replace.
2. On evaluate failure while playing: either keep playing and **stop
   highlighting** (`clearActiveNotes` + skip `updateActiveNotes` until the
   next successful parse), or don't leave the old pattern running against
   the new buffer.
3. Decide whether file-open while playing should `setPattern(..., true)`
   (reset clock) vs stay hot-swap. Live typing should stay hot-swap.
4. Optional: when `updateActiveNotes` sees `editor.getCode()` !== the
   string last passed to `parsePattern`, skip highlighting.

---

## 4. Layout jitter when swapping songs from Recents

Fusion: click anything in Recents while playing → the whole top area shifts
up, then back down. Any song.

The recents click path is the same as §3 (`openPath` → `replaceCodeAndPlay`
→ `evaluate` → `visualizer.resetCache()` + `applyBpm` + `file:changed`).

### Strongest match: `#visualizer` height animation

`ui/style.css:1209`:

```css
#visualizer {
    min-height: 120px;
    transition: height 0.2s ease-out; /* animates every height write */
}
```

Cycle view writes `container.style.height` from track count
(`visualizer.ts:431-439`). Song swap calls `resetCache()` (`_lastStartCycle
= -1`, `_detectedPeriod = 0`) then the next query often has a different
(or briefly zero) track count.

Sequence Grid is the first sidebar section. When that block shrinks,
everything under it jumps **up**; when height is reapplied it jumps **down**.
That is the "up then back down" report.

Fusion already fixed this in strudel-rs `b6e9809`:

```css
#visualizer {
    height: 120px;   /* was min-height */
    transition: none; /* was height 0.2s ease-out */
}
```

plus "only grow the canvas backing store, never shrink it in place."

### Other contributors (same click)

| Where | What happens |
|---|---|
| `file-explorer.ts:70` | `file:changed` → `refreshRecents` → `render()` wipes `#fileTree` (`innerHTML = ''`) and rebuilds Recents + tree. Recents *is* the top of the left panel. |
| `app.ts:1305` / `#error` | `display: none` ↔ `display: block` (`style.css:1096`). Sits under the editor, so it eats editor height, not the app header. Flashes if parse throws then recovers. |
| `cm-inspect-panel` | CodeMirror bottom panel. `updateInspect` is async; `showError` / inspect failure calls `clearInspect()`, which unmounts the panel and grows the editor, then a later success remounts it. |
| `header` (`style.css:190`) | `flex-wrap: wrap` and no `min-height`. BPM rewrite (`applyBpm` from the new file) is the only header content that changes on swap; unlikely to wrap on its own. |
| `.panel-header` | Fixed 32px. Not the jitter. |

App header / Pattern Console header heights do not change on this path.
If the report is the **app chrome**, the visualizer transition is still the
best first fix (sidebar is the only top-of-column block that actually
animates). If they meant the **files panel**, the Recents `innerHTML`
rebuild is the next place to look (rebuild in place, or don't clear the
section until the new list is ready).

### Suggested fix

1. Port `b6e9809` CSS: fixed `#visualizer` height, `transition: none`.
2. Port the "don't shrink the canvas bitmap" part of that commit if Cycle
   view still resizes the element from track count.
3. After that, if Recents itself still jumps: stop wiping `#fileTree` on
   every `file:changed`; patch the Recents rows instead.

---

## Suggested implementation order

1. **Visualizer height** (`b6e9809`) — smallest diff, matches the jitter
   report directly.
2. **Highlighter hygiene** — `clearActiveNotes` on `setCode` / failed
   evaluate. Confirm whether file-open should reset the clock.
3. **Unified scrollbars** (`46b983a`) — CSS-only, independent.
4. **Tooltip migration** (`253f428`) — add `tooltip.ts` + CSS, then sweep
   `title=` as listed above. Largest mechanical change; do last so it
   doesn't collide with the other CSS.

Do not take synth-category sidebar HTML from `253f428`. Do not take the
`Chain` query refactor.
