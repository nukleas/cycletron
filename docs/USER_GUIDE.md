# Cycletron — User Guide

AI-native live coding for music. Patterns run on **strudel-rs** (Rust) with a
Strudel-compatible mini-notation dialect. This guide is the product manual;
for engine footguns see [DIALECT.md](./DIALECT.md).

---

## First 60 seconds

1. **Press Play** (toolbar transport or **⌘↩**) so the audio engine arms.
2. Open **Examples** (bottom of the corpus panel, or View → Browse Examples).
3. Load **Lesson 1 · First Steps** and you should hear a short melody.
4. Optionally open the **AI panel** (left) and describe a change:
   *“add a kick drum”* or *“make this darker at 120 bpm”*.

No API key is required to play examples. A key (or a local model) is only
needed for the AI operator.

---

## The layout

| Area | What it does |
|------|----------------|
| **Editor** (center) | Pattern code. Empty state offers Open / New / Examples. |
| **AI Operator** (left) | Chat with the model; it writes and rewrites the editor. |
| **Files** (left, under AI) | Your library root — patterns, MIDI imports, folders. |
| **Visualizer** (bottom) | Cycle / piano / waveform scopes. |
| **Corpus / Sounds / Examples** (right edge panels) | Search curated patterns, list sounds, load examples. |

---

## Transport & editing

| Action | Shortcut |
|--------|----------|
| Play / Pause | **⌘↩** |
| Stop | **Esc** |
| Command palette | **⌘⇧P** |
| New / Open / Save / Save As | **⌘N** / **⌘O** / **⌘S** / **⌘⇧S** |
| Preferences | **⌘,** |
| Find / Replace | **⌘F** / **⌘⇧F** |
| Tempo ±1 | Playback menu or command palette |

BPM and gain live in the top bar. Global shortcuts (optional) can be set in
Preferences so transport works when another app is focused.

---

## Working with patterns

- Files use the **`.strudel`** extension (interop-friendly).
- Optional frontmatter at the top of a file can record `bpm` and tags.
- **⌘↩** evaluates the whole buffer and starts (or updates) playback.
- Edits while playing hot-swap on the next eval — there is no separate “compile” step.
- **File → Export Audio…** (`⌘⇧E`) offline-bakes WAV/MP3 (and optional stems) via the Rust DSP engine — faster than realtime, no need to press Record.
- **File → Export MIDI…** writes a Standard MIDI File from the current pattern.
- The transport **Record** button still captures the live mix (realtime) when you want that.

### Examples (in-app)

Open **View → Browse Examples** (or the empty-state Examples button). Sections:

1. **Lessons** — progressive ramp (start here).
2. **Patterns** — hand-picked techniques and textures.
3. **Showcase** — fuller groove sketches.
4. **Techniques** — curated corpus (rhythm, melody, harmony, form, timbre, motion).
5. **Songs & albums** — full tracks, covers, and the Agency OST.
6. **Genres** — one playable sketch per genre recipe.

Use the filter box to search by title or tag. Always **Play first**, then load
an example so audio is already armed.

### Library & demos

Whenever your library folder is set up (first launch default, or when you choose a
root in the welcome wizard / Preferences), Cycletron seeds a **Demos/** folder:

| Folder | Contents |
|--------|----------|
| `Demos/Songs/` | Full tracks + `Agency/` album |
| `Demos/Techniques/` | Curated short patterns by category |
| `Demos/Genres/` | One sketch per genre |

Browse them in the File Explorer, open any `.strudel`, and remix. Existing
files are never overwritten on upgrade — only missing demos are filled in.
Save your own work alongside them in the library root (Preferences → Library).

---

## AI operator

1. Choose a provider in Preferences or the welcome wizard: Claude, Grok,
   OpenAI, local (Ollama / LM Studio), or a custom OpenAI-compatible endpoint.
2. Paste the API key in Preferences (or export the provider env var —
   e.g. `ANTHROPIC_API_KEY` — when developing).
3. Describe musical intent in plain language. The model sees the current
   editor code automatically — you do not need to paste it.
4. Prefer asking for small, hearable changes over “rewrite the whole track”
   until you trust the loop.

**Privacy:** prompts and pattern text go to the provider you chose. Keys stay
on this machine. Local telemetry (agent stats) stays on disk under the app
data directory and is not uploaded.

---

## Samples

A default drum kit and a few texture banks ship with the app. For more:

| Action | Where |
|--------|--------|
| Load a folder for this session | Command palette → **Load Sample Folder…** |
| Installable packs (persist across launches) | Command palette → **Sample Packs…** |

Packs live under `{library}/Packs/`. Format: [SAMPLE_PACKS.md](./SAMPLE_PACKS.md).

---

## MIDI

| Feature | Where |
|---------|--------|
| Import a `.mid` / `.midi` file | File → Import MIDI… or drag onto the window |
| MIDI Lab | conversion options, channel filter, drum banks |
| Live keyboard input | MIDI In status / Preferences |
| Pads | on-screen drum/note pads |

Imported patterns land as `.strudel` in your library after you save them.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| No sound | Press **Play** once to arm audio; check OS mute / sample rate; try Lesson 1. |
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
| Open Strudel Docs | Upstream web-strudel learning (not dialect truth) |
| Show Logs… / Welcome… / About | Support and setup |

Engine ground truth for what the parser accepts: [STRUDEL_RS_SUPPORTED.md](./STRUDEL_RS_SUPPORTED.md).
