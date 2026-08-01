---
genre: ambient
aliases: [downtempo, drone, dark ambient, new age, ambient techno]
bpm: [50, 68]
swing: 0.0
scales: [major, lydian, minor, dorian]
key_sounds: [sine, sawtooth, gm_pad_warm, gm_kalimba, wt_piano, wt_pad]
signature: Slow, spacious, and evolving — long-attack pad chords over a sustained drone, sparse bell or piano notes, everything drenched in reverb. Little or no percussion. (Brian Eno, Stars of the Lid, Biosphere.)
artists: [Brian Eno, Stars of the Lid, Biosphere, Aphex Twin, Tim Hecker]
sources:
  - "https://en.wikipedia.org/wiki/Ambient_music"
  - "strudel.cc bakery corpus (long-envelope pad / drone patterns) — distilled to strudel-rs"
---

Ambient is about space and time, not rhythm. Slow the tempo right down and let a
long-attack pad chord swell in and out — the notes fade *up*, hold, and decay
rather than being struck. Underneath sits a deep sustained drone (a root, maybe a
fifth) that never really stops. On top, a few sparse bell or piano notes drift by,
soaked in reverb and delay. Keep harmony consonant (major/lydian for warmth, minor
for unease), and change chords slowly — one per two bars or more. Percussion is
optional and, if present, distant and soft.

## Long-attack pad

The core move: a chord whose voices fade in over seconds. `attack`/`release` are
the whole sound; keep the filter low and the room big.

```strudel
setbpm(58);
chord("<Cmaj7 Fmaj7>").voicing().s("sawtooth")
  .attack(2).release(4).lpf(1100).gain(0.4).room(0.8)
```

## Sustained drone

A deep root that swells and never fully stops — the floor everything else rests on.

```strudel
setbpm(58);
note("<c2 c2 g1 c2>").s("sine")
  .attack(3).release(5).gain(0.5)
```

## Sparse bell melody

A few notes drifting through the space, with gaps, reverb, and delay for trails.

```strudel
setbpm(58);
note("c5 ~ ~ g4 ~ ~ e5 ~").s("gm_kalimba")
  .room(0.7).delay(0.4).gain(0.4)
```

## Full skeleton

Drone + slow pad + drifting bells. No drums. Let chords change every two bars for a
long, breathing feel.

```strudel
setbpm(58);
stack(
  note("<c2 c2 g1 c2>").s("sine").attack(3).release(5).gain(0.45),
  chord("<Cmaj7 Fmaj7 Am7 Gmaj7>/2").voicing().s("sawtooth").attack(2).release(4).lpf(1000).gain(0.35).room(0.85),
  note("c5 ~ ~ g4 ~ ~ e5 ~").s("gm_kalimba").room(0.7).delay(0.4).gain(0.35)
)
```
