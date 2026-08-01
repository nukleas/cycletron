---
genre: 2-step-garage
aliases: [2-step, ukg]
bpm: [128, 132]
swing: 0.55
scales: [g minor]
key_sounds: [bd, sd, hh, sine, gm_epiano1, wt_pluck]
signature: shuffled 2-step, warm sub, clipped chord skips
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

2-step garage — shuffled 2-step, warm sub, clipped chord skips. Tempo 128–132 BPM in g minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// 2-step garage in G minor (generated) — shuffled 2-step, warm sub, clipped chord skips
setbpm(130);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.9),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0172).gain(0.9),
  note("g1 ~ ~ ~ ~ ~ ~ ~ ~ ~ g1 ~ ~ ~ ~ ~").s("sine").attack(0.02).release(0.4).gain(0.58),
  note("<[g3, a#3, d4, f4] [c4, d#4, g4, a#4] [d4, f4, a4, c5] [c4, d#4, g4, a#4]>").s("gm_epiano1").struct("~ 1 ~ 1").release(0.18).gain(0.4).room(0.3).pan(0.42),
  note("g5 ~ ~ ~ d6 ~ ~ ~").s("wt_pluck").delay(0.25).room(0.3).gain(0.3).pan(0.62)
)
```
