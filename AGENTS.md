# Cycletron

AI-native live coding for music — Tauri v2 desktop app.

**Product name:** Cycletron (NaderLabs). **Engine:** strudel-rs.  
Internal crates: `cycletron-{core,agent,corpus,gen,analysis}` + `cycletron-app`.

## Architecture

The frontend is the strudel-rs WASM REPL (lifted from `../strudel-rs/www/wasm-repl/`),
with an AI chat panel alongside. Audio runs entirely in WASM via AudioWorklet +
SharedArrayBuffer — the Tauri Rust backend never touches audio.

```
Tauri Desktop Shell
├── ui/ (frontend = WASM REPL + AI chat panel)
│   ├── src/app.ts           — StrudelApp (WASM REPL core, from strudel-rs)
│   ├── src/editor.ts        — CodeMirror editor with strudel highlighting
│   ├── src/visualizer.ts    — Cycle/piano/waveform visualization
│   ├── src/ai-bridge.ts     — Tauri ↔ WASM REPL bridge
│   ├── scheduler.ts         — Audio scheduling (~10Hz ticks)
│   ├── audio-manager.ts     — AudioContext + AudioWorklet setup
│   ├── worklet.ts           — AudioWorkletProcessor (calls Rust DSP)
│   └── pkg/                 — Pre-built strudel-audio-wasm package
│
├── src-tauri/ (Rust backend — AI + corpus + files; no audio)
│   ├── src/commands.rs      — Tauri IPC commands
│   ├── src/agent_loop.rs    — Multi-provider LLM tool-use loop
│   └── src/state.rs         — AppState (corpus, agent client, session)
│
├── crates/
│   ├── cycletron-core/     — Shared types, config, traits, session
│   ├── cycletron-agent/    — LLM clients (Anthropic / OpenAI-compatible / local)
│   ├── cycletron-corpus/   — In-memory corpus index + search + recipes
│   ├── cycletron-gen/      — Genre generators + genre map
│   └── cycletron-analysis/ — Pattern validate / critique / digest
```

## How AI → Audio works

1. User types in AI chat panel
2. `ai-bridge.ts` calls Tauri command `send_message`
3. Rust agent loop calls the configured LLM provider with tools
4. Model calls `play_pattern` → emits `__set_code_and_play` event
5. `ai-bridge.ts` receives event, calls `strudelApp.editor.setCode(code)`
6. Calls `strudelApp.evaluate(code)` → WASM parses + plays via AudioWorklet

The AI never directly controls audio. It injects code into the editor.

Providers: Claude (Anthropic), Grok (xAI), OpenAI, and local OpenAI-compatible
endpoints (Ollama, LM Studio). Keys live in the OS keychain (service `cycletron`).

## Build & Run

```bash
cargo tauri dev                       # run desktop app in dev mode
cd ui && npm run build:wasm           # rebuild WASM package (needs nightly)
```

## Key Dependencies

- **strudel-rs** at `../strudel-rs/` — WASM audio package + Cargo path deps for validation
- **strudel-corpus** at `../strudel-corpus/` — bulk corpus on disk (optional sibling)
- No cpal, no native audio — WASM handles everything

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

## AI Music Tooling (Grok / Claude environment)

When working in this repo with Grok (or Claude), the following are available for superior music/MIDI/Strudel understanding:

- **Project skills** (auto-loaded, highest priority):
  - `/strudel-dsl` — exact ground-truth DSL surface from `docs/STRUDEL_RS_SUPPORTED.md`
  - `/midi-strudel` — MIDI Lab conversion pipeline (`src-tauri/src/midi.rs`)

- **MCP servers** (configured in `.grok/config.toml`):
  - `midi-theory`, `music-theory`, `strudel-live`

See also: `.grok/skills/`, `.grok/config.toml`, `docs/STRUDEL_RS_SUPPORTED.md`,
`docs/PUBLISH_READINESS.md`. Historical vision notes: `PLAN.md` (archived).
