---
genre: psytrance
bpm: [142, 148]
swing: 0
scales: [f# phrygian]
key_sounds: [bd, sd, hh, sawtooth, wt_lead]
signature: four-on-floor with the rolling offbeat psy bass engine
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Psytrance — four-on-floor with the rolling offbeat psy bass engine. Tempo 142–148 BPM in f# phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// psytrance in F# phrygian (generated) — four-on-floor with the rolling offbeat psy bass engine
setbpm(145);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh").gain(0.81).every(4, x => x.fast(2)),
  note("f#2 ~ f#2 ~ f#2 ~ f#2 ~ f#2 ~ f#2 g2 f#2 ~ f#2 ~").s("sawtooth").lpf(650).resonance(10).gain(0.47),
  note("<[f#3, a3, c#4, e4] [g3, b3, d4, f#4]>").s("sawtooth").struct("~ ~ ~ 1").release(0.12).lpf(1800).gain(0.23).room(0.3).pan(0.42),
  note("<[f#5 ~ ~ ~ e6 ~ ~ ~] [f#5 ~ ~ ~ e6 ~ ~ ~] [a5 ~ ~ ~ g6 ~ ~ ~] [d6 ~ ~ ~ d6 ~ ~ ~]>").s("wt_lead").delay(0.25).room(0.35).gain(0.25).pan(0.62)
)
```
