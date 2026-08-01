---
genre: happy-hardcore
bpm: [165, 175]
swing: 0
scales: [c major]
key_sounds: [bd, sd, hh, sawtooth, supersaw, square]
signature: 4/4 kick over a break, bouncing octave bass, rave arp
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Happy hardcore — 4/4 kick over a break, bouncing octave bass, rave arp. Tempo 165–175 BPM in c major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// happy hardcore in C major (generated) — 4/4 kick over a break, bouncing octave bass, rave arp
setbpm(170);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ ~").gain(0.95).every(4, x => x.fast(2)),
  note("c2 ~ c3 ~ c2 ~ c3 ~").s("sawtooth").lpf(800).resonance(6).gain(0.5),
  note("<[c3, e3, g3, b3] [g3, b3, d4, f4] [a3, c4, e4, g4] [f3, a3, c4, e4]>").s("supersaw").struct("~ 1 ~ 1").release(0.18).lpf(2400).gain(0.36).room(0.35).pan(0.42),
  note("c4 e4 g4 e4").s("square").release(0.2).delay(0.25).room(0.3).gain(0.32).pan(0.62)
)
```
