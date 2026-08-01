---
genre: italo-disco
bpm: [118, 122]
swing: 0
scales: [a minor]
key_sounds: [bd, sd, hh, sawtooth, supersaw, wt_lead]
signature: four-on-floor, octave synth bass, mirrored arpeggio hook
---

<!-- Generated from a GenreSpec by `cargo run -p gen-recipes`. Do not edit here — change crates/cycletron-gen/src/spec.rs (or genres.rs) and regenerate. A hand-written recipe of the same name overrides this one. -->

Italo disco — four-on-floor, octave synth bass, mirrored arpeggio hook. Tempo 118–122 BPM in a minor. This skeleton is composed straight from the genre spec (aligned drum grid, in-key bass, diatonic chords, a generated lead), round-trip verified so it always parses and plays. Use it as a seed: lift the parts you want, then layer and edit.

## Full skeleton

```strudel
// italo disco in A minor (generated) — four-on-floor, octave synth bass, mirrored arpeggio hook
setbpm(120);

stack(
  s("bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~ hh ~").gain(0.9).every(4, x => x.fast(2)),
  note("a2 ~ a3 ~ a2 ~ a3 ~").s("sawtooth").lpf(800).resonance(7).gain(0.5),
  note("<[a3, c4, e4, g4] [f4, a4, c5, e5] [g4, b4, d5, f5] [e4, g4, b4, d5]>").s("supersaw").struct("~ 1 ~ 1").release(0.2).lpf(2200).gain(0.34).room(0.35).pan(0.42),
  note("a4 c5 e5 c5").s("wt_lead").delay(0.3).room(0.35).gain(0.32).pan(0.62)
)
```
