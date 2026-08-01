---
genre: ambient-dub
bpm: [65, 75]
swing: 0
scales: [c minor]
key_sounds: [bd, sd, hh, sine, gm_epiano1, gm_kalimba]
signature: slow skank pulse, sub swells, echoing chords
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Ambient dub — slow skank pulse, sub swells, echoing chords. Tempo 65–75 BPM in c minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// ambient dub in C minor (generated) — slow skank pulse, sub swells, echoing chords
setbpm(70);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ rs ~ ~ ~ ~ ~ ~ ~ rs ~ ~ ~, hh ~ ~ ~ ~ ~ ~ ~ hh ~ ~ ~ ~ ~ ~ ~").gain(0.5).room(0.6),
  note("c1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c1 ~ ~ ~ ~ ~").s("sine").attack(0.05).release(1).gain(0.55),
  note("<[c3, d#3, g3, a#3] [f3, g#3, c4, d#4]>").s("gm_epiano1").struct("~ 1 ~ ~").release(0.6).gain(0.34).room(0.8).delay(0.5).pan(0.42),
  note("c5 ~ ~ g5 ~ ~ f5 ~").s("gm_kalimba").room(0.7).delay(0.45).gain(0.3).pan(0.62)
)
```
