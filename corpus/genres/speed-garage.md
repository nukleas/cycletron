---
genre: speed-garage
bpm: [133, 137]
swing: 0.4
scales: [f minor]
key_sounds: [bd, sd, hh, supersaw, sawtooth]
signature: two-step drive with a warped reese sub
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Speed garage — two-step drive with a warped reese sub. Tempo 133–137 BPM in f minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// speed garage in F minor (generated) — two-step drive with a warped reese sub
setbpm(135);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.9).every(4, x => x.fast(2)),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0125).gain(0.9),
  note("f1 ~ ~ d#2 ~ ~ f2 ~").s("supersaw").lpf(550).resonance(12).gain(0.55),
  note("<[f3, g#3, c4, d#4] [c#4, f4, g#4, c5]>").s("sawtooth").struct("~ 1").release(0.15).lpf(1600).gain(0.3).room(0.3).pan(0.42)
)
```
