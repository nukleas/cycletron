---
genre: big-beat
bpm: [128, 132]
swing: 0
scales: [e mixolydian]
key_sounds: [bd, sd, hh, sawtooth]
signature: driven break, octave bass riff, blaring stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Big beat — driven break, octave bass riff, blaring stabs. Tempo 128–132 BPM in e mixolydian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// big beat in E mixolydian (generated) — driven break, octave bass riff, blaring stabs
setbpm(130);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.59).dist(0.15).every(4, x => x.fast(2)),
  note("e2 ~ e3 ~ e2 ~ e3 ~").s("sawtooth").lpf(900).resonance(8).gain(0.31),
  note("<[e3, g#3, b3, d4] [d4, f#4, a4, c#5]>").s("sawtooth").struct("1 ~ ~ 1").release(0.15).lpf(2000).gain(0.22).room(0.3).pan(0.42)
)
```
