---
genre: techno
aliases: [detroit techno, minimal techno, peak time techno]
bpm: [125, 140]
swing: 0.0
scales: [phrygian, minor]
key_sounds: [bd, cp, hh, sawtooth, white]
signature: Mechanical four-on-the-floor at ~128–135 BPM — relentless kick, ticking hats, sparse claps, driving filtered bass, and slow timbral motion rather than house-style soulful 7th stabs. (Detroit → Berlin continuum.)
artists: [Juan Atkins, Derrick May, Kevin Saunderson, Jeff Mills, Richie Hawtin, Robert Hood]
sources:
  - "https://en.wikipedia.org/wiki/Techno"
  - "DKF vault L3 research notes (house vs techno contrast) — distilled to strudel-rs"
  - "hand-authored upgrade of GenreSpec stub — validated via corpus-check"
---

Techno keeps the four-on-the-floor kick that house uses, but the *feel* is more
mechanical and loop-first: fewer warm chords, more functional bass, hats that
tick like a machine, and optional tom/euclid motion for hypnosis. Sit slightly
faster/harder than deep house (often 128–135; wider 120–150). Build energy by
opening the bass filter and adding hat density — not by swinging the groove.

## Four-on-the-floor core

Relentless kick, clap on the backbeat, offbeat closed hats. Keep the groove taut
and machine-like, with less open-hat lift than a disco-forward pattern.

```strudel
setbpm(130);
stack(
  s("bd*4").gain(0.95),
  s("~ cp ~ cp").gain(0.45),
  s("hh*8").gain(0.28)
)
```

## Driving bass

On-grid and filtered — functional low end under the kick, not house offbeat
syncopation. A slow resonant sweep is the build tool.

```strudel
setbpm(130);
note("c2 c2 c2 c2").s("sawtooth")
  .lpf(sine.range(200, 900).slow(4)).resonance(10)
  .gain(0.4)
```

## Optional low-gain tom accent

A sparse tom can add a little asymmetry, but it is an accent rather than the
genre's signature. Keep it quiet, or omit it and let the hats and filter sweep
carry the hypnosis.

```strudel
setbpm(130);
stack(
  s("bd*4").gain(0.9),
  s("mt(3,8)").gain(0.14)
)
```

## Sparse stab (optional color)

One dark stab every other hit — not a house chord bed. Use voicing if you expand
to chords; a monophonic stab is fine and safer.

```strudel
setbpm(130);
note("<c3 ~ g2 ~>").s("sawtooth")
  .lpf(1600).decay(0.12).sustain(0).gain(0.28).room(0.15)
```

## Full skeleton

Kick grid + driving bass + a sparse stab. Add the low-gain tom accent above only
when the hats and filter sweep need more motion; close the LPF for a breakdown
and double the hats for the peak.

```strudel
setbpm(130);
stack(
  s("bd*4").gain(0.95),
  s("~ cp ~ cp").gain(0.4),
  s("hh*8").gain(0.26),
  note("c2 c2 c2 c2").s("sawtooth").lpf(sine.range(220, 1000).slow(4)).resonance(10).gain(0.38),
  note("<c3 ~ g2 ~>").s("sawtooth").lpf(1600).decay(0.12).sustain(0).gain(0.25).room(0.12)
)
```
