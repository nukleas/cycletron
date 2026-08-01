---
genre: hard-techno
bpm: [138, 145]
swing: 0
scales: [c phrygian]
key_sounds: [bd, sd, hh, sawtooth]
signature: pounding four-on-floor, relentless 16th bass, dark stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Hard techno — pounding four-on-floor, relentless 16th bass, dark stabs. Tempo 138–145 BPM in c phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// hard techno in C phrygian (generated) — pounding four-on-floor, relentless 16th bass, dark stabs
setbpm(141);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, hh*16").gain(0.95).dist(0.25),
  note("c2 ~ c2 ~ c2 ~ c2 ~ c2 ~ c2 c#2 c2 ~ c2 ~").s("sawtooth").lpf(950).resonance(9).gain(0.5),
  note("<[c3, d#3, g3, a#3] [c#3, f3, g#3, c4]>").s("sawtooth").struct("~ ~ 1 ~").release(0.14).lpf(1500).gain(0.3).room(0.2).pan(0.42)
)
```
