---
genre: footwork
bpm: [155, 165]
swing: 0
scales: [g minor]
key_sounds: [bd, sd, hh, sine, sawtooth]
signature: rapid 808 syncopation, clap cross-fire, hypnotic stab
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Footwork — rapid 808 syncopation, clap cross-fire, hypnotic stab. Tempo 155–165 BPM in g minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// footwork in G minor (generated) — rapid 808 syncopation, clap cross-fire, hypnotic stab
setbpm(160);

stack(
  s("bd ~ ~ bd ~ ~ bd ~ ~ ~ bd ~ ~ bd ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.92),
  note("g1 ~ ~ ~ ~ ~ ~ ~ ~ ~ g1 ~ ~ ~ ~ ~").s("sine").attack(0.01).release(0.5).gain(0.58),
  note("<[g3, a#3, d4, f4] [d#4, g4, a#4, d5]>").s("sawtooth").struct("~ ~ 1 ~").release(0.15).lpf(1300).gain(0.3).room(0.3).pan(0.42)
)
```
