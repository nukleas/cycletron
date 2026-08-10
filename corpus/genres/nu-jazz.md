---
genre: nu-jazz
bpm: [105, 115]
swing: 0.3
scales: [d dorian]
key_sounds: [bd, sd, hh, gm_acoustic_bass, gm_epiano1, wt_trumpet]
signature: swung beat, walking bass, extended Rhodes voicings
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Nu-jazz — swung beat, walking bass, extended Rhodes voicings. Tempo 105–115 BPM in d dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// nu-jazz in D dorian (generated) — swung beat, walking bass, extended Rhodes voicings
setbpm(110);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.71).every(4, x => x.fast(2)),
  s("~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").late(0.0094).gain(0.71),
  note("d2 ~ a2 ~ d2 ~ c3 ~").s("gm_acoustic_bass").gain(0.5),
  note("<[d3, f3, a3, c4] [g3, b3, d4, f4] [e3, g3, b3, d4] [a3, c4, e4, g4]>").s("gm_epiano1").release(0.45).gain(0.35).room(0.35).pan(0.42),
  note("<[a4 ~ d5 ~ g5 ~ f5 ~] [a4 ~ d5 ~ g5 ~ f5 ~] [c5 ~ f5 ~ b5 ~ a5 ~] [f5 ~ f5 ~ f5 ~ c5 ~]>").s("wt_trumpet").room(0.35).delay(0.2).gain(0.24).pan(0.62)
)
```
