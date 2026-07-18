---
genre: house
aliases: [deep house, tech house, acid house, disco house, garage house]
bpm: [120, 126]
swing: 0.08
scales: [minor, dorian, minor pentatonic]
key_sounds: [bd, cp, oh, hh, sawtooth, sine, piano, gm_organ]
signature: Four-on-the-floor kick with offbeat open hats, a backbeat clap, deep rolling bass, and stabbed 7th chords at ~122–126 BPM. (Chicago/deep house — Frankie Knuckles, Larry Heard, Kerri Chandler.)
artists: [Frankie Knuckles, Larry Heard, Kerri Chandler, Daft Punk, Disclosure]
sources:
  - "https://en.wikipedia.org/wiki/House_music"
  - "strudel.cc bakery corpus (deep-house / tech-house patterns) — distilled to strudel-rs"
---

House is built on the four-on-the-floor: a kick on every beat, an open hat lifting
each offbeat (the "tsss" between kicks), and a clap on the backbeat (2 and 4). That
grid is the whole genre's pulse — everything else swings around it. Underneath sits
a deep, rolling bass that plays *between* the kicks, and on top, short stabbed 7th
chords (piano or a filtered saw) that hit the offbeats. Keep it minor or dorian,
add a touch of swing, and let a slowly opening filter carry the energy.

## Four-on-the-floor core

Kick every beat, open hat on every offbeat, clap on the backbeat, ticking closed
hats. This single stack already reads as "house".

```strudel
setbpm(122);
stack(
  s("bd*4").gain(0.9),
  s("[~ oh]*4").gain(0.4),
  s("~ cp ~ cp").gain(0.6),
  s("hh*8").gain(0.22)
)
```

## Deep rolling bass

The bass lives in the gaps between kicks — offbeat notes on the root, filtered low
and round. This is what makes house *move*.

```strudel
setbpm(122);
note("~ a1 ~ a1 ~ a1 ~ a2").s("sawtooth")
  .lpf(500).resonance(6).gain(0.5)
```

## Stabbed chords

Short minor-7th stabs on the offbeats — the classic deep-house "chord organ" hit.
`chord(...).voicing()` expands the symbols; the `struct` places the stabs.

```strudel
setbpm(122);
chord("<Am7 Dm7 Em7 Am7>").voicing().s("sawtooth")
  .struct("~ 1 ~ 1").release(0.16).lpf(1900).gain(0.5).room(0.3)
```

## Full skeleton

Four-on-the-floor + rolling bass + chord stabs. Drop the chords for a stripped
section, sweep the bass filter up to build, and bring the stabs back for the lift.

```strudel
setbpm(122);
stack(
  s("bd*4").gain(0.9),
  s("[~ oh]*4").gain(0.38),
  s("~ cp ~ cp").gain(0.55),
  s("hh*8").gain(0.2),
  note("~ a1 ~ a1 ~ a1 ~ a2").s("sawtooth").lpf(sine.range(400, 1200).slow(8)).resonance(6).gain(0.5),
  chord("<Am7 Dm7 Em7 Am7>").voicing().s("sawtooth").struct("~ 1 ~ 1").release(0.16).lpf(1900).gain(0.42).room(0.3)
)
```
