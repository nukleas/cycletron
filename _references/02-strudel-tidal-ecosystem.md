# Strudel / Tidal ecosystem — what's directly mineable

Robostrudel's frontend *is* a Strudel-rs REPL, so the Tidal/Strudel sub-ecosystem is the
most directly relevant slice of awesome-livecoding. Sources: awesome-tidalcycles, the main
list, and the Strudel project.

## Tidal "ports" / cousins — cross-reference DSL coverage

Robostrudel already tracks DSL surface in `docs/STRUDEL_RS_SUPPORTED.md`. These ports are
worth diffing against for function-coverage ideas and notation alternatives:

| Project | Lang | Why look |
|---------|------|----------|
| **Strudel** (strudel.cc) | JS | Upstream of strudel-rs. Canonical function set; `docs/STRUDEL_RS_SUPPORTED.md` §9 "known gaps" is exactly the diff against this. |
| **Vortex** | Python | github.com/tidalcycles/vortex — clean reimplementation of Tidal's pattern engine; readable reference for combinator semantics. |
| **Estuary** | Web/Haskell | Hosts a "mini Tidal" + collaborative editing. Reference for a reduced, safe DSL subset (relevant to agent validation). |
| **Tranquility** | Lua | github.com/XiNNiW/tranquility — small surface, easy to read. |
| **Jaffle** | YAML→Strudel | roipoussiere.frama.io/jaffle — a *structured* (YAML) representation of Strudel patterns. **Interesting for the agent**: a structured intermediate the LLM emits, then lowers to mini-notation, could cut syntax errors. |

## Editors / front-end UX ideas

- **Strudel Flow** (xyflow.com/strudel-flow) — node-graph UI over Strudel. Idea for a visual
  pattern builder alongside the text editor.
- **strudel.nvim** (github.com/gruvw/strudel.nvim) — controls Strudel from Neovim. Confirms
  the "editor drives a headless Strudel engine" pattern Robostrudel already uses.
- **Topos** (topos.live) — Teletype-inspired, very terse cellular sequencing. Good source of
  compact-notation ideas.
- **Flok** (munshkr.github.io/flok) — P2P collaborative editing. If multiplayer/shared
  sessions ever matter, this is the reference implementation (CRDT-style buffer sync).

## Sample packs & sound sources — ground the agent's `s("…")`

`docs/STRUDEL_RS_SUPPORTED.md` §5–6 cover the synth registry + samples. These are the
canonical sample corpora the wider community references — useful for naming conventions,
drum-bank aliases, and (where licensing allows) actual sample assets:

- **Dirt-Samples** — github.com/tidalcycles/Dirt-Samples — the default SuperDirt set; the
  source of the well-known names (`bd`, `sd`, `hh`, `cp`, `arpy`, `jvbass`…). Match the
  agent's vocabulary to these.
- **Clean-Samples** — github.com/tidalcycles/Clean-Samples — community-curated, **clearly
  licensed** — the safe set to bundle/redistribute.
- **Tidal Drum Machines** — github.com/geikha/tidal-drum-machines — large, organized by
  classic machine (909, 808, etc.). Maps well to a MIDI-Lab drum-bank concept.
- **Shabda** — shabda.ndre.gr — assemble/share sample packs (incl. freesound search). Tool
  for sourcing new timbres for `corpus/timbre`.
- **Tidal Sound Explorer** — github.com/ShaiRosenblit/tidal-sound-explorer — analyzes a
  sample library and lays it out on a 2D similarity plane. Idea for timbre browsing/search.

## Learning / reference for prompt & corpus quality

- **awesome-tidalcycles** (github.com/tidalcycles/awesome-tidalcycles) — keep as a living
  bookmark; tutorials + extension list.
- **Tidal Club forum** (club.tidalcycles.org) — Q&A patterns; good for harvesting idiomatic
  examples for the corpus.
- **Live Coding: A User's Manual** (livecodingbook.toplap.org) — open-access MIT Press book;
  conceptual grounding for system prompts and docs.

## Concrete pulls for Robostrudel

1. Diff `STRUDEL_RS_SUPPORTED.md` function list against Strudel + Vortex; log gaps as corpus
   constraints or roadmap items.
2. Align the `s("…")` synth/sample vocabulary with **Dirt-Samples** names so AI output uses
   names users expect; consider bundling **Clean-Samples** (licensing-safe).
3. Evaluate a **Jaffle-style structured intermediate** the agent emits before lowering to
   mini-notation — could reduce parser-rejection rate (see §8 gotchas in the DSL doc).
4. **tidal-drum-machines** → drum-bank naming for the MIDI Lab pipeline (`/midi-strudel`).
