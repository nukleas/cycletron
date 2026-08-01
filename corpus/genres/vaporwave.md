---
genre: vaporwave
bpm: [65, 75]
swing: 0
scales: [c major]
key_sounds: [bd, sd, hh, gm_acoustic_bass, gm_epiano1, wt_choir]
signature: slow-motion boom-bap, drowned lush sevenths, faded lead
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Vaporwave — slow-motion boom-bap, drowned lush sevenths, faded lead. Tempo 65–75 BPM in c major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// vaporwave in C major (generated) — slow-motion boom-bap, drowned lush sevenths, faded lead
setbpm(70);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.8).crush(9).room(0.5).every(4, x => x.fast(2)),
  note("c2 ~ g2 ~ c2 ~ b2 ~").s("gm_acoustic_bass").gain(0.55),
  note("<[c3, e3, g3, b3] [f3, a3, c4, e4] [a3, c4, e4, g4] [g3, b3, d4, f4]>").s("gm_epiano1").release(0.8).gain(0.4).room(0.75).delay(0.4).pan(0.42),
  note("<[g4 ~ c5 ~ f5 ~ e5 ~] [g4 ~ c5 ~ f5 ~ e5 ~] [b4 ~ e5 ~ a5 ~ g5 ~] [e5 ~ e5 ~ e5 ~ b4 ~]>").s("wt_choir").attack(0.3).room(0.7).delay(0.4).gain(0.26).pan(0.62)
)
```
