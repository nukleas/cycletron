---
genre: idm
bpm: [120, 140]
swing: 0
scales: [d dorian]
key_sounds: [bd, sd, hh, fm, gm_epiano1, wt_bell]
signature: broken beat against an euclid pulse, soft keys, wandering lead
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

IDM — broken beat against an euclid pulse, soft keys, wandering lead. Tempo 120–140 BPM in d dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// IDM in D dorian (generated) — broken beat against an euclid pulse, soft keys, wandering lead
setbpm(130);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ ~, mt ~ ~ mt ~ mt ~ mt ~ ~ mt ~ mt ~ mt ~").gain(0.9).every(4, x => x.fast(2)),
  note("d1 ~ ~ c2 ~ ~ d2 ~").s("fm").lpf(700).gain(0.5),
  note("<[d3, f3, a3, c4] [g3, b3, d4, f4] [e3, g3, b3, d4] [a3, c4, e4, g4]>").s("gm_epiano1").release(0.4).gain(0.36).room(0.4).pan(0.42),
  note("<[d5 ~ ~ b5 ~ ~ a5 ~] [d5 ~ ~ b5 ~ ~ a5 ~] [f5 ~ ~ d6 ~ ~ c6 ~] [a5 ~ ~ b5 ~ ~ f5 ~]>").s("wt_bell").delay(0.35).room(0.4).gain(0.3).pan(0.62)
)
```
