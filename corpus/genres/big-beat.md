---
genre: big-beat
aliases: [bigbeat, chemical beats, 90s big beat]
bpm: [118, 135]
swing: 0.0
scales: [mixolydian, minor, major pentatonic]
key_sounds: [bd, sd, hh, cp, sawtooth, supersaw, white]
signature: Mid-tempo heavy breakbeats (~120–130 BPM) with distorted punch, riffy octave bass, and blaring sample-style stabs — Fatboy Slim / Chemical Brothers / Prodigy energy, not four-on-floor house and not 174 DnB.
artists: [Fatboy Slim, The Chemical Brothers, The Prodigy, The Crystal Method, Propellerheads]
sources:
  - "https://en.wikipedia.org/wiki/Big_beat"
  - "DKF vault L3 research + local electronic_strudel Fatboy Slim/Prodigy idiom mine (structure only)"
  - "hand-authored upgrade of GenreSpec stub — validated via corpus-check"
---

Big beat is *break* music at mid-tempo: rock-weight drums, sample/riff hooks, and
loud compressed energy for clubs *and* charts. Keep BPM around 120–130 (wider
110–140). Prefer airy break grids over house `bd*4`, and riff bass over DnB reese
morphs. A little `.dist` on the drums sells the "big" production.

## Driven break core

Sparse kicks, snare chatter on the backbeat side, hats filling the air — not a
straight four-floor jack.

```strudel
setbpm(128);
stack(
  s("bd ~ ~ bd ~ ~ bd ~").gain(0.9),
  s("~ ~ sd ~ ~ sd ~ sd").gain(0.7),
  s("hh*8").gain(0.28)
).dist(0.12)
```

## Octave bass riff

Simple rock/funk-style bass under the break — root and octave, locked to the
groove rather than a filter-growl reese.

```strudel
setbpm(128);
note("e2 ~ e3 ~ e2 e3 ~ e2").s("sawtooth")
  .lpf(800).resonance(6).gain(0.42)
```

## Blaring stab hook

Short, loud mid stabs — the "sample hit" stand-in when you only have synths.

```strudel
setbpm(128);
note("<e3 g3 b3 e4>").s("supersaw")
  .struct("1 ~ ~ 1 ~ ~ 1 ~").decay(0.14).sustain(0)
  .lpf(2400).dist(0.25).gain(0.38).room(0.2)
```

## Noise fill (optional)

A short noise burst for big-beat drama between phrases.

```strudel
setbpm(128);
stack(
  s("bd ~ ~ bd ~ ~ bd ~").gain(0.85),
  s("white*4").decay(0.05).sustain(0).gain(0.12)
)
```

## Full skeleton

Break + octave bass + stab hook. Drop stabs and pull dist for a breakdown; smash
drums with more dist and open the stab filter for the drop.

```strudel
setbpm(128);
stack(
  s("bd ~ ~ bd ~ ~ bd ~, ~ ~ sd ~ ~ sd ~ sd, hh*8").gain(0.75).dist(0.14),
  note("e2 ~ e3 ~ e2 e3 ~ e2").s("sawtooth").lpf(850).resonance(6).gain(0.4),
  note("<e3 g3 b3 e4>").s("supersaw").struct("1 ~ ~ 1 ~ ~ 1 ~").decay(0.14).sustain(0).lpf(2400).dist(0.22).gain(0.35).room(0.18)
)
```
