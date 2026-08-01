---
genre: ebm
bpm: [126, 130]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, sawtooth]
signature: four-on-floor with snare, sequenced 16th bass, cold stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

EBM — four-on-floor with snare, sequenced 16th bass, cold stabs. Tempo 126–130 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// EBM in A minor (generated) — four-on-floor with snare, sequenced 16th bass, cold stabs
setbpm(128);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.92).dist(0.15),
  note("a2 ~ a2 ~ a2 ~ a2 ~ a2 ~ a2 b2 a2 ~ a2 ~").s("sawtooth").lpf(800).resonance(10).gain(0.5),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5]>").s("sawtooth").struct("~ 1 ~ 1").release(0.12).lpf(1600).gain(0.32).pan(0.42)
)
```
