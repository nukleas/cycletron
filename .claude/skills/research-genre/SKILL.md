---
name: research-genre
description: Research a musical genre and produce a validated strudel-rs genre recipe (corpus/genres/<genre>.md). Fans out across sources (web, music theory, existing strudel/livecoding corpora, user-provided MIDI datasets), works through a fixed research agenda, translates every finding into strudel-rs fragments, and gates them through corpus-check so nothing unprovable ships. Use when the user asks to research/add/expand a genre recipe, or says "research <genre>", "add a recipe for <genre>", "what does <genre> sound like in strudel".
---

# Research a genre → a validated strudel-rs recipe

You produce **genre recipes**: markdown knowledge files under `corpus/genres/`
that teach how to make a style *in strudel-rs terms*. This skill turns research
into a recipe that is trustworthy because every code fragment is proven on the
real engine.

## The one rule that makes this trustworthy

**Every ```strudel fragment must pass `corpus-check`.** Web knowledge is
*web-strudel* and general music theory — both diverge from this engine's actual
surface. A finding only becomes part of a recipe once it has been translated
into a complete, playable strudel-rs fragment and validated. No exceptions, no
"probably works". The gate is the difference between a recipe and folklore.

Ground all code in `docs/STRUDEL_RS_SUPPORTED.md` (use the `strudel-dsl` skill).
Run the gate on a single draft with:

```
cargo run -p corpus-check corpus/genres/_drafts/<genre>.md
```

## The research agenda (the things to figure out)

For every genre, answer these. Each answer that implies sound becomes ≥1
validated fragment; the rest becomes frontmatter or prose.

1. **Tempo & feel** — BPM range; straight vs. swung vs. shuffle; half-time feel?
   → frontmatter `bpm`, `swing`.
2. **Rhythm / drums** — the kit, the kick/snare/hat patterns, euclids, the
   signature break. → "Drum core" fragment.
3. **Bass** — sound design (synth, filter movement), register, and its rhythmic
   relationship to the kick. → "Bass" fragment.
4. **Harmony** — scales/modes, chord types & voicings, typical progressions, how
   static vs. active. → frontmatter `scales`; a "Chords/pad" fragment.
5. **Lead / melody** — arps, motifs, range, ornamentation, call-and-response.
   → a "Lead/arp" fragment.
6. **Timbre / sound design** — the defining synths/samples and the signature
   effect chain (the genre's DNA — e.g. acid's `lpf(sine.range()).resonance()`).
   → frontmatter `key_sounds`; baked into the fragments.
7. **Arrangement / form** — section structure, builds/drops, how energy is
   managed, typical length. → prose + a "Full skeleton" fragment.
8. **References** — canonical artists/tracks that define the sound. → frontmatter
   `artists`; cite track-level sources.
9. **Translation notes** — which strudel-rs idioms express each of the above, and
   any gotchas. → prose where useful.

## The source playbook (pluggable)

Use as many as apply; cross-check facts across at least two. Record every URL in
frontmatter `sources:`.

- **Web** — `WebSearch` / the Exa MCP (`web_search_exa`, `web_fetch_exa`):
  "characteristics of <genre>", "how to produce <genre>", BPM/key databases,
  production breakdowns. For depth, compose with the `deep-research` skill.
- **Music theory** — scales, modes, progressions. Verify scale names resolve in
  strudel-rs (`scale("...")` in the supported list) before relying on them.
- **Existing strudel corpora** — grep what's already proven:
  `rg -i "<genre|tag>" corpus/ ../strudel-corpus/ ../strudel-rs/` — lift and
  adapt fragments that already validate. The local `corpus/genres/*.md` recipes
  show the target shape.
- **The ingested idiom store** (real songs → strudel) — query the 17k+ snippets
  mined from MIDI with `strudel-search`. Find tracks by reference artist, tempo,
  or sound, then open the converted `.strudel` to see how a real arrangement
  voices chords / lays out a groove:
  `cargo run -q -p strudel-search -- --artist "Daft Punk" --bpm-min 120 --bpm-max 130`
  `cargo run -q -p strudel-search -- --bpm-min 170 --sound supersaw --limit 10`
  Treat these as *reference*, not copy-paste: the conversions are rough (rests,
  odd weights, ~13% have suspect/half-time BPM). Abstract the idea, then write a
  clean fragment and gate it. The store lives at `config.corpus.ingested_path`
  (default `../strudel-training/ingested`).
- **Other livecoding languages** — TidalCycles (strudel's direct lineage —
  patterns translate closely), Sonic Pi, Gibber. Search their example repos for
  genre patterns and translate to the strudel-rs surface (mind the divergences).
- **User-provided MIDI / datasets** — when the user supplies MIDIs or a dataset,
  convert reference tracks with the MIDI→strudel pipeline (`midi-strudel` skill /
  `midi-to-strudel`) and abstract the real chord/bass/drum patterns into idioms.

<!-- EXTEND HERE: add new sources as bullet points. Candidates the user flagged:
     a dedicated strudel-search tool, MIDI dataset ingestion, mirrored
     other-livecoding-lang corpora, the music-theory/midi-theory MCPs, audio
     feature analysis. Keep each source's output funneling into the agenda +
     the gate. -->

## The pipeline

1. **Scope** — confirm the genre and any references/datasets the user brought.
   If a recipe already exists (`corpus/genres/<genre>.md` or a draft), read it
   and treat this as an expansion, not a rewrite.
2. **Research** — work the agenda using the source playbook. Take notes with
   citations. Resolve contradictions by preferring primary/production sources.
3. **Translate** — turn each sound-implying finding into a *complete, playable*
   strudel-rs fragment (it must emit in cycle 0 — no dangling partials). Reuse
   idioms proven in existing recipes/corpus.
4. **Gate** — write the draft to `corpus/genres/_drafts/<genre>.md` and run
   `cargo run -p corpus-check corpus/genres/_drafts/<genre>.md`. Fix or drop
   every failing fragment. Re-run until clean. Optionally sanity-check feel with
   the `inspect_pattern` / `critique_pattern` tools.
5. **Assemble** — fill frontmatter (genre, aliases, bpm, swing, scales,
   key_sounds, signature, artists, sources) and write prose sections per the
   agenda. Match the schema in `corpus/genres/README.md`.
6. **Review** — present a summary: what you found, the fragments (with their
   gate status), open questions, and anything you couldn't verify. The draft
   stays in `_drafts/` (gated but NOT loaded by the app) until the user approves.
7. **Promote** — on approval, move the file to `corpus/genres/<genre>.md`. It is
   now loaded by `genre_recipe` and indexed.

## Output rules

- File: `corpus/genres/_drafts/<genre>.md`, kebab-case genre name.
- Schema + format: exactly as `corpus/genres/README.md` documents.
- Aim for ~4–6 fragments: drum core, bass, chords/pad, lead/arp, full skeleton,
  plus any signature-technique fragment that defines the genre.
- Cite a real source URL for every non-obvious claim. Mark anything hand-derived.
- Never invent strudel-rs methods. If an idiom won't validate, find another way
  to express the musical idea or note it as a known engine gap.

## Extension roadmap (for when we grow this)

These are deliberate TODOs — wire them in as the user brings data/tools:
- A `strudel-search` tool/index over local + sibling corpora + other-lang banks.
- MIDI dataset ingestion: batch `midi-to-strudel` over a folder → mined idioms.
- A data-driven agenda (`research-agenda.toml`) so the checklist is editable.
- Music-theory / midi-theory MCP wiring for authoritative scales/progressions.
- Audio-feature analysis of reference tracks (tempo/key/spectral) — currently
  out of scope (no audio analysis in the pipeline).
- Scheduling: a routine that picks the least-developed genre and opens a draft.
