---
genre: industrial-techno
aliases: [industrial techno, industrial, ebm, electronic body music, hard techno]
bpm: [128, 140]
swing: 0.0
scales: [minor, phrygian, harmonic minor]
key_sounds: [bd, sbd, sine, sawtooth, supersaw, supersquare, mt, hh, rs, cp]
signature: A punishing, distorted four-on-the-floor with a sub-bass rumble tail, metallic euclidean percussion, and a relentless rolling 16th-note bassline — timbre-as-aggression, built from saturation, filtering and reverb rather than melody.
artists: [Perc, Ancient Methods, Truss, Blawan, SNTS, Blush Response, Phase Fatale, Front 242, Nitzer Ebb, DAF]
sources:
  - "https://en.wikipedia.org/wiki/Industrial_techno"
  - "https://www.attackmagazine.com/technique/tutorials/processing-berghain-kicks-with-multiband-distortion/"
  - "https://www.studiobrootle.com/making-a-techno-rumble-kick-in-ableton-live-step-by-step/"
  - "https://www.mastrng.com/techno-rumble/"
  - "https://www.attackmagazine.com/technique/tutorials/warehouse-rolling-techno-bass/"
  - "https://www.studiobrootle.com/ebm-bassline-tutorial-ableton/"
  - "https://www.tonepusher.com/post/5-ebm-industrial-bassline-tricks-to-sound-like-the-pros"
  - "https://electronicmusic.fandom.com/wiki/Electronic_Body_Music"
  - "https://xlr8r.com/podcasts/podcast-539-ancient-methods/"
---

Industrial techno is a **timbre-first** style: the hook is not a melody but the
*weight and grit* of the sound — an overdriven TR-909-style kick fused with a
sub-bass rumble tail, clanging metallic percussion, and a locomotive bassline
that never rests. Keep the harmony dark and static (natural/harmonic minor,
phrygian for the ♭2 bite), keep the pulse a straight, unswung four-on-the-floor,
and let **distortion, filtering and reverb** do the work that chords do in other
genres (Perc/Ancient Methods lineage, drawing on 80s industrial and EBM —
[Wikipedia](https://en.wikipedia.org/wiki/Industrial_techno)).

Two poles anchor this recipe:
- **EBM** (aliases include `ebm`) — ~126–130 BPM, mechanical stomp, a rolling
  16th-note synth bass, shouted-stab energy. DAF's 1981 4/4-plus-16th-bass
  template and Nitzer Ebb / Front 242's SH-101 + DX7 basslines define it
  ([EBM wiki](https://electronicmusic.fandom.com/wiki/Electronic_Body_Music),
  [Studio Brootle](https://www.studiobrootle.com/ebm-bassline-tutorial-ableton/)).
- **Industrial techno** proper — ~132–140 BPM, harsher, distorted four-on-floor,
  euclidean metal, rumble kicks (Perc, Truss, Blawan, SNTS, Blush Response).

Album key is **C# minor**; fragments below sit in C#/A minor.

## Drum core

Straight, distorted four-on-the-floor with a dense 16th hat grid and a driving
tom figure locked to that grid — the industrial "machine" feel. `dist` + `shape`
give the kit its overdriven edge; the 3-3-3-3-4 tom (16th slots 0/3/6/9/12,
body intact at hpf 300) pushes against the kick without ever floating free of
the downbeat.

```strudel
setbpm(135);
stack(
  s("bd*4").gain(0.95).dist(0.4).shape(0.3).lpf(3200),
  s("hh*16").gain(0.3).hpf(6500),
  s("~ ~ oh ~").gain(0.35).hpf(4000),
  s("mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ ~").gain(0.42).dist(0.3).hpf(300).pan(0.4)
)
```

## The rumble kick

The signature low-end. Producers duplicate the kick, drown it in long reverb,
low-pass to keep only the sub, and heavily distort it so a booming tail rolls
*between* the kicks and pumps rhythmically — the Berghain "far away and impossibly
close" sound
([Attack Magazine](https://www.attackmagazine.com/technique/tutorials/processing-berghain-kicks-with-multiband-distortion/),
[Studio Brootle](https://www.studiobrootle.com/making-a-techno-rumble-kick-in-ableton-live-step-by-step/)).

strudel-rs has no send-reverb-with-sidechain, so translate it as a **layered kick
+ tuned sub tail**: the punchy distorted `bd` on top, and a `sine` sub on the same
root pitch (C#1) with a long `release` and heavy `room` whose tail fills the gaps
= the rumble. `lpf(220)` keeps only the sub; `dist` gives it the grind. This is a
faithful reduction of the technique to the engine's surface, not the full
multiband/sidechain chain.

```strudel
setbpm(135);
stack(
  s("bd*4").gain(0.95).dist(0.45).shape(0.35).lpf(3000),
  note("c#1*4").s("sine")
    .attack(0.001).decay(0.32).sustain(0).release(0.4)
    .lpf(220).resonance(3).dist(0.5)
    .room(0.55).roomsize(0.85).gain(0.6)
)
```

## Metallic percussion

The industrial texture: clanging metal hits locked to the grid, bit-crushed for
machine grit. Layer a tresillo (3-3-2) rimshot with its body intact, a crushed
tom pickup answering every other bar, and a `wt_bell` clang so the percussion
reads as struck metal rather than a drum kit (Serge-modular-style noise/feedback
percussion is the studio reference — [Ancient Methods](https://xlr8r.com/podcasts/podcast-539-ancient-methods/)).
Keep the rim's low-mids (hpf ≤ ~2000) and seat it with a touch of room —
high-passing a rimshot to 4 kHz leaves a naked click that floats free of the
groove instead of driving it.

```strudel
setbpm(135);
stack(
  s("RolandTR808_rim ~ ~ RolandTR808_rim ~ ~ RolandTR808_rim ~").gain(0.34).hpf(1800).dist(0.2).room(0.12).pan(0.35),
  s("<[~ ~ ~ [~ mt]] [~ ~ ~ [ht mt]]>").gain(0.38).crush(6).hpf(600).pan(0.62),
  note("c#5(3,8)").s("wt_bell").gain(0.3).dist(0.25).lpf(5000).room(0.4).delay(0.15)
)
```

## Rolling EBM bassline

The locomotive. All-16ths, rarely resting, with octave jumps and accent groove —
DAF/Nitzer Ebb's step-sequencer template. A `sawtooth` through a low `lpf` with
resonance and overdrive gives the "analog meat + FM pluck" hybrid; short
`decay`/zero `sustain` makes each step percussive so it locks to a snappy kick
([Studio Brootle](https://www.studiobrootle.com/ebm-bassline-tutorial-ableton/),
[tonepusher](https://www.tonepusher.com/post/5-ebm-industrial-bassline-tricks-to-sound-like-the-pros)).
Phrygian ♭2 (the `d2` against a C# root) gives the menace. The `gain` pattern
supplies the velocity accents.

```strudel
setbpm(135);
note("c#2 c#2 c#3 c#2 c#2 c#2 c#3 c#2 c#2 d2 c#3 c#2 e2 c#2 c#3 c#2")
  .s("sawtooth")
  .lpf(950).resonance(8).dist(0.28)
  .decay(0.09).sustain(0).release(0.03)
  .gain("0.9 0.55 0.7 0.55")
```

## Pad / drone

Harmony stays static and atmospheric — a dark, slowly-breathing minor pad under
the machine. Long `attack`/`release`, a heavy `room`, and a low `lpf` keep it a
bed, not a lead. Slowcat two voicings so it shifts every other cycle without ever
becoming a "progression".

```strudel
setbpm(135);
note("<[c#3,e3,g#3,b3] [a2,c#3,e3,g#3]>").s("supersaw")
  .attack(1.2).release(3.5)
  .lpf(1100).resonance(4)
  .gain(0.3).room(0.65).roomsize(0.85).pan(0.5)
```

## Lead / stab

The "shouted stab" energy — a short, aggressive phrygian stab with a dotted delay
throwing it across the bar. `supersquare` + `dist` gives it the harsh EBM bark;
zero sustain keeps it a stab, not a pad.

```strudel
setbpm(135);
note("~ c#4 ~ ~ ~ c#4 ~ e4").s("supersquare")
  .decay(0.12).sustain(0).release(0.08)
  .lpf(2600).resonance(6).dist(0.3)
  .delay(0.2).delaytime(0.375).delayfeedback(0.3)
  .gain(0.5).pan(0.55)
```

## Full skeleton

Sections switch with `pickRestart` on a `.slow(8)` timeline (each label lasts 8
cycles). Energy is managed by *adding and removing layers* — intro drone → build
with hats and bass → main with the rumble kick and full machine → break to
pads/metal — rather than by chord changes. This is the industrial-techno
arrangement in miniature.

```strudel
setbpm(135);
"<intro intro build build main main break main>".slow(8).pickRestart({
  intro: stack(
    s("bd*4").gain(0.9).dist(0.3),
    note("<[c#3,e3,g#3]>").s("supersaw").attack(1).release(3).lpf(900).gain(0.25).room(0.6)
  ),
  build: stack(
    s("bd*4").gain(0.92).dist(0.35).shape(0.25),
    s("hh*16").gain(0.3).hpf(6500),
    note("c#2 c#2 c#3 c#2 c#2 c#2 c#3 c#2 c#2 d2 c#3 c#2 e2 c#2 c#3 c#2")
      .s("sawtooth").lpf(900).resonance(8).dist(0.2).decay(0.09).sustain(0).gain(0.55)
  ),
  main: stack(
    s("bd*4").gain(0.95).dist(0.45).shape(0.35).lpf(3000),
    note("c#1*4").s("sine").attack(0.001).decay(0.32).sustain(0).release(0.4)
      .lpf(220).dist(0.5).room(0.55).roomsize(0.85).gain(0.55),
    s("mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ mt ~ ~ ~").gain(0.42).dist(0.3).hpf(300),
    s("hh*16").gain(0.28).hpf(6500),
    note("c#2 c#2 c#3 c#2 c#2 c#2 c#3 c#2 c#2 d2 c#3 c#2 e2 c#2 c#3 c#2")
      .s("sawtooth").lpf(1100).resonance(8).dist(0.28).decay(0.09).sustain(0).gain("0.7 0.5")
  ),
  break: stack(
    note("<[c#3,e3,g#3,b3] [a2,c#3,e3,g#3]>").s("supersaw")
      .attack(1.2).release(3.5).lpf(1000).gain(0.3).room(0.7),
    s("~ ~ ~ [~ rs]").gain(0.24).hpf(2200).room(0.2)
  )
})
```

## EBM sibling (128 BPM, A minor)

The EBM pole trades industrial-techno's harshness for a mechanical mid-tempo
stomp: a backbeat snare, offbeat hats, and the rolling 16th bass out front. Same
bass idiom, lower tempo, less distortion, more groove.

```strudel
setbpm(128);
stack(
  s("bd*4").gain(0.92).dist(0.15),
  s("~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").gain(0.6),
  s("~ hh ~ hh ~ hh ~ hh").gain(0.35).hpf(5000),
  note("a1 a1 a2 a1 a1 a1 a2 a1 a1 bb1 a2 a1 c2 a1 a2 a1")
    .s("sawtooth").lpf(850).resonance(7).dist(0.18)
    .decay(0.1).sustain(0).gain("0.85 0.55 0.7 0.55")
)
```

## Translation notes

- **Rumble kick**: no send-reverb + sidechain in strudel-rs. Approximate with a
  layered `sine`/`sbd` sub on the kick's root pitch, long `release` + `room` for
  the tail, `lpf(~220)` to isolate the sub, `dist` for grind. Tune the sub to the
  track root so kick and rumble read "as one".
- **Distortion**: `dist(amount)` is the workhorse; stack `shape` for extra
  harmonic drive and `crush(bits)` for digital/metal grit on percussion.
- **Metallic hits**: `wt_bell` for struck-metal tone; for machine clatter, write
  rim/tom patterns on the grid — a tresillo (`rim ~ ~ rim ~ ~ rim ~`), tom
  pickups into bar ends — with the sample's body intact (hpf ≤ ~2000, a touch of
  `room`). Hpf'd-to-click euclid layers (`rs(5,16).hpf(4000)`) read as
  arrhythmic ticking, not groove. Euclids stay fine on pitched, bodied voices
  (`note("c#5(3,8)").s("wt_bell")`) when unrotated so they anchor the downbeat.
- **Bassline groove**: put velocity accents in a `.gain("...")` pattern rather
  than per-note; short `decay` + `sustain(0)` = the plucky step-sequencer feel.
- **Phrygian bite**: the ♭2 (D against a C# root, or B♭ against A) is the single
  most menacing interval — use it as a passing step in the 16th bass.
- **Form**: manage energy by muting/adding layers across `pickRestart` sections,
  not with chord movement. Keep `.slow(8)` on the selector or sections flash by.
