---
genre: dub
bpm: [70, 80]
swing: 0.25
scales: [a dorian]
key_sounds: [bd, sd, hh, gm_acoustic_bass, gm_epiano1]
signature: one-drop skank, walking bass, chords lost in echo
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Dub — one-drop skank, walking bass, chords lost in echo. Tempo 70–80 BPM in a dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// dub in A dorian (generated) — one-drop skank, walking bass, chords lost in echo
setbpm(75);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ rs ~ ~ ~ ~ ~ ~ ~ rs ~ ~ ~").gain(0.62).room(0.4).every(4, x => x.fast(2)),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0078).gain(0.62).room(0.4),
  note("a1 ~ e2 ~ a1 ~ g2 ~").s("gm_acoustic_bass").gain(0.42),
  note("<[a3, c4, e4, g4] [d4, f#4, a4, c5]>").s("gm_epiano1").struct("~ 1 ~ 1").release(0.25).gain(0.27).room(0.7).delay(0.55).pan(0.42)
)
```
