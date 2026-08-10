---
genre: berlin-school
bpm: [100, 120]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, sawtooth, wt_strings, triangle]
signature: beatless sequencer pulse, deep pads, eight-step arp orbit
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Berlin school — beatless sequencer pulse, deep pads, eight-step arp orbit. Tempo 100–120 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// Berlin school in A minor (generated) — beatless sequencer pulse, deep pads, eight-step arp orbit
setbpm(110);

stack(
  note("a2 ~ a2 ~ a2 ~ a2 ~ a2 ~ a2 b2 a2 ~ a2 ~").s("sawtooth").lpf(600).resonance(6).gain(0.42),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5] [d4, f4, a4, c5] [g4, b4, d5, f5]>").s("wt_strings").attack(2).release(4).lpf(1200).gain(0.3).room(0.8).pan(0.42),
  note("a4 c5 e5 a5 a5 c6 e6 a6").s("triangle").delay(0.4).room(0.5).gain(0.32).pan(0.62)
)
```
