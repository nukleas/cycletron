---
genre: synth-pop
bpm: [116, 120]
swing: 0
scales: [c major]
key_sounds: [bd, sd, hh, sawtooth, supersaw, square]
signature: rock backbeat, octave synth bass, bright hook chords
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Synth-pop — rock backbeat, octave synth bass, bright hook chords. Tempo 116–120 BPM in c major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// synth-pop in C major (generated) — rock backbeat, octave synth bass, bright hook chords
setbpm(118);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.52).every(4, x => x.fast(2)),
  note("c2 ~ c3 ~ c2 ~ c3 ~").s("sawtooth").lpf(800).resonance(5).gain(0.29),
  note("<[c3, e3, g3, b3] [g3, b3, d4, f4] [a3, c4, e4, g4] [f3, a3, c4, e4]>").s("supersaw").struct("~ 1 ~ 1").release(0.2).lpf(2200).gain(0.21).room(0.3).pan(0.42),
  note("<[c5 ~ f5 ~ g5 ~ f5 ~] [c5 ~ f5 ~ g5 ~ f5 ~] [e5 ~ a5 ~ b5 ~ a5 ~] [f5 ~ f5 ~ g5 ~ e5 ~]>").s("square").release(0.2).delay(0.25).room(0.3).gain(0.17).pan(0.62)
)
```
