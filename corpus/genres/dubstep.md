---
genre: dubstep
bpm: [138, 142]
swing: 0
scales: [e minor]
key_sounds: [bd, sd, hh, supersaw, sawtooth]
signature: half-time drop, wobbling sub, cavernous space
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Dubstep — half-time drop, wobbling sub, cavernous space. Tempo 138–142 BPM in e minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// dubstep in E minor (generated) — half-time drop, wobbling sub, cavernous space
setbpm(140);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.63).every(4, x => x.fast(2)),
  note("e1 ~ ~ ~ e1 ~ ~ ~").s("supersaw").lpf(400).resonance(14).gain(0.37),
  note("<[e3, g3, b3, d4] [c4, e4, g4, b4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.3).lpf(1100).gain(0.2).room(0.5).pan(0.42)
)
```
