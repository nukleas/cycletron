---
genre: hip-hop
aliases: [lo-fi, lofi, lo-fi hip-hop, boom bap, chillhop, trip-hop]
bpm: [82, 92]
swing: 0.15
scales: [minor, dorian, minor pentatonic, major]
key_sounds: [bd, sd, hh, oh, rs, gm_epiano1, piano, gm_acoustic_bass]
signature: Laid-back boom-bap at ~85 BPM — a punchy syncopated kick, snare on the backbeat, ticking hats, warm jazzy 7th chords on a Rhodes, and a walking upright bass. Dusty and mellow. (J Dilla, Nujabes, Madlib.)
artists: [J Dilla, Nujabes, Madlib, DJ Premier, MF DOOM]
sources:
  - "https://en.wikipedia.org/wiki/Boom_bap"
  - "strudel.cc bakery corpus (boom-bap grid patterns, TR-808/707) — distilled to strudel-rs"
---

Hip-hop's foundation is the boom-bap: a punchy kick that lands slightly
syncopated (not four-on-the-floor — it leaves space), a fat snare cracking on the
backbeat (2 and 4), and hats ticking underneath. The feel is *laid-back* — the
groove sits a hair behind the beat. Over the top go warm, jazzy seventh chords on a
Rhodes and a simple walking upright bass. Keep it minor or dorian, dusty and
unhurried; lo-fi variants add vinyl crackle and roll the highs off.

## Boom-bap drums

Syncopated kick, backbeat snare, straight hats. The kick leaving gaps is what
makes it swing.

```strudel
setbpm(85);
stack(
  s("bd ~ ~ bd ~ ~ bd ~").bank("RolandTR808").gain(0.9),
  s("~ ~ sd ~ ~ ~ sd ~").bank("RolandTR808").gain(0.7),
  s("hh*8").bank("RolandTR808").gain(0.25)
)
```

## Walking upright bass

A simple root–fifth walk on an acoustic bass, one note per beat, sitting under the
kick.

```strudel
setbpm(85);
note("a1 ~ e2 ~ a1 ~ c2 ~").s("gm_acoustic_bass").gain(0.6)
```

## Rhodes 7th chords

Warm jazzy seventh chords, one per bar, on an electric piano — the harmonic bed of
lo-fi. `chord(...).voicing()` picks a smooth voicing.

```strudel
setbpm(85);
chord("<Am7 Dm7 Gmaj7 Cmaj7>").voicing().s("gm_epiano1")
  .release(0.4).gain(0.5).room(0.3)
```

## Full skeleton

Boom-bap + upright bass + Rhodes. Drop the chords for a verse, add an open hat or a
ride for the hook.

```strudel
setbpm(85);
stack(
  s("bd ~ ~ bd ~ ~ bd ~").bank("RolandTR808").gain(0.9),
  s("~ ~ sd ~ ~ ~ sd ~").bank("RolandTR808").gain(0.7),
  s("hh*8").bank("RolandTR808").gain(0.22),
  note("a1 ~ e2 ~ a1 ~ c2 ~").s("gm_acoustic_bass").gain(0.55),
  chord("<Am7 Dm7 Gmaj7 Cmaj7>").voicing().s("gm_epiano1").release(0.4).gain(0.42).room(0.3)
)
```
