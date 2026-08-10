---
genre: psybient
bpm: [95, 105]
swing: 0
scales: [e phrygian]
key_sounds: [bd, sd, hh, sine, wt_pad, wt_bell]
signature: soft pulse, drifting drone, phrygian bell trails
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Psybient — soft pulse, drifting drone, phrygian bell trails. Tempo 95–105 BPM in e phrygian. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// psybient in E phrygian (generated) — soft pulse, drifting drone, phrygian bell trails
setbpm(100);

stack(
  s("hh ~ ~ ~ ~ ~ ~ ~ hh ~ ~ ~ ~ ~ ~ ~").gain(0.25).room(0.6).every(4, x => x.fast(2)),
  note("e2").s("sine").attack(2.5).release(4).gain(0.45),
  note("<[e3, g3, b3, d4] [f3, a3, c4, e4] [e3, g3, b3, d4] [c4, e4, g4, b4]>").s("wt_pad").attack(2).release(4).lpf(1100).gain(0.3).room(0.85).pan(0.42),
  note("<[e5 ~ ~ c6 ~ ~ b5 ~] [e5 ~ ~ c6 ~ ~ b5 ~] [g5 ~ ~ e6 ~ ~ d6 ~] [b5 ~ ~ c6 ~ ~ g5 ~]>").s("wt_bell").room(0.8).delay(0.5).gain(0.28).pan(0.62)
)
```
