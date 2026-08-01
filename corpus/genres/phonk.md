---
genre: phonk
bpm: [128, 134]
swing: 0
scales: [a phrygian]
key_sounds: [bd, sd, hh, sine, sawtooth, wt_bell]
signature: crushed boom-bap with rolls, 808 sub, icy stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Phonk — crushed boom-bap with rolls, 808 sub, icy stabs. Tempo 128–134 BPM in a phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// phonk in A phrygian (generated) — crushed boom-bap with rolls, 808 sub, icy stabs
setbpm(131);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~, ~ ~ ~ ~ ~ ~ ~ hh*3 ~ ~ ~ ~ ~ ~ ~ hh*4").gain(0.77).crush(8).every(4, x => x.fast(2)),
  note("a1 ~ ~ ~ ~ ~ ~ ~ ~ ~ a1 ~ ~ ~ ~ ~").s("sine").attack(0.01).release(0.7).gain(0.5),
  note("<[a3, c4, e4, g4] [a#3, d4, f4, a4]>").s("sawtooth").struct("~ 1 ~ ~").release(0.2).lpf(1200).gain(0.26).room(0.35).pan(0.42),
  note("<[a5 ~ ~ ~ e6 ~ ~ ~] [a5 ~ ~ ~ e6 ~ ~ ~] [c6 ~ ~ ~ g6 ~ ~ ~] [d6 ~ ~ ~ e6 ~ ~ ~]>").s("wt_bell").room(0.4).delay(0.3).gain(0.24).pan(0.62)
)
```
