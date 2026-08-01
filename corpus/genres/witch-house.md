---
genre: witch-house
bpm: [95, 105]
swing: 0
scales: [e phrygian]
key_sounds: [bd, sd, hh, sine, wt_choir, wt_bell]
signature: half-time crawl, detuned pads, buried bells
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Witch house — half-time crawl, detuned pads, buried bells. Tempo 95–105 BPM in e phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// witch house in E phrygian (generated) — half-time crawl, detuned pads, buried bells
setbpm(100);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.88).crush(9).every(4, x => x.fast(2)),
  note("e1 ~ ~ ~ ~ ~ ~ ~ ~ ~ e1 ~ ~ ~ ~ ~").s("sine").attack(0.03).release(0.9).gain(0.55),
  note("<[e3, g3, b3, d4] [f3, a3, c4, e4] [e3, g3, b3, d4] [a3, c4, e4, g4]>").s("wt_choir").attack(1).release(2.5).lpf(900).gain(0.3).room(0.8).pan(0.42),
  note("<[e4 ~ ~ a4 ~ ~ g4 ~] [e4 ~ ~ a4 ~ ~ g4 ~] [g4 ~ ~ c5 ~ ~ b4 ~] [g4 ~ ~ a4 ~ ~ g4 ~]>").s("wt_bell").room(0.7).delay(0.45).gain(0.26).pan(0.62)
)
```
