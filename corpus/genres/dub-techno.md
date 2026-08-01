---
genre: dub-techno
bpm: [118, 122]
swing: 0
scales: [c minor]
key_sounds: [bd, sd, hh, sine, sawtooth]
signature: four-on-floor under washed minor chords and a slow sub
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Dub techno — four-on-floor under washed minor chords and a slow sub. Tempo 118–122 BPM in c minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// dub techno in C minor (generated) — four-on-floor under washed minor chords and a slow sub
setbpm(120);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.9),
  note("c1 ~ ~ ~ c1 ~ ~ ~").s("sine").attack(0.05).release(0.8).gain(0.55),
  note("<[c3, d#3, g3, a#3] [f3, g#3, c4, d#4]>").s("sawtooth").struct("~ 1 ~ ~").release(0.5).lpf(900).gain(0.34).room(0.8).delay(0.45).pan(0.42)
)
```
