# Recommendations for Cycletron — prioritized

Synthesized from docs 01–04. Ordered by leverage-to-effort. Each item notes the touchpoint in
the existing codebase so it stays grounded.

## P0 — High leverage, low risk

### 1. Pure-Rust pattern-generation primitives as corpus generators + agent tools
The biggest single win. Port the *pure-function* algorithmic-composition primitives (they're
small) into a Rust generation module and (a) expose select ones to the agent loop as tools,
(b) run them offline to grow the curated corpus per category.
- **Pull from:** total-serialism + isobar (doc 03).
- **First batch (one per category):** `euclid`/`hexBeat` (rhythm), Per Nørgård `infinity`
  series (melody), `chordsFromNumerals` (harmony), `palindrome`/`interleave` (form), `Scala`
  microtonal (timbre), `brown` walk + cellular `Automaton` (motion).
- **Output contract:** each emits a value array → lower to `note("…")` / mini-notation, then
  gate through the existing `validate_code` + cycle-0-emits-event check (`corpus-check`).
- **Touchpoints:** new gen module in `crates/`; `src-tauri/src/agent_loop.rs` (tools);
  `corpus/<category>/`.

### 2. Method-level corpus tagging for `search_corpus`
Tag each curated `.strudel` by *technique* (euclidean, markov, serial-transform,
numeral-progression, microtonal, cellular…), not just category, so the agent can retrieve by
method. Sharpens few-shot grounding cheaply.
- **Touchpoints:** `crates/cycletron-corpus/` (index/search), corpus file frontmatter.

### 3. Align `s("…")` vocabulary with Dirt-Samples names
Make the agent speak the names users expect (`bd sd hh cp arpy jvbass …`). Audit current
synth/sample registry against Dirt-Samples; consider bundling **Clean-Samples** (clearly
licensed) for redistributable assets.
- **Pull from:** doc 02. **Touchpoints:** `docs/STRUDEL_RS_SUPPORTED.md` §5–6, sample assets.

## P1 — Medium effort, strong payoff

### 4. Markov / probabilistic generation learned from the corpus
Concrete mechanism for the "self-improving corpus" vision: build per-category Markov models
from curated patterns; let the agent sample grounded-but-novel material.
- **Pull from:** Mégra.rs, total-serialism `MarkovChain`/`DeepMarkov`, isobar `PMarkov` (docs 03–04).
- **Touchpoints:** generation module; validated through `corpus-check` before any output is kept.

### 5. Structured intermediate representation for AI output (Jaffle-style)
Have the agent emit a structured (YAML/JSON) pattern spec, then *lower* it to mini-notation in
Rust. Reduces parser-rejection rate (cf. `STRUDEL_RS_SUPPORTED.md` §8 gotchas) and makes
validation/repair deterministic.
- **Pull from:** Jaffle (doc 02). **Touchpoints:** `agent_loop.rs`, `play_pattern` tool, validation.

### 6. DSL parity audit vs. Strudel / Vortex
Diff `STRUDEL_RS_SUPPORTED.md` against upstream Strudel and the Vortex (Python) reimplementation;
turn the gaps into either roadmap items or explicit corpus constraints so the agent never
generates unsupported functions.
- **Pull from:** doc 02. **Touchpoints:** `docs/STRUDEL_RS_SUPPORTED.md` §9.

## P2 — Worth tracking, larger scope

### 7. "Mercury legibility" prior in the system prompt + corpus curation
Bake "semantic clarity over symbolic density, keep it short/readable" into the agent's system
prompt and corpus-acceptance criteria (Mercury's 30-line visible-performance ethos).
- **Pull from:** doc 03. **Touchpoints:** `prompts/`, corpus-curation guidelines.

### 8. Visualizer cross-pollination (Hydra / Punctual)
Cycletron already has visualizers (`ui/visualizer.ts`, fullscreen modes). Hydra and Punctual
are the reference audiovisual languages — mine for reactive-visual ideas and possibly a
pattern→visual binding.
- **Pull from:** doc 01. **Touchpoints:** `ui/visualizer.ts`.

### 9. Microtonal / alternate tunings via Scala (.scl)
`Scala` import (total-serialism) opens microtonal territory for `corpus/timbre` and `harmony`.
Niche but distinctive; depends on strudel-rs pitch handling.

### 10. (Long-horizon) collaborative sessions
If multiplayer ever matters, **Flok** (P2P editor) and **Extramuros/EspGrid** (clock/buffer
sync) are the reference designs. Not a near-term need.

## Suggested next concrete step
Prototype **#1** with a single primitive end-to-end — e.g. Per Nørgård's `infinity` series in
Rust → `note("…")` → `corpus-check` green → drop into `corpus/melody/`. It exercises the whole
pipeline (generate → lower → validate → corpus) and de-risks the rest of the batch.
