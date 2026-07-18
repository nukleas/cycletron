---
genre: dark-ambient
aliases: [dark ambient, drone, ritual ambient, isolationist ambient]
bpm: [50, 60]
swing: 0.0
scales: [minor, phrygian, dorian]
key_sounds: [sine, wt_pad, wt_strings, wt_cello, brown, pink, wt_bell, wt_pluck]
signature: Ominous and near-beatless — a deep sustained drone under slowly evolving dissonant pads, filtered machine noise, and sparse Berlin-school sequences, everything drowned in reverb and delay. (Lustmord, Atrium Carceri, the Cryo Chamber school.)
artists: [Lustmord, Atrium Carceri, Dronny Darko, Cryo Chamber, Tangerine Dream, Klaus Schulze]
sources:
  - "https://en.wikipedia.org/wiki/Dark_ambient"
  - "https://www.thisisdarkness.com/2018/04/07/dark-ambient-101-drones/"
  - "https://www.decibelmagazine.com/2024/09/23/interview-simon-heath-of-cryo-chamber-and-cryo-crypt/"
  - "https://daily.bandcamp.com/label-profile/cryo-chamber-dark-ambient-guide"
  - "https://www.bluezone-corporation.com/blog/the-sounds-of-dark-ambient-music-understanding-their-roles"
  - "https://blog.chriswirsig.com/2016/05/12/step-sequencing-like-klaus-schulze-the-easy-way/"
  - "https://forum.vintagesynth.com/viewtopic.php?t=35770"
---

Dark ambient is ambient with the lights off. It keeps ambient's slowness and
space but trades warmth for dread: extremely low-frequency drones, dissonant
sustained layers, treated noise and machine hum, and only the sparsest melodic
motion — often none. There is usually no kit at all; movement comes from things
*changing* rather than repeating, so the whole craft is slow modulation:
filters that open across half a minute, detuning that drifts, layers that swell
in and fade back out ([This Is Darkness — Dark Ambient 101: Drones](https://www.thisisdarkness.com/2018/04/07/dark-ambient-101-drones/);
[Bluezone — the sounds of dark ambient](https://www.bluezone-corporation.com/blog/the-sounds-of-dark-ambient-music-understanding-their-roles)).
The Cryo Chamber school (Atrium Carceri, Dronny Darko) works *subtractively* —
build a dense bed, then remove elements so the reverb can breathe — and leans
heavily on layering drones with field recordings placed in the stereo field
([Decibel interview with Simon Heath](https://www.decibelmagazine.com/2024/09/23/interview-simon-heath-of-cryo-chamber-and-cryo-crypt/);
[Bandcamp Daily — Cryo Chamber guide](https://daily.bandcamp.com/label-profile/cryo-chamber-dark-ambient-guide)).
Lustmord is the origin point: weaving extremely low drones, eerie reverberation
and found sound into an overwhelming acoustic space ([Wikipedia — Dark ambient](https://en.wikipedia.org/wiki/Dark_ambient)).

These fragments sit in **C# minor** (the album home key). Tempo is a suggestion
only — at 50–60 BPM everything is held, so we lengthen notes with `.slow(n)`
rather than relying on the grid. Because the genre lives on stereo depth, most
layers get a `.pan()` off-centre (and a slow `sine`-driven pan on the pad) so the
bed opens up instead of collapsing to mono; the sub drone stays centred.

## Foundation drone

The floor: a deep root that never resolves. A sub sine on C#1 carries the
weight; a second sine an octave up, slightly detuned, beats slowly against it;
a bowed-cello layer adds a fifth (G#) and some body. `.slow(n)` holds each note
for many seconds so it reads as a continuous drone rather than a re-struck note.
Everything is soaked in room.

```strudel
setbpm(55);
stack(
  note("c#1").s("sine").slow(4).attack(4).release(12).gain(0.55),
  note("c#2").s("sine").slow(4).attack(6).release(12).detune(9).gain(0.28),
  note("g#1").s("wt_cello").slow(4).attack(6).release(12).lpf(420).gain(0.22)
).room(0.92)
```

## Evolving pad

Movement without notes: a two-chord pad (C#m7 → Amaj7, i → VI, the dark
consonance dark ambient likes) whose low-pass cutoff crawls open and shut over
16 cycles via `lpf(sine.range(...).slow(16))`. The chord changes only once every
two cycles (`/2`), and the long attack means it fades *up* into each change
rather than being struck. This is the "automate a filter across many bars" move
that keeps a static pad alive ([This Is Darkness](https://www.thisisdarkness.com/2018/04/07/dark-ambient-101-drones/)).

```strudel
setbpm(55);
note("<[c#3, e3, g#3, b3] [a2, c#3, e3, g#3]>/2").s("wt_pad")
  .attack(3).release(6)
  .lpf(sine.range(300, 1100).slow(16)).resonance(4)
  .pan(sine.range(0.35, 0.65).slow(24))
  .gain(0.3).room(0.9)
```

## Filtered noise / machine hum

The "legacy mainframe" texture: brown noise (deep, low-tilt) swept by a slow
low-pass for an air-conditioning/tape-hiss wash, stacked with a low square tone
given a slow vibrato so it reads as electrical hum, and a touch of bit-crush for
digital grit. Filtered noise is a dark-ambient staple; keep the cutoff low so it
sits under everything.

```strudel
setbpm(55);
stack(
  s("brown").slow(2).attack(4).release(8).lpf(sine.range(180, 650).slow(12)).pan(0.4).gain(0.26),
  note("c#1").s("square").slow(2).attack(2).release(8).lpf(200).vib(0.25).vibmod(0.4).crush(7).pan(0.6).gain(0.13)
).room(0.6)
```

## Berlin-school sequencer

The one moment of forward motion: a short, hypnotic 8-step sequence pitched high
(Schulze kept his sequences an octave or two up), run through tempo-synced delay
so the echoes double the note count and broaden the line
([Chris Wirsig — step-sequencing like Klaus Schulze](https://blog.chriswirsig.com/2016/05/12/step-sequencing-like-klaus-schulze-the-easy-way/);
[Vintage Synth Explorer](https://forum.vintagesynth.com/viewtopic.php?t=35770)).
A slow filter sweep makes the repeating cell "not really repeat", and every 4th
cycle the whole sequence is transposed up a fourth — the real-time transposition
that defines the Berlin sound.

```strudel
setbpm(55);
note("c#4 g#4 e4 b4 c#4 g#4 e4 f#4").s("wt_pluck")
  .every(4, x => x.transpose(5))
  .lpf(sine.range(600, 2000).slow(8)).resonance(6)
  .delay(0.5).delaytime(0.375).delayfeedback(0.55)
  .room(0.7).gain(0.32)
```

## Dissonance / tension

The dread device: a tritone clash. C#2 and G2 (an augmented fourth apart) held
together, with the G's tuning drifting via a slow sine on `detune` so the beating
between them swells and recedes — a controlled, uneasy contrast rather than a
resolving interval. Swap the tritone for a minor-second cluster (`c#2` + `d2`)
for a harsher grind.

```strudel
setbpm(55);
stack(
  note("c#2").s("sine").slow(4).attack(4).release(12).gain(0.4),
  note("g2").s("sine").slow(4).attack(6).release(12).detune(sine.range(-14, 14).slow(20)).gain(0.3)
).room(0.88)
```

## Full skeleton — mainframe boot-up

A slow four-section arc built with `pickRestart` and `.slow(8)` so each section
lasts ~8 cycles (~35s at this tempo; ~2.3 min total). It layers cumulatively, a
legacy machine waking: **boot** is just the sub drone; **hum** adds the filtered
machine noise; **wake** brings the evolving pad in; **drift** finally lets the
Berlin sequence enter. Nothing is ever removed abruptly — new layers fade up over
their attack, the subtractive-but-forward Cryo Chamber shape.

FORM: boot (drone) → hum (+noise) → wake (+pad) → drift (+sequencer). Density
rises one layer per section; no drums throughout.

```strudel
setbpm(55);
"<boot hum wake drift>".slow(8).pickRestart({
  boot: note("c#1").s("sine").slow(4).attack(6).release(12).gain(0.5).room(0.92),
  hum: stack(
    note("c#1").s("sine").slow(4).attack(6).release(12).gain(0.48),
    s("brown").slow(2).attack(4).release(8).lpf(sine.range(180, 650).slow(12)).gain(0.24)
  ).room(0.9),
  wake: stack(
    note("c#1").s("sine").slow(4).attack(6).release(12).gain(0.45),
    note("<[c#3, e3, g#3, b3] [a2, c#3, e3, g#3]>/2").s("wt_pad").attack(3).release(6).lpf(sine.range(300, 1000).slow(16)).pan(0.4).gain(0.28)
  ).room(0.9),
  drift: stack(
    note("c#1").s("sine").slow(4).attack(6).release(12).gain(0.4),
    note("<[c#3, e3, g#3, b3] [a2, c#3, e3, g#3]>/2").s("wt_pad").attack(3).release(6).lpf(900).pan(0.38).gain(0.26),
    note("c#5 g#4 e5 b4 c#5 g#4 e5 f#4").s("wt_pluck").lpf(1600).delay(0.5).delaytime(0.375).delayfeedback(0.5).pan(0.62).room(0.7).gain(0.28)
  ).room(0.9)
})
```
