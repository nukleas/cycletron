---
genre: indie-synth-rock
aliases: [indie rock, new wave, synth rock, indie electronic, metric]
bpm: [118, 145]
swing: 0.0
scales: [minor, major, dorian]
key_sounds: [supersaw, sawtooth, square, bd, sd, hh, cp]
signature: Driving indie rock fused with new-wave synths — a pulsing eighth-note synth bass, distorted saw-stab "guitar" chords, bright arpeggios, and an anthemic backbeat. (Metric / Emily Haines; Chvrches.)
artists: [Metric, Chvrches, The Killers, Yeah Yeah Yeahs, Phoenix]
sources:
  - "https://en.wikipedia.org/wiki/Metric_(band)"
  - "hand-authored exemplar — to be expanded by /research-genre"
---

The engine of this sound is *forward motion*: a relentless eighth-note pulse
(bass or synth) under a punchy rock backbeat, with synths doing the job guitars
do in straight rock — power-chord stabs and ringing arpeggios. Distort the saws
a little so they read as "band" rather than "EDM". Keep harmony simple (i–VI–
III–VII in minor is the Metric move) and let energy come from the drive and the
arrangement, not from chord complexity.

## Backbeat drive

Four-on-the-floor kick with a hard backbeat snare and steady eighth hats — the
indie-dance pulse.

```strudel
setbpm(132);
stack(
  s("bd*4").gain(0.9),
  s("~ sd ~ sd").gain(0.7),
  s("hh*8").gain(0.35)
)
```

## Pulsing eighth-note bass

The signature: a synth bass hammering eighths, walking the root notes of the
progression.

```strudel
setbpm(132);
note("e2 e2 e2 e2 c2 c2 g2 g2").s("sawtooth")
  .lpf(900).decay(0.12).sustain(0.4).gain(0.55)
```

## Distorted saw-stab chords (the "guitar")

Power-chord energy from a slightly distorted supersaw, played as stabs on the
backbeat. This is the layer that makes it rock.

```strudel
setbpm(132);
chord("<Em C G D>").voicing().s("supersaw")
  .lpf(2600).dist(0.3).attack(0.005).decay(0.3).sustain(0.4).gain(0.4)
```

## Bright arpeggio hook

A ringing square/saw arp with delay — the new-wave shimmer over the rock.

```strudel
setbpm(132);
note("e5 b4 g4 b4").fast(2).s("square")
  .delay(0.25).delaytime(0.375).room(0.2).gain(0.4)
```

## Full skeleton

Drums + driving bass + saw stabs + arp.

```strudel
setbpm(132);
stack(
  s("bd*4").gain(0.9),
  s("~ sd ~ sd").gain(0.7),
  s("hh*8").gain(0.32),
  note("e2 e2 e2 e2 c2 c2 g2 g2").s("sawtooth").lpf(900).decay(0.12).sustain(0.4).gain(0.5),
  chord("<Em C G D>").voicing().s("supersaw").lpf(2600).dist(0.25).decay(0.3).sustain(0.35).gain(0.32),
  note("e5 b4 g4 b4").fast(2).s("square").delay(0.25).room(0.2).gain(0.3)
)
```
