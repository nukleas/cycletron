---
genre: synthwave
aliases: [synth-pop, synthpop, dark pop, retrowave, 80s, the weeknd, outrun]
bpm: [80, 118]
swing: 0.0
scales: [minor, harmonic minor, dorian]
key_sounds: [supersaw, sawtooth, pulse, bd, sd, cp]
signature: Neon 80s synth-pop — gated-reverb drums, a lush detuned-saw pad, a bright plucky arpeggio, and a punchy synth bass, in a minor key drenched in reverb and chorus. (The Weeknd — After Hours / Dawn FM; Kavinsky.)
artists: [The Weeknd, Kavinsky, The Midnight, a-ha, Gunship]
sources:
  - "https://en.wikipedia.org/wiki/Synthwave"
  - "hand-authored exemplar — to be expanded by /research-genre"
---

Synthwave is a *production aesthetic* as much as a genre: big gated-reverb
snares, warm detuned-saw pads, glassy plucks with dotted-eighth delay, and a
round synth bass — all minor-key and nostalgic. The Weeknd's modern take keeps
that palette but adds pop hooks and tight, punchy drums. Sit around 100 BPM (or
half-time over a faster grid), reach for reverb and chorus liberally, and let
the arpeggio + pad carry the emotion while the bass stays simple.

## Gated-reverb backbeat

Four-on-the-floor kick, a big reverberant snare on the backbeat (the gated-verb
sound), and panned hats for width.

```strudel
setbpm(100);
stack(
  s("bd*4").gain(0.9),
  s("~ sd ~ sd").room(0.5).roomsize(0.7).gain(0.7),
  s("hh*8").gain(0.22).pan(sine.range(0.35, 0.65))
)
```

## Lush detuned-saw pad

The warm bed: a supersaw chord pad with a slow attack, chorus, and reverb.

```strudel
setbpm(100);
chord("<Am F C G>").voicing().s("supersaw")
  .lpf(1600).attack(0.4).release(0.9).chorus(0.4).room(0.5).gain(0.32)
```

## Glassy pluck arpeggio

Bright pluck with a dotted-eighth delay — the hook that says "1984".

```strudel
setbpm(100);
note("a4 c5 e5 c5").fast(2).s("pulse")
  .decay(0.15).sustain(0.1)
  .delay(0.3).delaytime(0.375).room(0.3).gain(0.4)
```

## Punchy synth bass

Round, simple, sitting just under the kick.

```strudel
setbpm(100);
note("a1 a1 a1 a1").s("sawtooth").lpf(600).decay(0.2).sustain(0.3).gain(0.6)
```

## Full skeleton

Drums + pad + arp + bass — the whole neon picture.

```strudel
setbpm(100);
stack(
  s("bd*4").gain(0.9),
  s("~ sd ~ sd").room(0.5).roomsize(0.7).gain(0.65),
  s("hh*8").gain(0.2).pan(sine.range(0.35, 0.65)),
  chord("<Am F C G>").voicing().s("supersaw").lpf(1500).attack(0.4).release(0.9).chorus(0.4).room(0.5).gain(0.28),
  note("a4 c5 e5 c5").fast(2).s("pulse").decay(0.15).sustain(0.1).delay(0.3).room(0.3).gain(0.32),
  note("a1 a1 a1 a1").s("sawtooth").lpf(600).decay(0.2).sustain(0.3).gain(0.55)
)
```
