---
genre: techno
bpm: [128, 132]
swing: 0
scales: [c phrygian]
key_sounds: [bd, sd, hh, sawtooth]
signature: four-on-floor, euclid tom, driving bass
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Techno — four-on-floor, euclid tom, driving bass. Tempo 128–132 BPM in c phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// techno in C phrygian (generated) — four-on-floor, euclid tom, driving bass
setbpm(130);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh, mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ ~").gain(0.9).every(4, x => x.fast(2)),
  note("c2 ~ c2 ~ c2 ~ c2 ~ c2 ~ c2 c#2 c2 ~ c2 ~").s("sawtooth").lpf(900).resonance(8).gain(0.5),
  note("<[c3, d#3, g3, a#3] [c#3, f3, g#3, c4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.2).lpf(1400).gain(0.3).room(0.2)
)
```
