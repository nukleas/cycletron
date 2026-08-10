---
genre: liquid-dnb
aliases: [liquid]
bpm: [172, 176]
swing: 0
scales: [e minor]
key_sounds: [bd, sd, hh, sine, gm_epiano1, wt_flute]
signature: two-step break, deep sub, Rhodes wash, floating lead
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Liquid drum & bass — two-step break, deep sub, Rhodes wash, floating lead. Tempo 172–176 BPM in e minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// liquid drum & bass in E minor (generated) — two-step break, deep sub, Rhodes wash, floating lead
setbpm(174);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh*16").gain(0.64).every(4, x => x.fast(2)),
  note("e1 ~ ~ ~ ~ ~ ~ ~ ~ ~ e1 ~ ~ ~ ~ ~").s("sine").attack(0.02).release(0.5).gain(0.41),
  note("<[e3, g3, b3, d4] [a3, c4, e4, g4] [c4, e4, g4, b4] [b3, d4, f#4, a4]>").s("gm_epiano1").release(0.5).gain(0.27).room(0.5).pan(0.42),
  note("<[e5 ~ ~ ~ c6 ~ ~ ~] [e5 ~ ~ ~ c6 ~ ~ ~] [g5 ~ ~ ~ e6 ~ ~ ~] [b5 ~ ~ ~ c6 ~ ~ ~]>").s("wt_flute").delay(0.35).room(0.5).gain(0.21).pan(0.62)
)
```
