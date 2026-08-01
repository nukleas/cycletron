---
genre: bitpop
bpm: [126, 130]
swing: 0
scales: [e major]
key_sounds: [bd, sd, hh, square, pulse]
signature: four-on-floor chip drive, square bass, sparkling lead
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Bitpop — four-on-floor chip drive, square bass, sparkling lead. Tempo 126–130 BPM in e major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// bitpop in E major (generated) — four-on-floor chip drive, square bass, sparkling lead
setbpm(128);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.88).crush(7).every(4, x => x.fast(2)),
  note("e2 ~ e3 ~ e2 ~ e3 ~").s("square").release(0.15).gain(0.45).crush(8),
  note("<[e3, g#3, b3, d#4] [b3, d#4, f#4, a4] [c#4, e4, g#4, b4] [a3, c#4, e4, g#4]>").s("pulse").struct("~ 1 ~ 1").release(0.18).gain(0.32).crush(8).pan(0.42),
  note("<[e6 ~ a6 ~ c#7 ~ b6 ~] [e6 ~ a6 ~ c#7 ~ b6 ~] [g#6 ~ c#7 ~ e7 ~ d#7 ~] [b6 ~ b6 ~ c#7 ~ g#6 ~]>").s("square").release(0.15).delay(0.2).gain(0.3).crush(8).pan(0.62)
)
```
