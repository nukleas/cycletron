---
genre: drum-and-bass
aliases: [dnb, d&b, neurofunk, jungle, liquid dnb, pendulum]
bpm: [170, 176]
swing: 0.0
scales: [minor, phrygian, harmonic minor]
key_sounds: [supersaw, sawtooth, bd, sd, hh, white]
signature: High-energy drum & bass — a fast two-step breakbeat at 170+ BPM (kick and snare in a half-time feel over a 16th grid), a growling detuned "reese" bass, and aggressive synth stabs. (Pendulum's electronic-rock end of DnB; Noisia.)
artists: [Pendulum, Noisia, Sub Focus, Netsky, High Contrast]
sources:
  - "https://en.wikipedia.org/wiki/Drum_and_bass"
  - "hand-authored exemplar — to be expanded by /research-genre"
---

DnB lives at ~174 BPM but *feels* slower because the kick and snare lock into a
half-time backbeat (kick on 1 and the "&" of 3, snare on 2 and 4) while the hats
and breaks rattle along at full 16th speed. The low end is the other half: a
"reese" bass — detuned saws run through a moving low-pass with resonance — that
growls and morphs. Keep it minor and dark; Pendulum adds rock aggression with
distorted stabs and big drops. Build energy by opening the reese filter and
adding break complexity, then drop to half-time for impact.

## The two-step break

The canonical DnB skeleton on a 16-step bar: kick on 1 and 11, snare on 5 and 13
(beats 2 and 4), fast hats underneath.

```strudel
setbpm(174);
stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~").gain(0.95),
  s("~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.8),
  s("hh*16").gain(0.25)
)
```

## Reese bass

Detuned saws (supersaw) through a slow resonant filter sweep — the growl that
defines the genre. Give it a rhythm so it pumps with the break.

```strudel
setbpm(174);
note("e1 ~ e1 e1").s("supersaw")
  .lpf(sine.range(180, 1300).slow(2)).resonance(11)
  .gain(0.5)
```

## Aggressive stab

A short, distorted minor stab for the neurofunk/rock edge — moves once per cycle.

```strudel
setbpm(174);
note("<e3 b2 g3 e3>").s("supersaw")
  .lpf(2200).dist(0.4).decay(0.18).sustain(0).gain(0.4)
```

## Full skeleton

Break + reese + stab. Drop the hats and stab for a half-time section, then bring
them back for the lift.

```strudel
setbpm(174);
stack(
  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~").gain(0.95),
  s("~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.8),
  s("hh*16").gain(0.22),
  note("e1 ~ e1 e1").s("supersaw").lpf(sine.range(180, 1300).slow(2)).resonance(11).gain(0.45),
  note("<e3 b2 g3 e3>").s("supersaw").lpf(2200).dist(0.35).decay(0.18).sustain(0).gain(0.35)
)
```
