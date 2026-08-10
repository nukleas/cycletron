---
genre: acid-techno
aliases: [acid, acid techno, acid house]
bpm: [130, 150]
swing: 0.0
scales: [phrygian, minor, harmonic minor]
key_sounds: [sawtooth, bd, cp, hh, oh]
signature: A squelching, resonant TB-303 line over a relentless four-on-the-floor, driven by filter and resonance movement rather than chord changes.
artists: [Hardfloor, Plastikman, Josh Wink, Luke Vibert, DJ Pierre]
sources:
  - "https://en.wikipedia.org/wiki/Acid_techno"
  - "https://en.wikipedia.org/wiki/Roland_TB-303"
  - "hand-authored exemplar — to be expanded by /research-genre"
---

Acid is a *timbre-first* genre: the hook is not a melody or a chord progression
but the movement of a low-pass filter's cutoff and resonance across a looping
bassline. Hold the notes nearly static and let `lpf` + `resonance` do the work.
Keep it dark (phrygian/minor), keep it driving (straight 16ths, no swing), and
let tension build over 4–8 bars by opening the filter.

## Drum core

Straight four-on-the-floor with an offbeat open hat — the techno backbone. Claps
on 2 and 4, a dense closed-hat grid underneath.

```strudel
setbpm(140);
stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").gain(0.6),
  s("hh*16").gain(0.32).hpf(7000),
  s("~ ~ oh ~").gain(0.4)
)
```

## The 303 line

The heart of acid. A near-static low note repeated in 16ths, with the cutoff
swept by a slow `sine` and the resonance cranked. The slow filter LFO is what
makes it "talk".

```strudel
setbpm(140);
note("c2*16").s("sawtooth")
  .lpf(sine.range(300, 2200).slow(8))
  .resonance(18)
  .decay(0.18).sustain(0.1)
  .gain(0.7)
```

## Acid with accents and octave jumps

Real 303 lines aren't static — they jump octaves and walk the phrygian scale.
Accent some steps louder and let the filter envelope bite on the loud ones.

```strudel
setbpm(140);
note("c2 c2 c3 eb2 c2 g2 c2 db3").fast(2)
  .s("sawtooth")
  .lpf(saw.range(400, 2600).slow(4))
  .resonance(15)
  .decay(0.14).sustain(0.15)
  .gain("0.8 0.5")
```

## Full skeleton

Drums + 303 + a sparse offbeat stab. Mute and unmute layers across the
arrangement; let the 303 filter open as the energy builds.

```strudel
setbpm(140);
stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").gain(0.55),
  s("hh*16").gain(0.3).hpf(7000),
  note("c2*16").s("sawtooth")
    .lpf(sine.range(350, 2400).slow(8)).resonance(17)
    .decay(0.16).sustain(0.1).gain(0.6),
  note("~ eb3 ~ ~").s("sawtooth").lpf(1800).resonance(8)
    .decay(0.2).gain(0.4)
)
```
