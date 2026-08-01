---
genre: drill-n-bass
bpm: [165, 175]
swing: 0
scales: [e phrygian]
key_sounds: [bd, sd, hh, supersaw, sawtooth]
signature: amen shrapnel at speed, growling reese, needle stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Drill 'n' bass — amen shrapnel at speed, growling reese, needle stabs. Tempo 165–175 BPM in e phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// drill 'n' bass in E phrygian (generated) — amen shrapnel at speed, growling reese, needle stabs
setbpm(170);

stack(
  s("bd ~ bd ~ ~ ~ ~ ~ bd ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ sd ~, hh*16").gain(0.92),
  note("e1 ~ ~ d2 ~ ~ e2 ~").s("supersaw").lpf(700).resonance(11).gain(0.5),
  note("<[e3, g3, b3, d4] [f3, a3, c4, e4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.1).lpf(1700).gain(0.28).pan(0.42)
)
```
