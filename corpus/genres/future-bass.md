---
genre: future-bass
bpm: [145, 155]
swing: 0
scales: [d major]
key_sounds: [bd, sd, hh, sine, supersaw, wt_lead]
signature: half-time bounce, detuned supersaw chords, bright lead
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Future bass — half-time bounce, detuned supersaw chords, bright lead. Tempo 145–155 BPM in d major. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// future bass in D major (generated) — half-time bounce, detuned supersaw chords, bright lead
setbpm(150);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~, ~ ~ ~ ~ ~ ~ ~ hh*3 ~ ~ ~ ~ ~ ~ ~ hh*4").gain(0.9).every(4, x => x.fast(2)),
  note("d1 ~ ~ ~ ~ ~ ~ ~ ~ ~ d1 ~ ~ ~ ~ ~").s("sine").attack(0.02).release(0.6).gain(0.55),
  note("<[d3, f#3, a3, c#4] [a3, c#4, e4, g4] [b3, d4, f#4, a4] [g3, b3, d4, f#4]>").s("supersaw").struct("~ 1 1 ~").release(0.25).lpf(2600).gain(0.38).room(0.45).pan(0.42),
  note("<[d5 ~ g5 ~ b5 ~ a5 ~] [d5 ~ g5 ~ b5 ~ a5 ~] [f#5 ~ b5 ~ d6 ~ c#6 ~] [a5 ~ a5 ~ b5 ~ f#5 ~]>").s("wt_lead").delay(0.3).room(0.4).gain(0.32).pan(0.62)
)
```
