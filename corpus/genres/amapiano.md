---
genre: amapiano
bpm: [110, 115]
swing: 0
scales: [f# minor]
key_sounds: [bd, sd, hh, sine, gm_epiano1, wt_pluck]
signature: log drum bounce, soft claps, glassy keys over quiet sub
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Amapiano — log drum bounce, soft claps, glassy keys over quiet sub. Tempo 110–115 BPM in f# minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// amapiano in F# minor (generated) — log drum bounce, soft claps, glassy keys over quiet sub
setbpm(112);

stack(
  s("~ ~ ~ lt ~ ~ lt ~ ~ ~ lt ~ ~ ~ lt ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~").gain(0.9).every(4, x => x.fast(2)),
  note("f#1 ~ ~ ~ ~ ~ ~ ~ ~ ~ f#1 ~ ~ ~ ~ ~").s("sine").attack(0.03).release(0.6).gain(0.52),
  note("<[f#3, a3, c#4, e4] [b3, d4, f#4, a4] [c#4, e4, g#4, b4] [b3, d4, f#4, a4]>").s("gm_epiano1").release(0.5).gain(0.38).room(0.45).pan(0.42),
  note("<[f#5 ~ ~ c#6 ~ ~ b5 ~] [f#5 ~ ~ c#6 ~ ~ b5 ~] [a5 ~ ~ e6 ~ ~ d6 ~] [b5 ~ ~ c#6 ~ ~ a5 ~]>").s("wt_pluck").delay(0.3).room(0.4).gain(0.3).pan(0.62)
)
```
