# Cycletron (legacy codename: Robostrudel)


AI-first strudel music engine — Tauri v2 desktop app.

## Architecture

The frontend IS the strudel-rs WASM REPL (lifted from `../strudel-rs/www/wasm-repl/`),
with an AI chat panel added alongside. Audio runs entirely in WASM via AudioWorklet +
SharedArrayBuffer — the Tauri Rust backend never touches audio.

```
Tauri Desktop Shell
├── ui/ (frontend = WASM REPL + AI chat panel)
│   ├── src/app.ts           — StrudelApp (WASM REPL core, from strudel-rs)
│   ├── src/editor.ts        — CodeMirror editor with strudel highlighting
│   ├── src/visualizer.ts    — Cycle/piano/waveform visualization
│   ├── src/ai-bridge.ts     — NEW: Tauri↔WASM REPL bridge
│   ├── scheduler.ts         — Audio scheduling (~10Hz ticks)
│   ├── audio-manager.ts     — AudioContext + AudioWorklet setup
│   ├── worklet.ts           — AudioWorkletProcessor (calls Rust DSP)
│   └── pkg/                 — Pre-built strudel-audio-wasm package
│
├── src-tauri/ (Rust backend — AI + corpus only)
│   ├── src/commands.rs      — Tauri IPC commands
│   ├── src/agent_loop.rs    — Claude API tool-use loop
│   └── src/state.rs         — AppState (corpus, agent client, session)
│
├── crates/
│   ├── robostrudel-core/    — Shared types, config, traits, session
│   ├── robostrudel-agent/   — Claude API client (reqwest + SSE streaming)
│   └── robostrudel-corpus/  — In-memory corpus index + search
```

## How AI → Audio works

1. User types in AI chat panel
2. `ai-bridge.ts` calls Tauri command `send_message`
3. Rust agent loop calls Claude API with tools
4. Claude calls `play_pattern` tool → emits `__set_code_and_play` event
5. `ai-bridge.ts` receives event, calls `strudelApp.editor.setCode(code)`
6. Calls `strudelApp.evaluate(code)` → WASM parses + plays via AudioWorklet

The AI never directly controls audio. It just injects code into the editor.

## Build & Run

```bash
cargo tauri dev                       # run desktop app in dev mode
cd ui && npm run build:wasm           # rebuild WASM package (needs nightly)
```

## Key Dependencies

- **strudel-rs** at `../strudel-rs/` — WASM audio package + Cargo path deps for validation
- **strudel-corpus** at `../strudel-corpus/` — read directly from filesystem
- No cpal, no native audio — WASM handles everything

## AI Music Tooling (Grok / Claude environment)

When working in this repo with Grok (or Claude), the following are available for superior music/MIDI/Strudel understanding:

- **Project skills** (auto-loaded, highest priority):
  - `/strudel-dsl` — exact ground-truth DSL surface from `docs/STRUDEL_RS_SUPPORTED.md`, mini-notation, methods, validation rules, corpus conventions.
  - `/midi-strudel` — full details of the MIDI Lab conversion pipeline (`src-tauri/src/midi.rs`), ImportOptions, drum banks, channel filtering, auto-resolution.

- **MCP servers** (configured in `.grok/config.toml` — visible in TUI via `/mcps` or `Ctrl+L`):
  - `midi-theory` — remote MIDI generator + 7 music theory reference resources.
  - `music-theory` — lightweight fast scales/chords/progressions/key tools.
  - `strudel-live` — 27-tool Strudel live-coding MCP (music_theory, euclid/polyrhythm generators, audio analysis, MIDI I/O, genre templates). Requires the global npm package + Playwright Chromium (already installed in this dev env).

Use `search_tool` + `use_tool` for the MCPs, and reference the skills explicitly or let them auto-trigger. These dramatically improve pattern quality and theory accuracy vs. prompt-only knowledge.

See also: `.grok/skills/`, `.grok/config.toml`, `docs/STRUDEL_RS_SUPPORTED.md`, and the root PLAN.md.

## DSL surface

The set of mini-notation operators, functions, methods, and effects that
strudel-rs actually accepts is documented in `docs/STRUDEL_RS_SUPPORTED.md`.
Web-strudel docs diverge — use that file as the ground truth when generating
or validating corpus examples.

## Curated corpus

Hand-written `.strudel` examples live in `corpus/{rhythm,melody,harmony,form,
timbre,motion}/`. Every file is gated by `cargo run -p corpus-check`, which
runs the same `validate_code` pipeline the agent uses and additionally
asserts each pattern emits at least one event in cycle 0. Curated entries
load ahead of the bulk corpus in `InMemoryCorpusIndex`, so `search_corpus`
surfaces them first.
