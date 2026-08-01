---
genre: jump-up
bpm: [172, 176]
swing: 0
scales: [g minor]
key_sounds: [bd, sd, hh, supersquare, sawtooth]
signature: two-step break with a talking octave bass hook
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Jump-up — two-step break with a talking octave bass hook. Tempo 172–176 BPM in g minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// jump-up in G minor (generated) — two-step break with a talking octave bass hook
setbpm(174);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.9),
  note("g1 ~ g2 ~ g1 ~ g2 ~").s("supersquare").lpf(900).resonance(12).gain(0.5),
  note("<[g3, a#3, d4, f4] [d#4, g4, a#4, d5]>").s("sawtooth").struct("~ 1").release(0.14).lpf(1500).gain(0.3).room(0.25).pan(0.42)
)
```
