# PLAN.md — Historical planning notes (archived)

> **Status:** Archived. Product name is **Cycletron** (NaderLabs).  
> For current architecture and release gates, use `README.md` and
> `docs/RELEASE.md`.  
> Do **not** treat this file as the live system design.

**What changed since this was written**

- Audio is **WASM-only** (AudioWorklet + SharedArrayBuffer). There is no cpal /
  native audio path in the Tauri backend.
- Multi-provider LLM (Anthropic, xAI/Grok, OpenAI, local OpenAI-compatible),
  not a single Claude-only client.
- Internal crates may still be named `cycletron-*`; user-facing brand is Cycletron.

---

# Original: Cycletron — Planning Document

> AI-first strudel music engine with self-improving ecosystem

## Vision

Cycletron (working title at the time: *Cycletron*) is a live-coding music
creation environment built on top of [strudel-rs](../strudel-rs) (Rust pattern
engine) and [strudel-corpus](../strudel-corpus) (curated composition knowledge
base).

It provides a REPL where an AI agent collaborates with the musician in real time —
composing, extending, remixing, and iterating on strudel patterns — while
continuously improving its own musical knowledge and tooling.

### Core Principles

1. **Rust speed, AI brains.** Pattern evaluation, audio synthesis, and sample
   playback happen in Rust. The AI layer orchestrates composition, retrieval,
   and self-improvement — it never blocks the audio thread.

2. **Self-improving ecosystem.** Every session can feed back into the corpus:
   successful patterns get annotated, new idioms get extracted, gold-set
   references get refined. The system gets better at making music the more
   it is used.

3. **Desktop-native, chat-driven.** A Tauri v2 desktop app with a
   conversational interface. Describe intent ("make the bassline darker"),
   hear results instantly, see the code, drag in MIDI files, use global
   hotkeys — a real instrument, not a web toy.

4. **Strudel-native.** All musical output is valid strudel code. Nothing is
   a black box — every AI decision produces readable, editable patterns.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Cycletron Desktop App                        │
│                         (Tauri v2 shell)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Web UI (frontend)                        │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────────────┐ │  │
│  │  │ Chat / REPL │  │  Pattern   │  │  Waveform / Scope   │ │  │
│  │  │  (NL input) │  │  Editor    │  │  (live visualizer)  │ │  │
│  │  └─────────────┘  └────────────┘  └─────────────────────┘ │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌─────────────────────┐ │  │
│  │  │ Session     │  │  Corpus    │  │  Arrangement        │ │  │
│  │  │ History     │  │  Browser   │  │  Timeline           │ │  │
│  │  └─────────────┘  └────────────┘  └─────────────────────┘ │  │
│  │  + AudioWorklet + strudel-rs WASM (audio lives here)      │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                             │ Tauri IPC (commands + events)      │
│  ┌──────────────────────────▼─────────────────────────────────┐  │
│  │           Rust Backend (AI + corpus + files; no audio)      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │  │
│  │  │ AI Agent │  │ Pattern  │  │ Corpus   │                 │  │
│  │  │ (multi-  │  │ tools /  │  │ Indexer  │                 │  │
│  │  │ provider)│  │ validate │  │ (search) │                 │  │
│  │  └──────────┘  └──────────┘  └──────────┘                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

> **Note:** Early drafts put audio in Rust/cpal. **Current product:** all audio
> is WASM in the webview.

### Why Tauri v2

- **Rust backend** — AI, corpus, files, MIDI import; pattern validation via strudel-rs path deps
- **Lightweight** — no Electron/Chromium bundle, uses system webview
- **IPC** — typed Tauri commands bridge frontend UI to Rust backend
- **Desktop features** — native menus, file dialogs, system tray, notifications,
  drag-and-drop MIDI import, global hotkeys for transport controls
- **Cross-platform** — macOS, Linux, Windows from one codebase
- **Web reuse** — frontend can share components with a future web version

### Component Breakdown

#### 1. Strudel Engine (from strudel-rs)

The Rust foundation. We consume these crates as dependencies:

| Crate | We Use For |
|-------|-----------|
| `strudel-core` | Pattern types, combinators, query engine |
| `strudel-mini` | Mini-notation parsing and evaluation |
| `strudel-dsl` | Full DSL parsing (`note("c4").s("sine").fast(2)`) |
| `strudel-audio` | Native audio playback via cpal |
| `strudel-dsp` | Synthesis, effects, sample playback |
| `strudel-sounds` | Sample registry and loading |
| `strudel-music-theory` | Scales, chords, voicings |
| `midi-to-strudel` | MIDI import pipeline |

#### 2. Corpus Retriever

Indexes and queries the strudel-corpus for:
- **Few-shot examples** — ground the AI with real musical patterns
- **Part retrieval** — find basslines, drum grooves, harmonies by role
- **Gold-set references** — high-quality exemplars for prompt grounding
- **Task templates** — composition, remix, continuation scaffolds

Uses the existing inventory layer (`normalized-metadata.jsonl`,
`agent-part-excerpts.tsv`, `gold-set/records.jsonl`).

#### 3. AI Composer (Pure Rust)

The LLM-powered agent, implemented entirely in Rust:
- **HTTP client:** `reqwest` for Claude API calls (streaming via SSE)
- **Tool-use loop:** Rust structs for tool definitions, serde for
  JSON serialization of tool calls and results
- **Streaming:** Token-by-token display in the UI as the AI composes
- Interprets natural language musical intent
- Retrieves relevant corpus examples
- Generates valid strudel code
- Proposes variations, remixes, extensions

Runs as a tool-using agent with access to:
- Corpus search tools (Rust-native index queries)
- Pattern validation (via strudel-mini/dsl — direct Rust calls, no subprocess)
- Audio preview triggers (message to audio thread)
- Session history (in-memory, persisted to disk)

#### 4. Pattern Buffer

Live working state of the current composition:
- Current playing pattern(s)
- Edit history (undo/redo)
- Named sections (intro, verse, drop, etc.)
- Hot-swap on AI edits (seamless transitions)

#### 5. Self-Improvement Loop

After each session (or on explicit save):
- Successful patterns can be normalized and added to corpus
- New part annotations extracted automatically
- Metadata indexed for future retrieval
- Gold-set candidates flagged for review
- Agent feedback (what worked, what didn't) logged

---

## Key Flows

### Flow 1: Conversational Composition

```
User: "make me a deep house groove at 122 bpm"
  ↓
AI Composer:
  1. Retrieves corpus examples tagged [house, techno, 4-on-floor]
  2. Selects gold-set reference for groove quality
  3. Generates strudel pattern with kick, hats, clap, bassline
  4. Validates syntax via strudel-mini
  5. Sends to Pattern Buffer → audio plays
  ↓
User: "make the bassline more acid"
  ↓
AI Composer:
  1. Retrieves bassline examples with [acid, 303, resonance]
  2. Modifies bassline: adds cutoff sweep, accent pattern
  3. Hot-swaps in Pattern Buffer
  ↓
User: "save this as 'acid-groove-01'"
  ↓
Self-Improvement Loop:
  1. Saves pattern as .strudel file
  2. Extracts metadata (tempo, sounds, effects, tags)
  3. Splits parts (bassline, drums, etc.)
  4. Updates corpus indexes
```

### Flow 2: Remix / Variation

```
User: "take acid-groove-01 and make a breakbeat version"
  ↓
AI Composer:
  1. Loads saved pattern
  2. Retrieves breakbeat drum examples from corpus
  3. Preserves bassline and harmony
  4. Replaces drum pattern with breakbeat groove
  5. Adjusts tempo if needed
  6. Validates and plays
```

### Flow 3: MIDI Import → AI Arrangement

```
User: "import this midi file and arrange it"
  ↓
midi-to-strudel: converts MIDI → strudel patterns
  ↓
AI Composer:
  1. Analyzes converted patterns (parts, structure)
  2. Proposes arrangement (intro, sections, transitions)
  3. Adds effects, dynamics, variation
  4. Plays arranged version
```

---

## Self-Configuration System

Inspired by OpenClaw/IronClaw/ZeroClaw self-improvement patterns,
scoped to music-making.

### Architectural Inspirations

**OpenClaw** (Node.js) — three-file learning capture, promotion pipeline,
three-tier memory, scheduled learning-loop agent.

**IronClaw** (Rust, NEAR AI) — WASM-sandboxed tools, hybrid search,
dynamic tool building. We skip the WASM sandbox (all tools are first-party)
but borrow the hybrid search concept.

**ZeroClaw** (Rust, minimal) — trait-driven architecture, SQLite + vector
search, ~8.8MB binary. We borrow the trait-based extensibility pattern.

### Three-Tier Musical Memory

Adapted from OpenClaw's memory architecture:

| Tier | Scope | Content | Loading |
|------|-------|---------|---------|
| **T1: Always-loaded** | Every prompt | User style prefs, favorite sounds, tempos, go-to patterns | Embedded in system prompt |
| **T2: Session context** | Recent sessions | What we made recently, active project state | Auto-loaded for today/yesterday |
| **T3: Full corpus** | All history | 250+ compositions, parts, metadata | Retrieved on demand via search tools |

### Structured Learning Capture

After each session, the system logs outcomes to structured files:

```
learning/
├── corpus_learnings.jsonl    # which corpus entries produced good results
├── prompt_learnings.jsonl    # which prompt templates worked
├── pattern_errors.jsonl      # patterns that failed validation or were rejected
└── session_outcomes.jsonl    # overall session quality signals
```

### Promotion Pipeline

Adapted from OpenClaw's "corrections compound" pattern:

1. **Capture:** Every user reaction (accepted, rejected, modified) is logged
2. **Detect recurrence:** If a pattern/technique succeeds >= 3 times across
   >= 2 sessions, it becomes a candidate for promotion
3. **Promote:** Successful patterns → gold-set candidates.
   Successful prompt strategies → updated prompt templates.
   Recurring user preferences → T1 memory.
4. **Prune:** Entries that consistently produce rejections get demoted

This runs as a **post-session background task** (tokio spawn), not inline
with composition. Never blocks the creative flow.

### Trait-Driven Extension Points

Borrowed from ZeroClaw's modular architecture — define traits for the
parts that might evolve:

```rust
trait CorpusIndex: Send + Sync {
    fn search(&self, query: &CorpusQuery) -> Vec<CorpusEntry>;
    fn ingest(&mut self, entry: NewEntry) -> Result<()>;
}

trait MemoryStore: Send + Sync {
    fn recall(&self, tier: MemoryTier, context: &str) -> Vec<Memory>;
    fn record(&mut self, memory: Memory) -> Result<()>;
}

trait LearningCapture: Send + Sync {
    fn log_outcome(&mut self, session_id: &str, outcome: &Outcome);
    fn detect_promotions(&self) -> Vec<Promotion>;
}
```

Start with simple in-memory / filesystem implementations. The trait
boundaries let us swap in SQLite, embeddings, or more sophisticated
retrieval later without touching the agent loop.

### What Improves

| Layer | How It Improves |
|-------|----------------|
| **Corpus** | New patterns added, annotated, indexed after successful sessions |
| **Gold Set** | Recurrence-based promotion (>= 3 successes, >= 2 sessions) |
| **Part Library** | Extracted basslines, grooves, harmonies grow the reusable parts inventory |
| **Prompt Templates** | Refined based on prompt_learnings.jsonl outcomes |
| **Tag Vocabulary** | Musical tags and categories expand organically |
| **T1 Memory** | User preferences promoted from session patterns |

### What Stays Fixed

- Strudel syntax and semantics (defined by strudel-rs)
- Audio engine behavior (defined by strudel-rs DSP)
- Core safety: no destructive corpus operations without confirmation
- Pattern validation rules
- Trait interfaces (stable API, swappable implementations)

### Self-Configuration Workflow

```
Session ends (or user triggers /save)
  ↓
1. Extract successful patterns from session
2. Run metadata extraction (tempo, sounds, effects, tags, complexity)
3. Run part extraction (bassline, harmony, drums, melody, texture)
4. Check for duplicates against existing corpus
5. If novel: add to normalized/ with provenance
6. Update inventory indexes
7. Log session outcome to learning/ files
  ↓
Background task (tokio::spawn):
8. Scan learning logs for recurrence patterns
9. Generate promotion candidates
10. Auto-promote recurring preferences to T1 memory
11. Flag gold-set candidates for user review
12. Update prompt templates if pattern detected
```

---

## Implementation Phases

### Phase 1: Foundation — Desktop Shell + Audio

**Goal:** Tauri app that plays strudel patterns with a chat interface.

- [ ] Tauri v2 project scaffolding with Cargo workspace
- [ ] Path deps to strudel-rs crates, verify builds
- [ ] Rust backend: audio engine wrapper (start/stop/set pattern)
- [ ] Rust backend: Claude API client (reqwest, streaming SSE)
- [ ] Rust backend: basic agent loop (user message → AI → pattern → play)
- [ ] Frontend: chat panel (messages in, streaming AI response)
- [ ] Frontend: pattern display (current strudel code, read-only)
- [ ] Frontend: transport controls (play/stop/tempo)
- [ ] Pattern validation before playback (strudel-mini/dsl)
- [ ] Config: API key, corpus path, sample path

### Phase 2: Corpus + Intelligent Composition

**Goal:** AI grounded in real musical examples, multi-part output.

- [ ] Rust corpus indexer: load JSONL/TSV into in-memory structs
- [ ] Corpus search tools for the agent (by tag, role, tempo, complexity)
- [ ] Gold-set few-shot injection in AI prompts
- [ ] Frontend: corpus browser panel (search, preview)
- [ ] Multi-part composition (named layers via stack)
- [ ] Frontend: pattern editor (CodeMirror with strudel highlighting)
- [ ] Hot-swap pattern editing (seamless transition on AI edits)
- [ ] Section management (intro, verse, drop — named + arrangeable)

### Phase 3: Desktop Features + Self-Improvement

**Goal:** Full desktop experience, system improves with use.

- [ ] File drag-and-drop (MIDI import, sample loading)
- [ ] Native file dialogs (open/save .strudel, export audio)
- [ ] Global hotkeys (play/stop even when app is unfocused)
- [ ] System tray with playback indicator
- [ ] Session save → corpus ingestion (Rust-native metadata extraction)
- [ ] Part extraction in Rust (replaces Node.js script)
- [ ] Duplicate detection via content hashing
- [ ] Undo/redo for pattern edits
- [ ] Session persistence (save/restore working state)

### Phase 4: Advanced — Performance + Visualization

**Goal:** Live performance, rich visualization, export.

- [ ] MIDI import → AI arrangement pipeline
- [ ] Live performance mode (cue sections, crossfade transitions)
- [ ] Waveform visualizer (canvas, driven by audio engine data)
- [ ] Pattern grid / piano roll visualizer
- [ ] Audio export (WAV/FLAC stems, mixdown)
- [ ] Auto-update via Tauri updater
- [ ] Multi-window support (detachable visualizer)

---

## Technical Decisions

### Language & Runtime — All Rust

- **Everything in Rust.** No Node, no Python, no subprocess orchestration.
- **Desktop app:** Tauri v2 — Rust backend with web frontend in system webview
- **AI agent:** Pure Rust using `reqwest` for Claude API HTTP calls
- **Corpus indexing:** Rust-native reimplementation of the Node.js scripts
  (metadata extraction, part splitting, dedup) — runs faster, no runtime deps
- **Serialization:** `serde` + `serde_json` for all data interchange
- **Async runtime:** `tokio` for AI API calls and file I/O; audio stays synchronous

### AI Integration — No Framework, Just Rust

**Decision: Roll our own agent with reqwest + serde.** No rig, no genai, no framework.

**Why not rig?** It's the most mature Rust AI framework (~6,900 stars, built-in
Anthropic provider), but we don't need its abstractions:
- We only target Claude (no multi-provider value)
- Our corpus is ~250 docs with structured metadata — embedding search is overkill
- Our tools are direct Rust function calls to strudel-rs (no indirection needed)
- Rolling our own is ~550 lines for the Claude client + agent loop
- Avoids pulling in schemars, opentelemetry, and provider abstractions we don't use

**What we steal from rig:** Study their SSE streaming implementation and
schemars-based tool definitions for reference patterns. No import needed.

**Corpus search is structured, not semantic.** 250 entries with JSONL metadata
(tags, tempo, role, complexity) load into a `Vec<CorpusEntry>` at startup.
The agent translates NL intent into structured filter queries — that's what
it's good at. Linear scan over 250 items is microseconds in Rust.
Embeddings add complexity for no measurable gain at this scale.

- Claude API via `reqwest` with streaming SSE parsing (`eventsource-stream`)
- Tool-use pattern: Rust structs define tools, serde handles JSON round-trip
- Tools available to the agent:
  - `search_corpus` — query metadata index by tags, role, tempo, complexity
  - `get_example` — retrieve full source of a corpus entry
  - `validate_pattern` — parse strudel code, return errors or AST
  - `play_pattern` — send pattern to audio engine for immediate playback
  - `stop` — halt playback
  - `set_tempo` — change BPM
  - `save_session` — persist current state to corpus
  - `list_parts` — show current named sections/layers
  - `import_midi` — convert MIDI file to strudel via midi-to-strudel

### Desktop App Features (Tauri v2)

| Feature | Implementation |
|---------|---------------|
| **Native audio** | cpal via Rust backend (not WebAudio) |
| **File drag-and-drop** | Tauri drag-drop events → MIDI import, sample loading |
| **Global hotkeys** | Play/stop/tempo via system shortcuts even when unfocused |
| **Native menus** | File (open/save/export), Edit (undo/redo), View (panels) |
| **System tray** | Background playback indicator, quick stop |
| **File dialogs** | Native open/save for .strudel files, MIDI, audio export |
| **Notifications** | Corpus ingestion complete, export done |
| **Auto-update** | Tauri updater for distributing new versions |
| **Multi-window** | Optional: detach visualizer or pattern editor |
| **Theming** | Dark/light mode following system preference |

### Frontend UI Stack

- **Framework:** Solid.js or vanilla TS (lightweight, fast — no React bloat)
- **Styling:** Tailwind CSS
- **Code editor:** CodeMirror 6 with custom strudel syntax highlighting
- **Visualizations:** Canvas API or WebGL for waveform/pattern viz
- **Communication:** Tauri `invoke()` commands + `listen()` events

### Corpus Integration — Rust-Native

- Configurable corpus path (defaults to `../strudel-corpus/`)
- Rust-native index loading: parse JSONL/TSV at startup into in-memory structs
- Rust-native metadata extraction (replaces `extract-metadata.mjs`)
- Rust-native part extraction (replaces `build-agent-parts.mjs`)
- Rust-native dedup via content hashing (replaces `normalize-corpus.mjs`)
- Write-back: new patterns saved directly to corpus filesystem
- Hot-reload: watch corpus directory for external changes

### Audio Pipeline

- strudel-rs `strudel-audio` crate for native playback via cpal
- Pattern evaluation on dedicated thread
- Audio rendering on cpal callback thread
- AI composition on async tokio tasks (never blocks audio)
- Tauri events push waveform/meter data to frontend for visualization

### strudel-rs Integration

- **Cargo path dependencies** to `../strudel-rs/crates/*`
- Direct Rust API calls — no CLI subprocess overhead
- Pattern validation is a function call, not a process spawn
- Audio engine shared in-process via `Arc<Mutex<Player>>` or channel-based

---

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Agent runtime | Pure Rust (reqwest + serde) | No runtime deps, single binary, direct API access to strudel crates |
| UI | Tauri v2 desktop app | Native feel, Rust backend, lightweight, cross-platform |
| Corpus location | Configurable path, default `../strudel-corpus/` | Stays the source of truth, cycletron reads/writes directly |
| strudel-rs integration | Cargo path deps | Direct Rust calls, no FFI overhead, easy co-development |
| Corpus tooling | Rewrite in Rust | Eliminate Node.js dependency, faster, integrated |
| Frontend framework | Solid.js or vanilla TS | Minimal overhead, fast reactivity |

## Open Questions

1. **Solid.js vs vanilla TS for frontend?** Solid is reactive and tiny (7KB),
   but vanilla TS with Tauri events might be even simpler for a REPL-focused UI.

2. **Latency budget:** Target < 3s for AI responses (streaming helps perception).
   Pattern validation and corpus search must be < 100ms.

3. **Self-improvement guardrails:** Auto-index silently, but require confirmation
   for gold-set promotion and corpus additions? Or full auto?

4. **Audio export format:** WAV/FLAC for stems, MP3/OGG for sharing?
   Or let user choose?

5. **Visualizer scope:** Start with simple waveform + pattern grid,
   or invest early in a rich visualizer (piano roll, spectrogram)?

---

## File Structure (Proposed)

```
cycletron/
├── Cargo.toml                  # workspace root
├── PLAN.md                     # this document
├── tauri.conf.json             # Tauri v2 configuration
│
├── crates/
│   ├── cycletron-core/       # pattern buffer, session state, config, types
│   ├── cycletron-agent/      # Claude API client, tool-use loop, streaming
│   ├── cycletron-corpus/     # corpus indexing, search, ingestion, metadata extraction
│   ├── cycletron-audio/      # audio engine wrapper around strudel-audio/dsp
│   └── cycletron-app/        # Tauri commands, IPC bridge, app state
│
├── src-tauri/
│   ├── src/
│   │   └── main.rs             # Tauri entry point, registers commands
│   ├── Cargo.toml              # Tauri app crate (depends on cycletron-*)
│   ├── tauri.conf.json         # Tauri window/menu/permission config
│   └── icons/                  # app icons
│
├── ui/                         # frontend (Tauri webview content)
│   ├── index.html
│   ├── src/
│   │   ├── app.ts              # main entry
│   │   ├── chat/               # chat panel components
│   │   ├── editor/             # pattern editor (CodeMirror)
│   │   ├── transport/          # play/stop/tempo controls
│   │   ├── corpus/             # corpus browser
│   │   ├── visualizer/         # waveform, pattern grid
│   │   └── lib/                # Tauri IPC wrappers, shared types
│   ├── styles/
│   └── package.json            # frontend deps (solid-js, tailwind, codemirror)
│
├── prompts/                    # system prompts and few-shot templates
├── config/                     # default config (toml)
├── learning/                   # runtime: session outcomes, promotion logs
└── tests/                      # integration tests
```

### Crate Responsibilities

| Crate | Purpose | Key Dependencies |
|-------|---------|-----------------|
| `cycletron-core` | Shared types, config, pattern buffer, session state | `serde`, `toml` |
| `cycletron-agent` | Claude API client, tool definitions, agent loop | `reqwest`, `serde_json`, `tokio`, `cycletron-core` |
| `cycletron-corpus` | Load/search/write corpus, metadata extraction | `serde`, `cycletron-core` |
| `cycletron-audio` | Thin wrapper: init audio, play/stop, tempo, waveform data | `strudel-audio`, `strudel-dsp`, `strudel-mini`, `strudel-dsl` |
| `cycletron-app` | Tauri command handlers, glues everything together | `tauri`, all cycletron-* crates |

---

## Dependencies on Sibling Projects

| Project | Relationship | Integration |
|---------|-------------|-------------|
| `strudel-rs` | Rust engine | Cargo path deps to `../strudel-rs/crates/*` |
| `strudel-corpus` | Knowledge base | Filesystem read/write at `../strudel-corpus/` |

Both are local-first. No need for remote packages initially.
