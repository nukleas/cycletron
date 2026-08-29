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
| **Right sidebar** | **Sequence Grid** (Cycle / Piano Roll / Waveform), **Signal Scope**, runtime stats, the **Sounds** browser, and the Browse Examples button. |

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

BPM and gain live in the top bar, along with a **metronome** toggle and
**skip ±5 cycles** buttons. Three fixed global shortcuts work while another
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
