---
genre: future-garage
bpm: [132, 138]
swing: 0.5
scales: [a minor]
key_sounds: [bd, sd, hh, sine, wt_pad, wt_bell]
signature: shuffled 2-step, hollow pads, sparse bell fragments
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Future garage — shuffled 2-step, hollow pads, sparse bell fragments. Tempo 132–138 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// future garage in A minor (generated) — shuffled 2-step, hollow pads, sparse bell fragments
setbpm(135);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.86).every(4, x => x.fast(2)),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0156).gain(0.86),
  note("a1 ~ ~ ~ ~ ~ ~ ~ ~ ~ a1 ~ ~ ~ ~ ~").s("sine").attack(0.03).release(0.6).gain(0.53),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5] [d4, f4, a4, c5] [f4, a4, c5, e5]>").s("wt_pad").attack(0.8).release(1.5).lpf(1100).gain(0.29).room(0.7).pan(0.42),
  note("<[a5 ~ ~ e6 ~ ~ d6 ~] [a5 ~ ~ e6 ~ ~ d6 ~] [c6 ~ ~ g6 ~ ~ f6 ~] [d6 ~ ~ e6 ~ ~ c6 ~]>").s("wt_bell").delay(0.4).room(0.6).gain(0.27).pan(0.62)
)
```
