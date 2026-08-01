---
genre: trap-edm
bpm: [138, 142]
swing: 0
scales: [c# phrygian]
key_sounds: [bd, sd, hh, sine, sawtooth]
signature: half-time 808 slam with rolled hats and a dark stab
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Trap (EDM) — half-time 808 slam with rolled hats and a dark stab. Tempo 138–142 BPM in c# phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// trap (EDM) in C# phrygian (generated) — half-time 808 slam with rolled hats and a dark stab
setbpm(140);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~, ~ ~ ~ ~ ~ ~ ~ hh*3 ~ ~ ~ ~ ~ ~ ~ hh*4").gain(0.8).every(4, x => x.fast(2)),
  note("c#1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c#1 ~ ~ ~ ~ ~").s("sine").attack(0.01).release(0.7).gain(0.5),
  note("<[c#3, e3, g#3, b3] [d3, f#3, a3, c#4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.2).lpf(1300).gain(0.25).room(0.3).pan(0.42)
)
```
