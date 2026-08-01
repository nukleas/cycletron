---
genre: afro-house
bpm: [118, 122]
swing: 0
scales: [a dorian]
key_sounds: [bd, sd, hh, sawtooth, gm_epiano1, gm_kalimba]
signature: four-on-floor with euclid percussion web, kalimba call
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Afro house — four-on-floor with euclid percussion web, kalimba call. Tempo 118–122 BPM in a dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// afro house in A dorian (generated) — four-on-floor with euclid percussion web, kalimba call
setbpm(120);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.9).every(4, x => x.fast(2)),
  note("~ a2 ~ a2 ~ a2 ~ a3").s("sawtooth").lpf(700).resonance(6).gain(0.5),
  note("<[a3, c4, e4, g4] [d4, f#4, a4, c5]>").s("gm_epiano1").struct("~ 1 ~ ~").release(0.3).gain(0.36).room(0.35).pan(0.42),
  note("<[a5 ~ d6 ~ e6 ~ d6 ~] [a5 ~ d6 ~ e6 ~ d6 ~] [c6 ~ f#6 ~ g6 ~ f#6 ~] [d6 ~ d6 ~ e6 ~ c6 ~]>").s("gm_kalimba").delay(0.25).room(0.35).gain(0.32).pan(0.62)
)
```
