---
genre: jumpstyle
bpm: [142, 148]
swing: 0
scales: [g minor]
key_sounds: [bd, sd, hh, sawtooth]
signature: stomping four-on-floor, springy offbeat bass
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Jumpstyle — stomping four-on-floor, springy offbeat bass. Tempo 142–148 BPM in g minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// jumpstyle in G minor (generated) — stomping four-on-floor, springy offbeat bass
setbpm(145);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.74).every(4, x => x.fast(2)),
  note("~ g2 ~ g2 ~ g2 ~ g3").s("sawtooth").lpf(750).resonance(7).gain(0.39),
  note("<[g3, a#3, d4, f4] [d#4, g4, a#4, d5] [f4, a4, c5, d#5] [d#4, g4, a#4, d5]>").s("sawtooth").struct("~ 1 ~ 1").release(0.16).lpf(1900).gain(0.26).room(0.3).pan(0.42)
)
```
