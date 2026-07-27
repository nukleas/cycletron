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

### Examples (in-app)

Examples are grouped:

1. **Lessons** — progressive ramp (start here).
2. **Patterns** — techniques and textures.
3. **Showcase** — fuller grooves and concept-album excerpts.

Always **Play first**, then load an example so audio is already armed.

### Library & songs

Demo songs live under `ui/songs/` in the source tree (Agency OST, covers,
grooves). Save your own work into the **library root** chosen in the welcome
wizard or Preferences.

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
