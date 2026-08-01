---
genre: gqom
bpm: [122, 128]
swing: 0
scales: [c phrygian]
key_sounds: [bd, sd, hh, sine, wt_pad]
signature: broken half-time weight, tom triplet pull, dark sub
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Gqom — broken half-time weight, tom triplet pull, dark sub. Tempo 122–128 BPM in c phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// gqom in C phrygian (generated) — broken half-time weight, tom triplet pull, dark sub
setbpm(125);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, mt ~ ~ mt ~ ~ mt ~ mt ~ ~ mt ~ ~ mt ~").gain(0.95).every(4, x => x.fast(2)),
  note("c1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c1 ~ ~ ~ ~ ~").s("sine").attack(0.02).release(0.7).gain(0.58),
  note("<[c3, d#3, g3, a#3] [c#3, f3, g#3, c4]>").s("wt_pad").struct("~ ~ 1 ~").attack(0.4).release(1).lpf(900).gain(0.28).room(0.5).pan(0.42)
)
```
