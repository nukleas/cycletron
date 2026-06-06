# _references — external research for improving Robostrudel

Notes mined from the live-coding ecosystem, kept here so the corpus/DSL/agent work
has a grounded source of ideas to pull from. Primary seed:
[toplap/awesome-livecoding](https://github.com/toplap/awesome-livecoding).

Captured 2026-06-05.

## Documents

| File | What's in it |
|------|--------------|
| [01-awesome-livecoding-catalog.md](01-awesome-livecoding-catalog.md) | Full extracted catalog of the awesome-livecoding list (languages, libs, community, learning, events). Archive snapshot. |
| [02-strudel-tidal-ecosystem.md](02-strudel-tidal-ecosystem.md) | Strudel/Tidal-specific resources most directly mineable: ports, sample packs, tooling, learning, corpus sources. |
| [03-pattern-generation-primitives.md](03-pattern-generation-primitives.md) | Algorithmic-composition function inventories (total-serialism, isobar, Mercury) mapped to Robostrudel's corpus categories + DSL gaps. |
| [04-rust-engine-inspiration.md](04-rust-engine-inspiration.md) | Notes on the Rust-native engines (Glicol, Mégra.rs) and probabilistic/Markov sequencing ideas. |
| [05-recommendations.md](05-recommendations.md) | Actionable, prioritized opportunities for Robostrudel pulled from all of the above. |
| [06-sounds-and-samples.md](06-sounds-and-samples.md) | How Strudel handles instruments/samples vs. robostrudel today; desktop-power opportunities (soundfonts, bundled libs, user folders, native decode). |

## TL;DR — highest-value takeaways

1. **Pattern-generation primitives are the biggest win.** `total-serialism` and `isobar`
   are ready-made inventories of ~60 algorithmic-composition functions (euclid, markov,
   L-systems, Per Nørgård's infinity series, hexBeat, Collatz, cellular automata, weighted
   choice, brownian walk…). Many map directly onto Robostrudel's 6 corpus categories and
   would make excellent AI tools / corpus generators / DSL methods. See doc 03.
2. **Sample packs + corpus sources** for grounding the agent: Dirt-Samples, Clean-Samples
   (clearly licensed), tidal-drum-machines, Shabda. See doc 02.
3. **Mercury's design philosophy** (audience-legible, semantic clarity over symbolic
   density, 30-line limit) is a north star for keeping the DSL/AI output readable. Doc 03.
4. **Mégra.rs** proves Markov-chain sequencing works well as a Rust live-coding paradigm —
   a generative direction for the agent beyond fixed patterns. Doc 04.
5. **Strudel-adjacent tooling** (Strudel Flow node UI, strudel.nvim, Jaffle YAML, Topos)
   shows alternative front-ends and pattern representations worth studying. Doc 02.
