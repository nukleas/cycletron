---
genre: broken-beat
bpm: [118, 122]
swing: 0.3
scales: [d dorian]
key_sounds: [bd, sd, hh, gm_acoustic_bass, gm_epiano1, wt_flute]
signature: swung broken drums, walking bass, Rhodes extensions
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Broken beat — swung broken drums, walking bass, Rhodes extensions. Tempo 118–122 BPM in d dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// broken beat in D dorian (generated) — swung broken drums, walking bass, Rhodes extensions
setbpm(120);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ ~").gain(0.9),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0094).gain(0.9),
  note("d2 ~ a2 ~ d2 ~ c3 ~").s("gm_acoustic_bass").gain(0.58),
  note("<[d3, f3, a3, c4] [g3, b3, d4, f4] [a3, c4, e4, g4] [e3, g3, b3, d4]>").s("gm_epiano1").release(0.4).gain(0.4).room(0.35).pan(0.42),
  note("a4 ~ d5 ~ g5 ~ f5 ~").s("wt_flute").room(0.35).delay(0.2).gain(0.3).pan(0.62)
)
```
