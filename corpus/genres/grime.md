---
genre: grime
bpm: [138, 142]
swing: 0
scales: [c minor]
key_sounds: [bd, sd, hh, square, sawtooth]
signature: half-time menace, square sub jabs, cold stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Grime — half-time menace, square sub jabs, cold stabs. Tempo 138–142 BPM in c minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// grime in C minor (generated) — half-time menace, square sub jabs, cold stabs
setbpm(140);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.9).every(4, x => x.fast(2)),
  note("c1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c1 ~ ~ ~ ~ ~").s("square").lpf(500).gain(0.55),
  note("<[c3, d#3, g3, a#3] [d3, f3, g#3, c4]>").s("sawtooth").struct("1 ~ ~ 1").release(0.12).lpf(1400).gain(0.3).room(0.25).pan(0.42)
)
```
