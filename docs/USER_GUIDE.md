# Cycletron — User Guide

Live coding for music on a native Rust engine. Patterns run on **strudel-rs**
with a Strudel-compatible mini-notation dialect. This guide is the product
manual; for engine footguns see [DIALECT.md](./DIALECT.md).

---

## First 60 seconds

1. **Press Play** (toolbar transport or **⌘↩**) so the audio engine arms.
2. Open **Examples** (bottom of the right sidebar, View → Browse Examples,
   or **⌘⇧P** → Browse Examples…).
3. Load **Lesson 1 · First Steps** and you should hear a short melody.
4. Want the AI? It's **off by default** — click **Enable AI…** in the AI panel
   (left) or Preferences → AI, pick a provider, then describe a change:
   *"add a kick drum"* or *"make this darker at 120 bpm"*.

No API key is required to play examples. A key, an OAuth sign-in, or a local
model is only needed for the AI operator — and only after you enable it.

---

## The layout

| Area | What it does |
|------|----------------|
| **Editor** (center) | Pattern code. Empty state offers Open / New / Examples. |
| **AI Operator** (left) | Chat with the model; it writes and rewrites the editor. Off until enabled. |
| **File System** (left, under AI) | Your library root — patterns, MIDI imports, folders. |
| **Right sidebar** | **Sequence Grid** (Cycle / Piano Roll / Waveform), the **Mixer**, **Signal Scope**, runtime stats, the **Sounds** browser, and the Browse Examples button. |

The curated corpus is no longer a panel — the AI searches it directly
(`search_corpus`), and View → Reload Corpus & Recipes refreshes it in dev.

---

## Transport & editing

| Action | Shortcut |
|--------|----------|
| Play / Pause | **⌘↩** |
| Evaluate current block only | **⇧↩** |
| Stop | **Esc** or **⌘.** |
| Command palette | **⌘⇧P** |
| New / Open / Save / Save As | **⌘N** / **⌘O** / **⌘S** / **⌘⇧S** |
| Preferences | **⌘,** |
| Find (panel includes Replace) | **⌘F** |
| Toggle AI panel | **⌘⇧A** |
| Immersive visualizer / next mode | **⌘⇧V** / **⌘⇧]** |
| Stage Mode (performance view) | **⌘⇧F** |
| Undo / Redo *pattern* (distinct from text undo) | **⌘⌥Z** / **⌘⌥⇧Z** |
| Tempo ±1 | Playback menu or command palette |

BPM and gain live in the top bar, along with a **metronome** toggle,
**skip ±5 cycles** buttons, and the **Q** launch-quantization button (see below). Three fixed global shortcuts work while another
app is focused: **⌘⇧Space** play/pause, **⌘⇧.** stop, **⌘⇧,** focus the
window.

The command palette is also a file finder — it searches your recents and
library files, not just commands.

---

## Working with patterns

- Files use the **`.strudel`** extension (`.js` files open too).
- Optional frontmatter at the top of a file can record `name`, `bpm`, tags,
  and creation date.
- **⌘↩** evaluates the whole buffer and starts (or updates) playback.
- Edits while playing hot-swap on the next eval — there is no separate "compile" step.
- **File → Export Audio…** (`⌘⇧E`) offline-bakes WAV (and stems, when the
  pattern has multiple `$:` tracks) via the Rust DSP engine — faster than
  realtime. MP3 export requires `ffmpeg` on your PATH.
- **File → Export MIDI…** writes a Standard MIDI File from the current pattern.
- The **Record** button (editor header) captures the live performance in
  realtime to a lossless 32-bit float WAV, streamed straight to disk — a take is
  limited by free space, not memory. It records the mix at unity, so turning
  your monitors up or down never changes the file, and the metronome click
  stays out of it. Leave "bars" empty to stop by hand.
- Every save keeps a **snapshot** — the History button (editor header) lets
  you browse and restore up to 50 per file.

### Launch quantization

The **Q** button in the top bar decides *when* an evaluate takes effect. Each
click steps to the next grid:

| Setting | Behaviour |
|---------|-----------|
| **Q ·** (Now) | Classic live coding — the swap happens the instant you hit **⌘↩**. |
| **Q 1 / 2 / 4 / 8** | The new pattern is held and swapped in on the next boundary of that many bars. |

While a swap is parked the button pulses and its label becomes a countdown.
Evaluating again before it lands replaces what's waiting without pushing the
landing further out, so you can keep editing right up to the bar line. If you
evaluate just *before* a boundary — the most common moment in a set — it still
catches that boundary rather than slipping a whole bar.

The outgoing pattern is scheduled right up to the boundary and the incoming one
from the boundary onward, so the two meet exactly on the beat with no dropped or
doubled events. Tempo changes declared by the incoming code (`setbpm(…)`) are
held back until it lands too. Stop cancels a parked swap; pause and seek apply
it immediately.

**⌘⇧P → Launch Quantization: Next Grid** does the same as a click, for a
keyboard or a MIDI pad.

### Mixer

The **Mixer** panel (right sidebar) lists the `$:` tracks in the current buffer
with **M** (mute) and **S** (solo) per track. It appears only when the buffer
actually has `$:` tracks.

Track names come from the comment directly above each track, so this names them
"drums" and "bass":

```
setbpm(120);

// drums
$: s("bd*4, ~ sd")

// bass
$: note("c2 eb2").s("sawtooth")
```

Without a comment, a track is named after the first sound it plays. **Clear**
drops every mute and solo at once.

Mixer moves obey the Launch grid, so mutes land on the bar just like an
evaluate. Toggling while stopped stays stopped.

**Your file is never modified.** Mute/solo is an override applied on the way to
the audio engine; the buffer, the file on disk, and audio export all still
reflect exactly what you wrote. Mixer state is per-session and resets when the
track list changes.

There are deliberately no gain faders. On this engine `.gain()` *replaces*
rather than scales — `s("bd").gain(0.8).gain(0.5)` is 0.5 — so a fader
implemented this way would silently throw away whatever gain the pattern set
for itself. Real faders need per-orbit bus gain in the DSP engine; until that
exists the mixer only does what it can do exactly.

### Examples (in-app)

Open **View → Browse Examples** (or the empty-state Examples button). Sections:

1. **Lessons** — progressive ramp (start here).
2. **Patterns** — hand-picked techniques and textures.
3. **Showcase** — fuller groove sketches.
4. **Techniques** — curated corpus (rhythm, melody, harmony, form, timbre, motion).
5. **Songs & albums** — full original tracks, including the Agency OST.
6. **Genres** — generated skeletons plus concise, curated style examples.

Use the filter box to search by title, tag, or description. Always **Play
first**, then load an example so audio is already armed.

### Library & demos

Whenever your library folder is set up (first launch default, or when you choose a
root in the welcome wizard / Preferences), Cycletron seeds a **Demos/** folder:

| Folder | Contents |
|--------|----------|
| `Demos/Songs/` | Full tracks + `Agency/` album |
| `Demos/Techniques/` | Curated short patterns by category |
| `Demos/Genres/` | Generated skeletons + curated examples by genre |

Browse them in the File System panel, open any `.strudel`, and remix. Existing
files are never overwritten on upgrade — only missing demos are filled in.
Save your own work alongside them in the library root (Preferences → Library).

---

## AI operator

1. **Enable AI** — click **Enable AI…** in the AI panel or check the consent
   box in Preferences → AI. Until then the panel is inert and no provider is
   ever contacted, regardless of configured keys.
2. Choose a provider in Preferences: Claude, Grok, Codex (ChatGPT), OpenAI, a
   local endpoint (Ollama / LM Studio), or a custom OpenAI-compatible URL.
   Note: local models without tool-calling can chat but can't drive the audio.
3. Sign in: paste an API key (or export the provider env var — e.g.
   `ANTHROPIC_API_KEY` — when developing), **or use OAuth** — Preferences → AI
   offers **Sign in with SuperGrok** and **Sign in with ChatGPT**, which bill
   to your existing subscription instead of an API key.
4. Describe musical intent in plain language. The model sees the current
   editor code automatically — you do not need to paste it.
5. Prefer asking for small, hearable changes over "rewrite the whole track"
   until you trust the loop.
6. To start fresh, use Edit → Clear Session (or the AI panel's **New** button).

**Privacy:** prompts and pattern text go to the provider you chose. Keys stay
on this machine. Local telemetry (agent stats) stays on disk under the app
data directory and is not uploaded.

---

## Samples & sounds

The app bundles a full default kit: essential drums, five drum-machine kits
(TR-808 / TR-909 / TR-707 / LinnDrum / DR-55 — use `.bank("RolandTR808")`),
percussion and texture banks (`perc metal east hand industrial space arpy
tabla jvbass` …), melodic and speech banks (`flbass uke cpluck cbow speech` —
pick variants with `s("flbass:2")`), synth waveforms, wavetables, and GM
soundfonts loaded on demand.

The **Sounds** panel (right sidebar) lists everything currently loaded,
grouped by category, with usage hints.

For more sounds:

| Action | Where |
|--------|--------|
| Load a folder for this session | Command palette → **Load Sample Folder…** |
| Install a folder as a lasting pack | Command palette → **Install Sample Pack…** |
| Manage packs (enable/disable each, open the folder) | Command palette → **Sample Packs…** |

Packs live under `{library}/Packs/`. Format: [SAMPLE_PACKS.md](./SAMPLE_PACKS.md).

### Sample sets — sounding like strudel-rs (and beyond)

The **Samples** manager (⌘⇧P → "Samples…", or the Sounds panel's Manage
button) is the one place for sample sources: **sample sets** on top,
**packs** below. The built-in **strudel-rs** set fetches strudio's default
sounds (Salamander piano, uzu drumkit, uzu wavetables, Dirt-Samples — from
their upstream repos, ~300 MB); activate it and live playback *and* audio
export resolve from that set, so what you hear and export matches
strudel-rs / `strudio` exactly. The default **Cycletron** set keeps the
bundled offline kit. Whatever set is active, export uses the same samples as
live playback, and switching reloads the audio engine immediately (also via
the palette's "Sample Set: …" entries). Define additional sets (each an
ordered list of `strudel.json` manifest URLs) in `sample-sets.json` in the
app data folder — see [SAMPLE_PACKS.md](./SAMPLE_PACKS.md).

---

## MIDI

| Feature | Where |
|---------|--------|
| Import a `.mid` / `.midi` file | File → Import MIDI… or drag onto the window |
| MIDI Lab | conversion options, channel filter, drum banks |
| Play-in capture | play a phrase on your controller; commit it to a `$:` track |
| CC mapping | map two CCs to gain and BPM (Preferences → MIDI Input) |
| Pad bindings | map hardware pads/keys to actions — Play/Stop, Hush, Evaluate, Commit as loop, and more (Preferences → MIDI Input → Learn) |

A connected keyboard is captured, not auditioned — incoming notes go to the
monitor and the capture buffer as a `note(…)` line rather than making sound
directly. Imported patterns land as `.strudel` in your library after you save
them.

---

## Ableton Link

Preferences → **Ableton Link** shares tempo and bar phase with Ableton Live,
Bitwig, Rekordbox and the long tail of Link-enabled apps and hardware. Tick
**Sync tempo and bar phase over Ableton Link** and save — discovery is automatic,
so there is no host, port or session to pick. The section reports how many peers
it can see and the tempo they agree on.

This is how you play alongside someone else's DAW. Link works over the local
network, so it also spans two machines on the same Wi-Fi with nothing configured
on either.

Two things change while Link is on:

- **The session owns the tempo.** The BPM slider and a pattern's `setbpm` both
  defer to it, because a local tempo change would otherwise silently drop you out
  of sync with everyone else. Turn Link off to get the tempo back.
- **Play waits for the bar line.** Pressing play mid-bar starts on the session's
  next downbeat instead, so you come in on the beat rather than wherever you
  happened to press. The status line says `Waiting for Link bar…` while it holds.
  Alone in a session there is no phase to wait for, so play starts immediately.

Cycletron follows the session and never changes it: it does not propose its
tempo to peers, and Link's start/stop sync is not used. Set the tempo on the
other app.

Once playing, the two apps free-run against different clocks — Cycletron's
transport is anchored to its audio device, Link's to the system clock — so they
drift apart by the difference between those two, slowly. Over a long set you may
need to stop and start again to re-align.

---

## OSC output

Preferences → **OSC Output** streams the transport and every note onset out over
UDP, so Cycletron can drive the rest of the live-coding ecosystem — Hydra,
Resolume, TouchDesigner, SuperCollider, or a DMX lighting rig — without either
side knowing about the other. Tick **Send OSC over UDP**, set a host and port
(default `127.0.0.1:57120`), and save; the section reports the resolved target
or the reason it failed.

| Address | Arguments |
|---------|-----------|
| `/cycletron/transport` | `state` (`playing` / `paused` / `stopped`), `bpm`, `cps` |
| `/cycletron/cycle` | `cycle` — absolute transport position, sent continuously |
| `/cycletron/hap` | `track`, `note` (NaN when unpitched), `dur` in cycles, `index` |

`/cycletron/cycle` and the haps for a frame are sent together in one bundle.
Track names are the sound names the engine reports (`bd`, `sd`, `sawtooth`), the
same ones the visualizers colour by.

Onsets are emitted on the animation frame that crosses them (~16 ms), which is
what visuals and lighting want. It is **not** sample-accurate, so this is not a
way to drive an external sampler or synth in time — that needs full per-hap
parameter maps the engine doesn't expose yet.

---

## Immersive visualizer

**⌘⇧V** (or Visuals ▾ → Immersive) takes the music-reactive visualization
fullscreen: 15 modes, **⌘⇧]** or the on-screen HUD to switch, AUTO to cycle
them, HIDE to drop the HUD. The Visuals menu also has a **Readable mode**
toggle that calms the ambient background for readability.

---

## Stage Mode

**⌘⇧F** (or Visuals ▾ → Stage Mode) is the performance view: the visualizer
full-bleed with your code drawn on top of it, and nothing else — no header,
no panels, no status bar. Notes glow in the code as they fire. Press **⌘⇧F**
again to leave; the hint stays on screen for the first few seconds.

You keep typing normally the whole time. The editor is still there and still
focused, just hidden behind the stage — evaluate, undo, and every other
shortcut work as usual. **Escape** still stops playback rather than exiting.

Everything on stage is drawn into a single canvas at a fixed output size
(1080p by default; 1440p and 4K in the Visuals menu), letterboxed to fit the
window. That matters for capture: resizing the window changes only the black
bars, never the frame, so **a screen or window recording stays a clean, stable
16:9** — point OBS or Loom at it and you get the performance with none of the
app chrome. The higher presets are worth it if you capture the window
directly on a HiDPI display and want a 1:1 match.

---

## Updates

Cycletron checks GitHub Releases for updates on startup (toggle in
Preferences → Updates) and on demand via Help → Check for Updates…. Updates
download only after you confirm, then the app relaunches. Update manifests
are signed; the app verifies them against its built-in public key.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No sound | Press **Play** once to arm audio; check OS mute / sample rate; try Lesson 1. |
| AI panel does nothing | Enable AI first (AI panel → Enable AI…, or Preferences → AI). |
| AI fails | Preferences → key status; for local, confirm base URL and that the server is running. |
| Pattern silent | See [DIALECT.md](./DIALECT.md) (pan, voicing, scale format). Use Help → Dialect. |
| Weird errors | Help → Show Logs → copy diagnostic dump into a bug report. |
| API key prompt every launch (dev) | Export the env var in the shell you use for `cargo tauri dev`. |

---

## Help menu map

| Item | Purpose |
|------|---------|
| Keyboard Shortcuts… | Full shortcut list |
| Cycletron Dialect… | strudel-rs vs web-strudel footguns |
| User Guide… | This guide (in-app summary) |
| Open Strudel Docs (web) | Upstream web-strudel learning (not dialect truth) |
| Check for Updates… | Manual update check |
| Show Logs… / Show Welcome… / About Cycletron | Support and setup |

Engine ground truth for what the parser accepts: [STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).
