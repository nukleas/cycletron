---
genre: trip-hop
bpm: [85, 92]
swing: 0.35
scales: [c# minor]
key_sounds: [bd, sd, hh, sine, gm_epiano1, wt_flute]
signature: dragging boom-bap, sub weight, noir Rhodes
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Trip-hop — dragging boom-bap, sub weight, noir Rhodes. Tempo 85–92 BPM in c# minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// trip-hop in C# minor (generated) — dragging boom-bap, sub weight, noir Rhodes
setbpm(88);

stack(
  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~").gain(0.85).crush(9).every(4, x => x.fast(2)),
  s("~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~ ~ ~ hh ~").late(0.0219).gain(0.85).crush(9),
  note("c#1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c#1 ~ ~ ~ ~ ~").s("sine").attack(0.02).release(0.6).gain(0.55),
  note("<[c#3, e3, g#3, b3] [a3, c#4, e4, g#4] [f#3, a3, c#4, e4] [a3, c#4, e4, g#4]>").s("gm_epiano1").release(0.5).gain(0.38).room(0.45).pan(0.42),
  note("<[g#4 ~ c#5 ~ f#5 ~ e5 ~] [g#4 ~ c#5 ~ f#5 ~ e5 ~] [b4 ~ e5 ~ a5 ~ g#5 ~] [e5 ~ e5 ~ e5 ~ b4 ~]>").s("wt_flute").room(0.4).delay(0.3).gain(0.28).pan(0.62)
)
```
