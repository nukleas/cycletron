---
genre: GENRE-NAME
aliases: [alias-one, alias-two]
bpm: [LOW, HIGH]
swing: 0.0
scales: [scale-one, scale-two]
key_sounds: [sound, sound, sound]
signature: One sentence capturing the defining sound. (Reference artists.)
artists: [Artist One, Artist Two]
sources:
  - "https://..."
  - "hand-authored / dataset / other — note provenance"
---

Intro prose: the core idea of the genre and what makes it work. What does the
listener latch onto? What's the one thing to get right?

## Drum core

What the kit and groove are, and why.

```strudel
setbpm(TEMPO);
stack(
  s("bd*4").gain(0.9)
)
```

## Bass

Sound design + register + relationship to the kick.

```strudel
setbpm(TEMPO);
note("c2 c2 c2 c2").s("sawtooth").lpf(800).decay(0.15).sustain(0.3).gain(0.55)
```

## Chords / pad

Scales, voicings, and how static vs. active the harmony is.

```strudel
setbpm(TEMPO);
chord("<Am F C G>").voicing().s("supersaw").lpf(1600).attack(0.3).release(0.7).gain(0.35)
```

## Lead / arp

Motifs, range, ornamentation.

```strudel
setbpm(TEMPO);
note("a4 c5 e5 c5").fast(2).s("pulse").decay(0.12).sustain(0.15).delay(0.25).gain(0.4)
```

## Full skeleton

Everything together — the starting point a user can play and build from.

```strudel
setbpm(TEMPO);
stack(
  s("bd*4").gain(0.9)
)
```
