---
genre: nu-skool-breaks
bpm: [128, 132]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, supersaw, sawtooth]
signature: chunky break, reese undertow, electro stabs
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Nu skool breaks — chunky break, reese undertow, electro stabs. Tempo 128–132 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// nu skool breaks in A minor (generated) — chunky break, reese undertow, electro stabs
setbpm(130);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ sd ~ ~ ~ ~ sd ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.9).every(4, x => x.fast(2)),
  note("a1 ~ ~ g2 ~ ~ a2 ~").s("supersaw").lpf(600).resonance(10).gain(0.5),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5] [g4, b4, d5, f5] [f4, a4, c5, e5]>").s("sawtooth").struct("~ 1 ~ 1").release(0.14).lpf(1700).gain(0.32).room(0.3).pan(0.42)
)
```
