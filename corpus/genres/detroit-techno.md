---
genre: detroit-techno
bpm: [126, 130]
swing: 0
scales: [c dorian]
key_sounds: [bd, sd, hh, sawtooth, gm_epiano1, wt_bell]
signature: four-on-floor, warm dorian chords over a rolling machine bass
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Detroit techno — four-on-floor, warm dorian chords over a rolling machine bass. Tempo 126–130 BPM in c dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// Detroit techno in C dorian (generated) — four-on-floor, warm dorian chords over a rolling machine bass
setbpm(128);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.9),
  note("c2 ~ c2 ~ c2 ~ c2 ~ c2 ~ c2 d2 c2 ~ c2 ~").s("sawtooth").lpf(850).resonance(6).gain(0.48),
  note("<[c3, d#3, g3, a#3] [f3, a3, c4, d#4] [g3, a#3, d4, f4] [f3, a3, c4, d#4]>").s("gm_epiano1").struct("~ 1 ~ ~").release(0.3).gain(0.4).room(0.35).pan(0.42),
  note("c5 ~ ~ ~ a5 ~ ~ ~").s("wt_bell").delay(0.3).room(0.4).gain(0.3).pan(0.62)
)
```
