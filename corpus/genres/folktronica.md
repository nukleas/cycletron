---
genre: folktronica
bpm: [105, 115]
swing: 0
scales: [g major]
key_sounds: [bd, sd, hh, gm_acoustic_bass, wt_piano, gm_kalimba]
signature: soft boom-bap with euclid texture, upright bass, kalimba line
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Folktronica — soft boom-bap with euclid texture, upright bass, kalimba line. Tempo 105–115 BPM in g major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// folktronica in G major (generated) — soft boom-bap with euclid texture, upright bass, kalimba line
setbpm(110);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, mt ~ ~ ~ ~ mt ~ ~ ~ ~ mt ~ ~ ~ ~ ~").gain(0.8).every(4, x => x.fast(2)),
  note("g2 ~ d3 ~ g2 ~ f#3 ~").s("gm_acoustic_bass").gain(0.56),
  note("<[g3, b3, d4, f#4] [d4, f#4, a4, c5] [e4, g4, b4, d5] [c4, e4, g4, b4]>").s("wt_piano").release(0.5).gain(0.38).room(0.4).pan(0.42),
  note("<[d5 ~ g5 ~ c6 ~ b5 ~] [d5 ~ g5 ~ c6 ~ b5 ~] [f#5 ~ b5 ~ e6 ~ d6 ~] [b5 ~ b5 ~ b5 ~ f#5 ~]>").s("gm_kalimba").room(0.4).delay(0.25).gain(0.32).pan(0.62)
)
```
