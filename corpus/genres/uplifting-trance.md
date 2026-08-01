---
genre: uplifting-trance
bpm: [136, 140]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, sawtooth, supersaw, wt_lead]
signature: four-on-floor, rolling 16th bass, supersaw lift, gated arp
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Uplifting trance — four-on-floor, rolling 16th bass, supersaw lift, gated arp. Tempo 136–140 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// uplifting trance in A minor (generated) — four-on-floor, rolling 16th bass, supersaw lift, gated arp
setbpm(138);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~ ~ ~ oh ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, hh*16").gain(0.45).every(4, x => x.fast(2)),
  note("a2 ~ a2 ~ a2 ~ a2 ~ a2 ~ a2 b2 a2 ~ a2 ~").s("sawtooth").lpf(700).resonance(5).gain(0.24),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5] [d4, f4, a4, c5] [g4, b4, d5, f5]>").s("supersaw").struct("~ 1 ~ 1").release(0.2).lpf(2400).gain(0.18).room(0.4).pan(0.42),
  note("a4 c5 e5 a5").s("wt_lead").delay(0.35).room(0.4).gain(0.17).pan(0.62)
)
```
