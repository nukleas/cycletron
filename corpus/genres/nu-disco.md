---
genre: nu-disco
bpm: [118, 122]
swing: 0
scales: [c dorian]
key_sounds: [bd, sd, hh, sawtooth, gm_epiano1, wt_pluck]
signature: four-on-floor strut, octave disco bass, juicy stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Nu-disco — four-on-floor strut, octave disco bass, juicy stabs. Tempo 118–122 BPM in c dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// nu-disco in C dorian (generated) — four-on-floor strut, octave disco bass, juicy stabs
setbpm(120);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.9).every(4, x => x.fast(2)),
  note("c2 ~ c3 ~ c2 ~ c3 ~").s("sawtooth").lpf(850).resonance(6).gain(0.5),
  note("<[c3, d#3, g3, a#3] [f3, a3, c4, d#4] [g3, a#3, d4, f4] [f3, a3, c4, d#4]>").s("gm_epiano1").struct("~ 1 ~ 1").release(0.2).gain(0.4).room(0.3).pan(0.42),
  note("<[c5 ~ f5 ~ g5 ~ f5 ~] [c5 ~ f5 ~ g5 ~ f5 ~] [d#5 ~ a5 ~ a#5 ~ a5 ~] [f5 ~ f5 ~ g5 ~ d#5 ~]>").s("wt_pluck").delay(0.25).room(0.3).gain(0.3).pan(0.62)
)
```
