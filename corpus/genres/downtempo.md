---
genre: downtempo
bpm: [95, 105]
swing: 0.2
scales: [g dorian]
key_sounds: [bd, sd, hh, gm_acoustic_bass, gm_epiano1, gm_marimba]
signature: relaxed boom-bap, walking bass, warm keys
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Downtempo — relaxed boom-bap, walking bass, warm keys. Tempo 95–105 BPM in g dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// downtempo in G dorian (generated) — relaxed boom-bap, walking bass, warm keys
setbpm(100);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~").gain(0.85),
  s("~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~").late(0.0125).gain(0.85),
  note("g2 ~ d3 ~ g2 ~ f3 ~").s("gm_acoustic_bass").gain(0.58),
  note("<[g3, a#3, d4, f4] [c4, e4, g4, a#4] [d4, f4, a4, c5] [g3, a#3, d4, f4]>").s("gm_epiano1").release(0.45).gain(0.4).room(0.35).pan(0.42),
  note("d5 ~ g5 ~ c6 ~ a#5 ~").s("gm_marimba").room(0.35).delay(0.25).gain(0.3).pan(0.62)
)
```
