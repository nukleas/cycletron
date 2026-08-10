---
genre: french-house
bpm: [121, 125]
swing: 0
scales: [f dorian]
key_sounds: [bd, sd, hh, sawtooth]
signature: four-on-floor, filtered stab loop, pumping offbeat bass
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

French house — four-on-floor, filtered stab loop, pumping offbeat bass. Tempo 121–125 BPM in f dorian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// French house in F dorian (generated) — four-on-floor, filtered stab loop, pumping offbeat bass
setbpm(123);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, hh*16").gain(0.67).every(4, x => x.fast(2)),
  note("~ f2 ~ f2 ~ f2 ~ f3").s("sawtooth").lpf(600).resonance(6).gain(0.37),
  note("<[f3, g#3, c4, d#4] [a#3, d4, f4, g#4] [c4, d#4, g4, a#4] [a#3, d4, f4, g#4]>").s("sawtooth").struct("1 ~ 1 ~").release(0.18).lpf(1200).gain(0.28).room(0.3).pan(0.42)
)
```
