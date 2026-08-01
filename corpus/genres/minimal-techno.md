---
genre: minimal-techno
bpm: [126, 130]
swing: 0
scales: [c phrygian]
key_sounds: [bd, sd, hh, sawtooth]
signature: stripped four-on-floor, euclid tom, two-chord hypnosis
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Minimal techno — stripped four-on-floor, euclid tom, two-chord hypnosis. Tempo 126–130 BPM in c phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// minimal techno in C phrygian (generated) — stripped four-on-floor, euclid tom, two-chord hypnosis
setbpm(128);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh, mt ~ ~ ~ ~ mt ~ ~ ~ ~ mt ~ ~ ~ ~ ~").gain(0.9),
  note("c2 ~ c2 ~ c2 ~ c2 ~ c2 ~ c2 c#2 c2 ~ c2 ~").s("sawtooth").lpf(800).resonance(8).gain(0.5),
  note("<[c3, d#3, g3, a#3] [c#3, f3, g#3, c4]>").s("sawtooth").struct("~ ~ ~ 1").release(0.16).lpf(1300).gain(0.28).room(0.2).pan(0.42)
)
```
