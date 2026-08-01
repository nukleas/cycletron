---
genre: tech-house
bpm: [124, 128]
swing: 0
scales: [a dorian]
key_sounds: [bd, sd, hh, sawtooth, wt_pluck]
signature: four-on-floor, offbeat hats, clipped dorian stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Tech house — four-on-floor, offbeat hats, clipped dorian stabs. Tempo 124–128 BPM in a dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// tech house in A dorian (generated) — four-on-floor, offbeat hats, clipped dorian stabs
setbpm(126);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.9).every(4, x => x.fast(2)),
  note("~ a2 ~ a2 ~ a2 ~ a3").s("sawtooth").lpf(750).resonance(7).gain(0.5),
  note("<[a3, c4, e4, g4] [d4, f#4, a4, c5] [e4, g4, b4, d5] [d4, f#4, a4, c5]>").s("sawtooth").struct("~ 1 ~ 1").release(0.12).lpf(2100).gain(0.4).room(0.25).pan(0.42),
  note("<[a5 ~ ~ ~ e6 ~ ~ ~] [a5 ~ ~ ~ e6 ~ ~ ~] [c6 ~ ~ ~ g6 ~ ~ ~] [d6 ~ ~ ~ e6 ~ ~ ~]>").s("wt_pluck").delay(0.3).room(0.25).gain(0.32).pan(0.62)
)
```
