---
genre: juke
bpm: [155, 165]
swing: 0
scales: [g minor]
key_sounds: [bd, sd, hh, sine, sawtooth]
signature: rapid 808 pulse with hats, springing sub, party stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Juke — rapid 808 pulse with hats, springing sub, party stabs. Tempo 155–165 BPM in g minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// juke in G minor (generated) — rapid 808 pulse with hats, springing sub, party stabs
setbpm(160);

stack(
  s("bd ~ ~ bd ~ ~ bd ~ ~ ~ bd ~ ~ bd ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.92).every(4, x => x.fast(2)),
  note("g1 ~ ~ ~ ~ ~ ~ ~ ~ ~ g1 ~ ~ ~ ~ ~").s("sine").attack(0.01).release(0.5).gain(0.56),
  note("<[g3, a#3, d4, f4] [c4, d#4, g4, a#4] [d4, f4, a4, c5] [c4, d#4, g4, a#4]>").s("sawtooth").struct("~ 1 ~ 1").release(0.15).lpf(1500).gain(0.32).room(0.3).pan(0.42)
)
```
