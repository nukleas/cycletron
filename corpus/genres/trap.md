---
genre: trap
bpm: [138, 142]
swing: 0
scales: [c# phrygian]
key_sounds: [bd, sd, hh, sine, wt_pad]
signature: half-time 808s, hat rolls, cold two-chord loop
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Trap — half-time 808s, hat rolls, cold two-chord loop. Tempo 138–142 BPM in c# phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// trap in C# phrygian (generated) — half-time 808s, hat rolls, cold two-chord loop
setbpm(140);

stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~, ~ ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~, ~ ~ ~ ~ ~ ~ ~ hh*3 ~ ~ ~ ~ ~ ~ ~ hh*4").gain(0.78).every(4, x => x.fast(2)),
  note("c#1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c#1 ~ ~ ~ ~ ~").s("sine").attack(0.01).release(0.8).gain(0.51),
  note("<[c#3, e3, g#3, b3] [d3, f#3, a3, c#4]>").s("wt_pad").attack(0.5).release(1.2).lpf(1000).gain(0.25).room(0.5).pan(0.42)
)
```
