# Show files

A show file (`*.show.toml`) composes a music video from Cycletron songs. For
each section of each song it sets what's on screen: the visual mode, the
camera, the cuts and transitions, colors, text, the song's code, and effects.

- **Live:** open the file in Cycletron. The set plays with the show file in a
  pane beside the song, and edits take effect as you type.
- **Rendered:** `render-viz.mjs` writes the same video to an MP4.

Both cut the same video. Every frame is a function of song time, so what you
preview live is what renders.

Three shows come with the app, in your library's `Demos/Shows/` (`ui/shows/`
in the repo): `agency-ost` plays the Agency album, `feature-tour` uses every
setting with a comment on each section saying what it shows, and
`cycletron-trailer` is the trailer.

Contents: [Quick start](#quick-start) · [How a show is built](#how-a-show-is-built) ·
[Key reference](#key-reference) · [Modes](#modes) · [Palettes](#palettes) ·
[Camera moves](#camera-moves) · [Transitions](#transitions) · [Text](#text) ·
[Code](#code) · [Playing live](#playing-live) · [Rendering](#rendering) ·
[Recipes](#recipes) · [Gotchas](#gotchas)

---

## Quick start

```toml
[show]
out = "renders/my-video.mp4"

[defaults]
code = "hide"
camera = "drift"

[[song]]
source = "../Songs/my-song.strudel"
mode = "tunnel"

[song.sections]
intro = "lissajous"
drop  = { shots = ["iso-city", "plasma"], every = 2, transition = "flash", strobe = "kick" }
```

Play it: open the file in Cycletron (⌘O, or click it in the file tree).
Render it:

```sh
cd ui   # from the cycletron checkout
node scripts/render-viz.mjs path/to/my.show.toml
```

---

## How a show is built

### Songs and sections

A show is a list of songs (`[[song]]`), played in order. Each song needs a
**form**: a `pickRestart` selector whose labels name its sections.

```js
"<intro@2 verse@2 drop@4 outro>".slow(4).pickRestart({
  intro: stack(…), verse: stack(…), drop: stack(…), outro: stack(…),
})
```

A section's length in bars is its weight times the `slow` factor. Here
`intro@2` under `.slow(4)` is 8 bars, and `outro` is 4. The labels (`intro`,
`drop`, …) are what `[song.sections]` refers to. To list a song's sections
with their bars, run `cargo run -p song-check -- song.strudel` from the
Cycletron repo.

### Bars

Every position and length in a show is in **bars** (cycles), so the edit
stays locked to the music at any tempo. Fractions are fine: `0.5` is half a
bar, and `0.25` is one beat in 4/4.

### Layers

A setting comes from the most specific place it's written:

1. `[defaults]`: every song and section.
2. `[[song]]`: that song's sections.
3. `[song.sections].<label>`: that one section.
4. A shot inside `shots`: that one shot (only `mode`, `bars`, `camera`, `palette`).

Anything a layer leaves out comes from the layer above it. Table-valued
settings (`camera`, `code`, `strobe`) layer **field by field**. For example,
`code = { place = "right" }` in a section keeps the song's `follow` and
`size`, and moves only the column.

### Writing sections

A section is either a mode name, or a table:

```toml
[song.sections]
intro = "lissajous"                                # just a mode
drop  = { mode = "plasma", palette = "vapor" }     # an inline table (one line)

[song.sections.break]                              # or a full table: easier for long ones
mode = "forest-drive"
letterbox = 2.39
text = [
  { say = "first line", at = 1 },
  { say = "second line", at = 3 },
]
```

TOML doesn't allow line breaks inside `{ … }`, except inside a list's
`[ … ]`. Use the `[song.sections.label]` form for anything long.

### Strictness

Every key and value is checked. A typo or bad value fails with its exact
location (`song[1].sections.drop.camera.kick: expected 0 to 4, not 5`). Live,
the error is marked on its line in the show pane, and the last good version
keeps playing.

---

## Key reference

### `[show]`

| Key | Default | Value |
|---|---|---|
| `title` | — | The show's name. |
| `out` | — | Where a render goes, relative to the show file. Required to render unless `--out` is given. |
| `size` | `"1920x1080"` | The render's frame size, `"WIDTHxHEIGHT"`. |
| `fps` | `60` | The render's frame rate. |

### `[[song]]`

| Key | Default | Value |
|---|---|---|
| `source` | required | The `.strudel` file, relative to the show file (`~` works). |
| `mode` | required unless `shots` | The mode for sections not listed. |
| `shots` | — | Modes to cut between through every section not listed. See [shots](#shots). |
| `passes` | `1` | Times through the form before the next song. |
| `fade` | none | `{ in = 2, out = 4 }`: bars fading up from black at the start, and down to black at the end of the last pass. |
| `performance` | auto | A `performance-export` directory to render from. Without it, the render exports the song itself. |
| `gain_db` | `0` | Render volume. |
| `sensitivity` | `1` | How strongly the visuals react to the audio. |
| `sections` | — | The per-section table. |

A song can also set any key from the next table, for all its sections.

### Anywhere: `[defaults]`, `[[song]]`, or a section

| Key | Default | Value |
|---|---|---|
| `code` | `"off"` (all the code, shown) | How the song's code shows over the visuals. Set `"hide"` for visuals only. See [code](#code). |
| `camera` | `false` | `true`, `false`, a move, or `{ move, punch, kick }`. See [camera moves](#camera-moves). |
| `titles` | `false` | A title card on each section's downbeat. |
| `transition` | `"cut"` | How each shot is entered. See [transitions](#transitions). |
| `every` | `4` | Bars each shot holds when it doesn't say. |
| `palette` | `"neon"` | Colors the visuals are drawn in. See [palettes](#palettes). |
| `letterbox` | `false` | Cinema bars cropping to an aspect: `2.39` (scope), `2.76`, `1.85`… Must be more than 1 and at most 4. |
| `grain` | `0` | Film grain, `0` to `1`. |
| `scanlines` | `true` | The faint scanline texture. |
| `strobe` | `false` | A white flash on each hit: `"kick"`, `"snare"` or `"beat"`, or `{ on = "kick", strength = 0.3 }`. Strength runs 0 to 1, default 0.6. |
| `speed` | `1` | How fast the visuals move, against the music's pace: `0.5` is slow motion, `2` double, `0` frozen, `4` at most. Timing stays on the beat. |

### Sections only

| Key | Value |
|---|---|
| `mode` | Holds through the section, replacing any `shots` from the song. |
| `shots` | Cuts between modes through the section. Give `mode` or `shots`, not both. |
| `title` | The section's title card text, in place of `// LABEL`. It turns that card on even where `titles = false`. |
| `text` | Words on screen. See [text](#text). |

### Shots

```toml
shots = ["iso-city", "cockpit", "tunnel"]          # each holds `every` bars
shots = [
  { mode = "iso-city", bars = 2, palette = "sunset" },
  { mode = "cockpit", camera = "shake" },          # bars from `every`
]
```

Shots play in order and repeat until the section ends. The last one is cut
short if it would run past the end. A shot can set its own `mode`, `bars`,
`camera` and `palette`. Each shot starts a fresh camera move, and each cut
uses the section's `transition`.

---

## Modes

| Mode | What it draws | Driven by |
|---|---|---|
| `iso-city` | An isometric city: each sound a district, each hit a building, lit as the playhead crosses it. Traffic follows the drums. | the pattern |
| `neon-circuit` | The pattern as a circuit board in the same isometric view: traces, vias and lit chips. | the pattern |
| `cockpit` | A vector flight display. Kicks are armored targets, snares winged craft, notes diamonds, intercepted on their onsets. | the pattern |
| `forest-drive` | A country road at dusk. Every tree on the verge is a note, reaching the windshield on its beat. | the pattern |
| `tunnel` | Octagonal rings flying at you, one per beat, each reaching the gate on time. | the pattern |
| `marble-core` | Concentric rings, one per track, with a playhead arm sweeping once per bar. | the pattern |
| `marble-drop` | A Galton board: every hit drops a marble that fills a histogram. | the pattern |
| `matrix-rain` | Glyph streams, one per note, each track in its own band of columns. | the pattern |
| `spot-field` | Optical spot clouds, one per track, bursting on hits, with long-exposure trails. | the pattern |
| `lens-bench` | A blueprint optical bench with a live ray trace; notes ride the rays as pulses. | the pattern + audio |
| `kaleidoscope` | Particle bursts mirrored eight ways, one band per track. | the pattern |
| `plasma` | Metaballs as a contour map, each track its own color. | the pattern |
| `attractor` | A Lorenz attractor kicked by each hit. | the pattern |
| `vector-nexus` | Wireframe polyhedra in a ticked ring. | audio |
| `lissajous` | The waveform against a delayed copy of itself, with phosphor trails. Calm; good for opens and outros. | audio |
| `ascii-scope` | A phosphor scope that etches ASCII artwork where the beam passes. | audio |
| `wave-terrain` | The spectrum as a ridge landscape scrolling toward you. | audio |
| `flame-graph` | The spectrum as one flame, bass to air, with embers. | audio |
| `logo` | The Cycletron icon and wordmark in ASCII. The screen shows the spectrum, the antennae flash on kick and snare, the grille lights with the bands. For end cards. | the pattern + audio |

Modes "driven by the pattern" draw the song's actual notes and tracks: what
you see is the code. The others react to the sound.

---

## Palettes

| Palette | Feel |
|---|---|
| `neon` | The app's own: cyan, magenta, yellow. |
| `ice` | Pale blue and white. |
| `vapor` | Pink, cyan and lemon, vaporwave. |
| `sunset` | Coral, violet and gold. |
| `amber` | Orange phosphor terminal. |
| `blood` | Reds on near-black. |
| `toxic` | Acid green and yellow. |

A palette recolors the mode, and the code overlay with it. Give each shot its
own for a color change on every cut.

---

## Camera moves

| Move | What it does |
|---|---|
| `drift` | A slow zoom and pan across the section, leaning the other way each section. |
| `push` | Zooms in across the section. |
| `pull` | Zooms out across the section. |
| `orbit` | A slow rotation, alternating direction each section. |
| `still` | No movement: only the punch and kicks. |
| `shake` | A handheld wobble. |

Two strengths, scaling from `1` (`0` turns one off, `4` is the maximum):

- `punch`: the slam out on each cut (a section or shot start). There's none at a song's very start.
- `kick`: the bump on each kick drum in the pattern.

```toml
camera = "orbit"
camera = { move = "shake", punch = 2, kick = 3 }
camera = { kick = 0 }        # keep the move from above, no kick bumps
```

---

## Transitions

How each shot, and each section, is entered.

| Kind | Default bars | Effect |
|---|---|---|
| `cut` | — | A hard cut. |
| `flash` | 0.25 | A white flash decaying into the new shot. |
| `fade` | 1 | Dissolves from the previous shot's last frame. At a song's very start it fades up from black instead. |
| `black` | 0.5 | Comes up from black. |
| `glitch` | 0.25 | Bands of the frame tear sideways, tinted, then settle. |

```toml
transition = "fade"
transition = { kind = "glitch", bars = 0.15 }
```

---

## Text

### Section title cards

With `titles = true`, each section opens with a card: a flash, then
`// LABEL` glitches in, holds about 1.3 seconds, and fades. A small
`03 / 07` counter sits above it. `title = "…"` replaces the text, and also
turns that one card on.

### Lines of text

```toml
text = [
  { say = "every sound a district", at = 1.5, hold = 2.4 },
  { say = "THIS VIDEO IS CODE.", at = 2, hold = 2.4, style = "card" },
  { say = "shots = [\"iso-city\", …]", at = 2.2, hold = 2, place = "top" },
]
```

| Field | Default | Value |
|---|---|---|
| `say` | required | The words. Quotes inside need `\"`. |
| `at` | `0` | Bars into the section it appears. |
| `hold` | `2` | Bars it stays before fading. |
| `place` | `bottom` (lines), `center` (cards) | `bottom`, `center` or `top`. |
| `style` | `line` | `line` is a caption that types in. `card` is a big glitching card, like a title. |

Text has no background box: a thin dark outline keeps it legible over the
visuals. Long text shrinks to fit the frame width. `text` is set per section
and isn't inherited.

---

## Code

The song's own code, drawn over the visuals the way Stage Mode draws it, with
the playing notes lit.

```toml
code = "solo"
code = { follow = "solo", place = "right", size = 22, opacity = 0.6, scrim = false, type = 2 }
```

| Field | Default | Value |
|---|---|---|
| `follow` | `off` | `hide` shows none. `off` shows all of it, still. `fold` collapses the sections not playing. `solo` shows only the playing section, under a breadcrumb of the form. |
| `size` | Stage Mode's setting | Text size in px at 1080p, 10–96. Smaller text makes a narrower column too. |
| `place` | `left` | `left`, `center` or `right`. |
| `opacity` | `1` | 0–1, to sit the code back behind the visuals. |
| `scrim` | `true` | The dark backing behind each row. `false` puts the code straight on the visuals. |
| `type` | none | Bars over which the code types itself in from the section's downbeat. The playing notes light up once it's typed. |

---

## Playing live

- **Open:** ⌘O, click a `.show.toml` in the file tree, or drag it onto the
  window. The first song opens in the editor and plays from its start, and
  the show opens in a pane beside it.
- **Edit:** changes in the show pane take effect about 0.3 s after you stop
  typing. An error is marked on its line, and the last good version keeps
  playing. ▶ marks the line setting the playing section. Edits to the song
  itself apply as usual and re-cue the show.
- **Save:** ⌘S saves whichever editor you last typed in, the show pane or the
  song.
- **Stage:** ⌘⇧F shows the visuals full-frame with the code layer. ⌘⇧V
  toggles the visuals behind the editor. The camera, text, palettes and
  effects play in both.
- **Commands** (⌘⇧P palette): **Show: Next Song**, **Show: Previous Song**
  (switch on the next bar), **Stop Show**.
- **The set:** each song plays its form `passes` times, then the next starts
  on the downbeat at its own tempo. The last song loops. If the playing song
  has unsaved edits, the set waits, then moves on at the next section once
  you save.
- **Closing:** closing the pane or opening another file ends the show. An
  unsaved show asks Save / Discard / Cancel.

---

## Rendering

```sh
cd ui   # from the cycletron checkout
node scripts/render-viz.mjs path/to/show.toml [flags]
```

| Flag | Value |
|---|---|
| `--song n` | Only the nth song, counting from 1. |
| `--section label` | Only that section, from the first song that has it. Add `--song` to skip exporting the others. |
| `--from s`, `--to s` | Trim to these seconds of what's rendered. |
| `--size WxH`, `--fps n` | Override the show's settings, e.g. for quick previews. |
| `--out file` | Override the show's `out`. |
| `--jobs n` | Browsers rendering at once. The default is sized to the machine's cores. |
| `--fresh` | Re-export the songs even when the cached exports are current. |

### Previews

```sh
# one section, small and fast
node scripts/render-viz.mjs my.show.toml --song 1 --section drop --size 960x540 --fps 30 --out /tmp/drop.mp4

# the whole set, small: about 10 s per minute of video
node scripts/render-viz.mjs my.show.toml --size 640x360 --fps 24 --out /tmp/preview.mp4
```

A full 1080p60 render takes about as long as the video plays, on 8 cores.

### Exports and audio

Rendering needs each song's mix and section timing (a performance export).
The first render of a song makes one, in about 20 s, and caches it in
`~/.cache/cycletron/performance`. It's redone when the song file changes.

The render carries the raw mix, at the level the visuals are tuned to react
to. To master it, re-encode the audio only:

```sh
ffmpeg -i video.mp4 -af "acompressor=threshold=-26dB:ratio=2:attack=15:release=150:makeup=3dB,volume=15dB,alimiter=limit=0.84" -c:v copy video-master.mp4
```

Or swap in a separately mastered WAV:

```sh
ffmpeg -i video.mp4 -i master.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest video-master.mp4
```

Songs play back to back, each starting on the downbeat after the previous
one ends. In a render the video ends with the last song, which doesn't loop.

---

## Recipes

**A cut on every bar, each shot its own color**

```toml
[song.sections.drop]
shots = [
  { mode = "iso-city", palette = "sunset" },
  { mode = "tunnel", palette = "vapor" },
  { mode = "matrix-rain", palette = "toxic" },
]
every = 1
transition = "flash"
strobe = { on = "kick", strength = 0.12 }
camera = { move = "drift", punch = 1.5 }
```

**A cinematic break**

```toml
[song.sections.break]
mode = "forest-drive"
palette = "sunset"
letterbox = 2.39
grain = 0.45
transition = "black"
camera = { move = "drift", punch = 0 }
```

**Code typing itself in, then lighting up**

```toml
[song.sections.intro]
mode = "neon-circuit"
code = { follow = "solo", size = 34, type = 1.6 }
camera = { move = "push", punch = 0 }
```

**Lyrics, a line per phrase**

```toml
[song.sections.verse]
text = [
  { say = "11 PM.", at = 0, hold = 2 },
  { say = "the phone lights up", at = 2, hold = 2 },
  { say = "and I'm already gone", at = 4, hold = 3 },
]
```

**Big word slams on the beat**

```toml
text = [
  { say = "LINK.", at = 3, hold = 0.2, style = "card" },
  { say = "OSC.", at = 3.25, hold = 0.2, style = "card" },
  { say = "GO.", at = 3.75, hold = 0.2, style = "card" },
]
```

**Visuals only, cards only on chosen sections**

```toml
[defaults]
code = "hide"
titles = false

[song.sections.drop]
title = "THE DROP"          # this one section gets a card
```

**A song that fades in and out, played twice**

```toml
[[song]]
source = "../Songs/x.strudel"
mode = "lissajous"
passes = 2
fade = { in = 2, out = 4 }
```

---

## Gotchas

- **The code shows by default** (`code = "off"`), in Stage and in renders.
  Put `code = "hide"` in `[defaults]` for visuals only, and turn it on per
  section.
- **A `center` line on a section's downbeat** sits on that section's title
  card. Use `place = "bottom"` or start it a bar later.
- **Cards and centered code overlap.** Move the code (`place = "right"`), fade
  it (`opacity`), or hide it for that section.
- **`orbit`** shows the frame's corners in very wide windows (the live
  visuals behind the editor). Stage and renders are 16:9 and fine.
- **The kick strobe on four-on-the-floor** flashes four times a bar. Keep
  `strength` around 0.1–0.35 or it washes the frame grey.
- **The opening fade:** a `fade` transition into a song's first section
  comes up from black, live and rendered alike.
- **`passes` and the last song:** live, the last song loops forever, and
  dips to black at the end of its passes if it has `fade.out`. A render ends
  with it.
- **Section labels** must match the song's `pickRestart` labels exactly. A
  label the song doesn't have fails with the list of the ones it does.
- **`mode` vs `shots`:** a section's own `mode` replaces the song's `shots`.
  Giving both in one section is an error.
- **The palette applies to the code overlay too**, since the code is drawn in
  the theme's colors.
