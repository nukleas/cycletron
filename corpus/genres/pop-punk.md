---
genre: pop-punk
aliases: [pop punk, skate punk, punk rock, pop-punk]
bpm: [150, 190]
swing: 0.0
scales: [major, major pentatonic, mixolydian]
key_sounds: [supersaw, sawtooth, square, bd, sd, hh, cr]
signature: Fast, bright, distorted power chords over a driving punk backbeat, with a catchy major-key vocal hook. Punk energy, pop songcraft. (blink-182, Green Day, Sum 41.)
artists: [blink-182, Green Day, Sum 41, The Offspring, Fall Out Boy, Paramore, New Found Glory]
sources:
  - "https://en.wikipedia.org/wiki/Pop-punk"
  - "https://etzcorn.com/genres/pop-punk"
  - "https://www.drumeo.com/beat/a-drummers-guide-to-punk/"
  - "ingested reference: blink-182, Green Day, The Offspring (clean_midi, 150–192 bpm)"
---

Pop punk is punk's speed and power chords welded to pop's hooks: fast (≈150–190
BPM), bright major keys, distorted downstroke guitars, and a relentless
backbeat. There are no real guitars in strudel-rs, so the whole craft is
*translation*: power chords become distorted note-stacks (root + fifth +
octave, no third), the "wall" comes from `supersaw` + `dist`, and the punk
chug comes from `ply` (eighth-note downstrokes). Harmony stays simple — the
genre lives on the I–V–vi–IV / I–V–IV progressions. Energy is dynamics: a
palm-muted verse that bursts into wide-open power chords on the chorus.

## Drum core

A driving punk backbeat: kick pushing the beats, snare on 2 and 4, straight
eighth hats, and a crash accent on the downbeat. Fast.

```strudel
setbpm(172);
stack(
  s("bd ~ bd bd ~ ~ bd ~").gain(0.9),
  s("~ ~ sd ~ ~ ~ sd ~").gain(0.82),
  s("hh*8").gain(0.34),
  s("cr ~ ~ ~").gain(0.4)
)
```

## Bass — pumping eighths

Root-following, semi-dirty, hammering eighth notes. `ply(8)` holds each chord's
root for a bar while pumping it eight times; the root changes per bar through
the progression (E–B–C#m–A = I–V–vi–IV in E).

```strudel
setbpm(172);
note("<e2 b1 c#2 a1>").ply(8)
  .s("sawtooth").dist(0.15).lpf(1300)
  .decay(0.1).sustain(0.4).gain(0.5)
```

## Power chords (chugging downstrokes)

The defining sound. Power chords = root + fifth + octave (no third — that's why
they sit over both major and minor), strummed as eighth-note downstrokes via
`ply(8)`, through a distorted supersaw "amp".

```strudel
setbpm(172);
note("<[e2,b2,e3] [b1,f#2,b2] [c#2,g#2,c#3] [a1,e2,a2]>").ply(8)
  .s("supersaw").dist(0.35).lpf(2600)
  .attack(0.004).decay(0.12).sustain(0.4).gain(0.36)
```

## Palm-muted verse

The dynamic foil to the chorus: a tight, dark, single-note chug on the root —
short envelope, low cutoff — so the open chorus chords hit harder by contrast.

```strudel
setbpm(172);
note("e2*8").s("supersaw").dist(0.3).lpf(900)
  .decay(0.045).sustain(0.0).gain(0.45)
```

## Lead / vocal hook

A bright, singable major-pentatonic line standing in for the vocal — square wave
for bite, a touch of room.

```strudel
setbpm(172);
note("e4 b4 g#4 b4 a4 g#4 e4 ~").s("square")
  .decay(0.18).sustain(0.3).room(0.16).gain(0.4)
```

## Full skeleton (the chorus)

Drums + pumping bass + chugging power chords + hook — wide open. For the verse,
swap the power chords for the palm-muted fragment and drop the crash.

```strudel
setbpm(172);
stack(
  s("bd ~ bd bd ~ ~ bd ~").gain(0.9),
  s("~ ~ sd ~ ~ ~ sd ~").gain(0.82),
  s("hh*8").gain(0.3),
  s("cr ~ ~ ~").gain(0.35),
  note("<e2 b1 c#2 a1>").ply(8).s("sawtooth").dist(0.15).lpf(1300).decay(0.1).sustain(0.4).gain(0.45),
  note("<[e2,b2,e3] [b1,f#2,b2] [c#2,g#2,c#3] [a1,e2,a2]>").ply(8).s("supersaw").dist(0.35).lpf(2600).decay(0.12).sustain(0.4).gain(0.3),
  note("e4 b4 g#4 b4 a4 g#4 e4 ~").s("square").decay(0.18).sustain(0.3).room(0.16).gain(0.32)
)
```
