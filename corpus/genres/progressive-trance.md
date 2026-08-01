---
genre: progressive-trance
bpm: [130, 134]
swing: 0
scales: [e minor]
key_sounds: [bd, sd, hh, sawtooth, wt_pad, wt_pluck]
signature: four-on-floor, offbeat bass pulse, long pads, slow arp
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Progressive trance — four-on-floor, offbeat bass pulse, long pads, slow arp. Tempo 130–134 BPM in e minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// progressive trance in E minor (generated) — four-on-floor, offbeat bass pulse, long pads, slow arp
setbpm(132);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.9).every(4, x => x.fast(2)),
  note("~ e2 ~ e2 ~ e2 ~ e3").s("sawtooth").lpf(650).resonance(5).gain(0.48),
  note("<[e3, g3, b3, d4] [c4, e4, g4, b4] [d4, f#4, a4, c5] [c4, e4, g4, b4]>").s("wt_pad").attack(1).release(2).lpf(1400).gain(0.32).room(0.6).pan(0.42),
  note("e4 g4 b4 e5 g5 b5").s("wt_pluck").delay(0.4).room(0.4).gain(0.3).pan(0.62)
)
```
