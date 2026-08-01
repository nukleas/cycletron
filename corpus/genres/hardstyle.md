---
genre: hardstyle
bpm: [148, 152]
swing: 0
scales: [f minor]
key_sounds: [bd, sd, hh, sawtooth, supersaw]
signature: punished kick, offbeat bass slam, supersaw anthem stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Hardstyle — punished kick, offbeat bass slam, supersaw anthem stabs. Tempo 148–152 BPM in f minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// hardstyle in F minor (generated) — punished kick, offbeat bass slam, supersaw anthem stabs
setbpm(150);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ bd ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.72).dist(0.35).every(4, x => x.fast(2)),
  note("~ f2 ~ f2 ~ f2 ~ f3").s("sawtooth").lpf(700).resonance(8).gain(0.39).dist(0.15),
  note("<[f3, g#3, c4, d#4] [c#4, f4, g#4, c5] [a#3, c#4, f4, g#4] [d#4, g4, a#4, c#5]>").s("supersaw").struct("~ 1 ~ 1").release(0.2).lpf(2200).gain(0.27).room(0.35).pan(0.42)
)
```
