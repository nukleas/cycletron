# Genre recipes

A living, version-controlled knowledge base of how to make a given style **in
strudel-rs terms**. One markdown file per genre (kebab-case filename, e.g.
`acid-techno.md`). Surfaced to the agent via the `genre_recipe` tool and to the
UI/CLIs via the `genre_recipe` IPC command.

`README.md` and `_`-prefixed files are ignored by the loader.

## The trust anchor

Every ```` ```strudel ```` fragment in every recipe is extracted and run through
`corpus-check` — the same parse + emit gate the curated corpus uses. **A recipe
cannot ship a fragment that doesn't actually play on strudel-rs.** This is what
separates a recipe from web-strudel folklore: fragments are proven, not
remembered. Run the gate before committing:

```
cargo run -p corpus-check
```

Write every fragment as a *complete, playable* pattern (it must emit at least
one event in cycle 0) — not a dangling `.lpf(...)` partial. That keeps them
copy-paste-able and lets the gate validate them.

## File format

```
---
genre: acid-techno                 # canonical name (defaults to filename)
aliases: [acid, acid house]        # alternate names for lookup
bpm: [130, 150]                    # tempo range
swing: 0.0                         # 0..1, optional
scales: [phrygian, minor]          # idiomatic scales/modes
key_sounds: [sawtooth, bd, cp]     # defining sounds
signature: One-line description of the sound.
artists: [Hardfloor, Plastikman]   # reference artists/tracks
sources:                           # provenance (block or inline array)
  - "https://..."
---

Intro prose (optional).

## Section title

Prose about this layer / technique.

```strudel
setbpm(140);
s("bd*4")
```
```

Frontmatter is a small YAML subset: scalars, inline arrays `[a, b]`, and block
arrays (`-` items). Quote any value containing a comma.

## Growing this

Recipes are meant to be **continuously researched**. The
`/research-genre <genre>` skill drafts a recipe from web + music-theory sources,
translates conventions into strudel-rs fragments, validates them through the
gate, and writes a candidate file here for review. Cite sources in frontmatter
so every claim stays auditable.
