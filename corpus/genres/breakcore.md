---
genre: breakcore
bpm: [190, 210]
swing: 0
scales: [d phrygian]
key_sounds: [bd, sd, hh, supersaw, sawtooth]
signature: amen chop at breakneck tempo, reese growl
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Breakcore — amen chop at breakneck tempo, reese growl. Tempo 190–210 BPM in d phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// breakcore in D phrygian (generated) — amen chop at breakneck tempo, reese growl
setbpm(200);

stack(
  s("bd ~ bd ~ ~ ~ ~ ~ bd ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ sd ~, hh*16").gain(0.95),
  note("d1 ~ ~ c2 ~ ~ d2 ~").s("supersaw").lpf(650).resonance(12).gain(0.5),
  note("<[d3, f3, a3, c4] [d#3, g3, a#3, d4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.1).lpf(1600).gain(0.28).pan(0.42)
)
```
