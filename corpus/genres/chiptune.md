---
genre: chiptune
aliases: [8-bit, 8bit, chip, chipmusic, lsdj, famitracker, nes]
bpm: [120, 180]
swing: 0.0
scales: [major, minor, major pentatonic, harmonic minor]
key_sounds: [pulse, square, triangle, white, sawtooth]
signature: NES / Game Boy soundchip music — thin pulse-wave leads, a triangle-wave bass, and noise-channel percussion. With only a few monophonic channels, fast arpeggios stand in for chords and bitcrush sells the lo-fi.
artists: [Chipzel, Anamanaguchi, Nullsleep, Danny Baranowsky, Disasterpeace]
sources:
  - "https://en.wikipedia.org/wiki/Chiptune"
  - "hand-authored exemplar — to be expanded by /research-genre"
---

Chiptune is defined by *constraint*: the original chips had ~3–4 mono voices
(two pulse channels, one triangle, one noise on the NES). Work within that —
one bass line, one or two lead voices, noise for drums — and lean on the tricks
those constraints forced: super-fast arpeggios to imply chords, `crush`/`coarse`
for the gritty DAC sound, and short envelopes so every note is punchy and dry.
Tempos run fast (140–170 is common); keep it major-key and bright, or minor for
the boss-fight energy.

## Noise-channel drums

Real chip drums are the noise channel shaped with a fast envelope. Short decay,
no sustain = a tight hat; a longer burst = a snare.

```strudel
setbpm(160);
stack(
  s("bd*4").gain(0.8),
  s("~ sd ~ sd").gain(0.55),
  s("white*8").decay(0.02).sustain(0).gain(0.18)
)
```

## Triangle bass

The triangle channel carries the bass — pure, slightly soft, no filter. Keep it
simple and root-heavy.

```strudel
setbpm(160);
note("c2 c2 g2 c2").s("triangle").decay(0.18).sustain(0.3).gain(0.6)
```

## Pulse-wave lead + arpeggios-as-chords

With no polyphony, you fake a chord by arpeggiating it fast. Run the chord tones
in 16ths through a pulse wave and `crush` it for the authentic grit.

```strudel
setbpm(160);
note("c4 e4 g4 b4 c5 b4 g4 e4").fast(2)
  .s("pulse").crush(8)
  .decay(0.08).sustain(0.2).gain(0.45)
```

## Full skeleton

Two pulse voices (lead + counter-melody an octave down), triangle bass, noise
drums — the classic four-channel layout.

```strudel
setbpm(160);
stack(
  s("bd*4").gain(0.8),
  s("~ sd ~ sd").gain(0.55),
  s("white*16").decay(0.015).sustain(0).gain(0.14),
  note("c2 c2 g2 c2").s("triangle").decay(0.18).sustain(0.3).gain(0.6),
  note("c5 e5 g5 e5").fast(2).s("pulse").crush(8).decay(0.07).sustain(0.15).gain(0.4),
  note("c4 ~ g4 ~").s("square").decay(0.1).sustain(0.2).gain(0.3)
)
```
