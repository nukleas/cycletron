---
genre: gabber
bpm: [175, 185]
swing: 0
scales: [a phrygian]
key_sounds: [bd, sd, hh, sawtooth]
signature: distorted gabber kick wall, driving 16th bass
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Gabber — distorted gabber kick wall, driving 16th bass. Tempo 175–185 BPM in a phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// gabber in A phrygian (generated) — distorted gabber kick wall, driving 16th bass
setbpm(180);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ bd ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.79).dist(0.5).every(4, x => x.fast(2)),
  note("a2 ~ a2 ~ a2 ~ a2 ~ a2 ~ a2 a#2 a2 ~ a2 ~").s("sawtooth").lpf(900).resonance(8).gain(0.4).dist(0.2),
  note("<[a3, c4, e4, g4] [a#3, d4, f4, a4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.1).lpf(1800).gain(0.25).pan(0.42)
)
```
