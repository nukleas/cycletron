---
genre: new-wave
bpm: [128, 132]
swing: 0
scales: [b minor]
key_sounds: [bd, sd, hh, sawtooth]
signature: driving backbeat, insistent octave bass, angular stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

New wave — driving backbeat, insistent octave bass, angular stabs. Tempo 128–132 BPM in b minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// new wave in B minor (generated) — driving backbeat, insistent octave bass, angular stabs
setbpm(130);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.9),
  note("b2 ~ b3 ~ b2 ~ b3 ~").s("sawtooth").lpf(850).resonance(7).gain(0.5),
  note("<[b3, d4, f#4, a4] [g4, b4, d5, f#5] [a4, c#5, e5, g5] [g4, b4, d5, f#5]>").s("sawtooth").struct("1 ~ 1 ~").release(0.15).lpf(1900).gain(0.34).room(0.3).pan(0.42)
)
```
