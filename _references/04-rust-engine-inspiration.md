# Rust-native live-coding engines — inspiration

Cycletron is Rust-first (Tauri v2, no Node/Python). Two Rust live-coding engines in the
list are worth studying for architecture and generative ideas.

## Mégra.rs — Markov-chain sequencing in pure Rust

Source: github.com/the-drunk-coder/megra.rs (dev moved to
codeberg.org/parkellipsen/megra.rs).

**What it is:** a standalone, pure-Rust live-coding DSL (LISP-flavored) with an integrated
editor and synthesis. Its tagline is literally *"make music with Markov chains."*

**Architecture / paradigm:**
- Follows a **sequencing paradigm**, not modular-synth signal-flow — temporal pattern
  generation drives everything.
- **Probabilistic graph structures** (Markov chains) are the core sequencing logic: sound
  events are nodes; transition probabilities pick what plays next.
- **Event-driven**: sound events are triggered probabilistically by the graph.
- **Sample-based**, samples loaded up front (memory-efficient playback).
- Deliberately **not Turing-complete** and **without heavy music-theory abstractions**
  (no built-in scales/chords/tunings) — scope is kept tight on purpose.

**Why it matters for Cycletron:**
- Validates a **generative, probabilistic** direction for the agent: instead of emitting a
  fixed pattern, the agent could emit (or evolve) a small transition graph that *keeps
  producing* idiomatic variation. Pairs naturally with `total-serialism`'s `MarkovChain` /
  isobar's `PMarkov` (doc 03).
- Concept: **learn a Markov model from the corpus** (per category) and let the agent sample
  from it for grounded-but-novel material — a concrete "self-improving corpus" mechanism
  matching the project vision.
- Its tight-scope philosophy mirrors `STRUDEL_RS_SUPPORTED.md`: a small, well-defined
  surface beats a sprawling one.

## Glicol — graph-oriented audio in Rust + WASM

Source: glicol.org , github.com/chaosprint/glicol

**What it is:** a graph-oriented audio language, written in Rust, compiled to **WASM** and
run in the browser via AudioWorklet — architecturally *very* close to Cycletron's
WASM-REPL + AudioWorklet stack (per CLAUDE.md).

**Why it matters:**
- Reference for **Rust→WASM→AudioWorklet** DSP packaging and SharedArrayBuffer/worklet
  plumbing — directly comparable to `ui/worklet.ts` + `pkg/` and `npm run build:wasm`.
- Its syntax (`~chain: node >> node >> node`) is a clean model for **node-chain notation**,
  should Cycletron ever want a synth-graph layer beneath strudel patterns (cf. Mercury's
  left-to-right `fx()` chains, doc 03).
- Good comparison point for WASM build ergonomics (nightly toolchain, wasm-bindgen, audio
  buffer marshaling).

## Honorable mention — Sardine (Python, not Rust)

Not Rust, but its **patterning system** ("players" + a senders/swimming-functions scheduling
model) is a clean design for *temporal recursion* and is worth reading for scheduler ideas
(`ui/scheduler.ts` runs ~10 Hz ticks). github.com/Bubobubobubobubo/Sardine

## Takeaways

1. **Markov / probabilistic generation** is a proven, lightweight path to "AI that keeps
   making variations" — and the Rust building blocks are tiny. Strong fit for the
   self-improving-corpus vision.
2. **Glicol** is the closest architectural sibling for the WASM-audio side; mine it if the
   WASM build or worklet plumbing needs reference.
3. Keep the DSL **tight and well-scoped** — both Mégra and the existing
   `STRUDEL_RS_SUPPORTED.md` contract endorse this.
