---
genre: acid-house
bpm: [123, 127]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, sawtooth]
signature: four-on-floor, squelching 303 line, sparse stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Acid house — four-on-floor, squelching 303 line, sparse stabs. Tempo 123–127 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// acid house in A minor (generated) — four-on-floor, squelching 303 line, sparse stabs
setbpm(125);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.9),
  note("a2 d3 c3 ~ d3 e3 a3 ~ a3 a3 f3 ~ a3 f3 d3 ~").s("sawtooth").lpf(1100).resonance(18).gain(0.48),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5]>").s("sawtooth").struct("~ ~ 1 ~").release(0.15).lpf(1600).gain(0.32).room(0.3).pan(0.42)
)
```
