---
genre: darksynth
aliases: [dark synth, dark synthwave, horror synth, darkwave synth, cyberpunk synth]
bpm: [105, 115]
swing: 0.0
scales: [minor, phrygian, harmonic minor]
key_sounds: [supersaw, sawtooth, bd, sd, oh]
signature: Synthwave's menacing sibling — a pounding four-on-the-floor with a gated-reverb backbeat snare, a grinding distorted octave bass, horror-movie minor pads, and an aggressive saw lead, all saturated and dragged into a slow, threatening mid-tempo. (Perturbator; Carpenter Brut; Dance With The Dead; GosT.)
artists: [Perturbator, Carpenter Brut, Dance With The Dead, GosT, Dan Terminus]
sources:
  - "https://www.melodigging.com/genre/darksynth"
  - "https://synthctrl.com/blogs/blog/dancing-with-the-dead-hex-breakdown"
  - "https://aesthetics.fandom.com/wiki/Darksynth"
  - "https://synthwave.fandom.com/wiki/Dance_With_The_Dead"
  - "https://strudel.cc/?gyCZOciyjqxS"
  - "https://strudel.cc/?BqSVVMaJ1bvu"
---

Darksynth is synthwave with the retro-nostalgia burned off and horror-movie menace
poured in. It keeps the 80s palette — Juno/Prophet-style polys, gated-reverb snares,
octave synth bass — but pushes everything harder: distorted and saturated bass,
higher-contrast dynamics, minor-key tension, and a slower, more threatening groove
than club synthwave. Think John Carpenter soundtrack meets metal energy. For this
engine: sit around 105-115 BPM, stay in a minor mode (lean on Phrygian's flat-2 and
harmonic minor's raised 7th for dread), keep the bass distorted and relentless, and
let `dist` / `room` / `chorus` carry the aesthetic. Home key here is **C# minor** to
anchor a cyberpunk album; every fragment below is in C#/A minor.

The line between darksynth and plain synthwave is aggression, not palette: harsher
sound design, heavier rhythmic impact, and a darker harmonic center
([Melodigging](https://www.melodigging.com/genre/darksynth),
[Aesthetics Wiki](https://aesthetics.fandom.com/wiki/Darksynth)).

## Drum core — four-on-floor + gated-reverb backbeat

Pounding four-on-the-floor kick with a big reverberant snare on the backbeat (the
gated-verb sound — the genre's most distinctive percussion move,
[Melodigging](https://www.melodigging.com/genre/darksynth)), an offbeat open hat, and
panned closed hats. Light `dist` on the kick glues the kit and adds grit.

```strudel
setbpm(110);
stack(
  s("bd*4").gain(0.95).dist(0.25),
  s("~ sd ~ sd").room(0.55).roomsize(0.75).gain(0.72),
  s("hh*8").gain(0.26).pan(sine.range(0.4, 0.6)),
  s("~ ~ ~ oh").gain(0.32)
)
```

## Grinding octave bass

The driving foundation: a distorted saw bouncing between C#1 and C#2 in eighths,
sitting just under the kick. Low cutoff with a touch of resonance keeps it dark, and
`dist` gives it the saturated console-tape bite darksynth basses live on
([Melodigging](https://www.melodigging.com/genre/darksynth)).

```strudel
setbpm(110);
note("c#1 c#2 c#1 c#2 c#1 c#2 c#1 c#2").s("sawtooth")
  .lpf(760).resonance(9).decay(0.18).sustain(0.25)
  .dist(0.2).gain(0.55)
```

## Horror-movie pad

The dread bed: a slow-attack detuned-saw poly holding a minor progression
(i - VI - III - VII in C# minor), drenched in chorus and reverb. The long attack and
release make it swell and loom rather than stab.

```strudel
setbpm(110);
chord("<C#m A E B>").voicing().s("supersaw")
  .lpf(1500).attack(0.5).release(1.2).chorus(0.4).room(0.6).gain(0.3)
```

## Aggressive saw lead

A simple, hooky, cinematic motif — the darksynth lead ethos
([Melodigging](https://www.melodigging.com/genre/darksynth)) — in C# harmonic minor
so the raised 7th bites. Distorted saw with a dotted delay and light resonance for
that confrontational sheen.

```strudel
setbpm(110);
note("0 2 3 5 7 5 3 2").scale("C#4:harmonic minor").fast(2).s("sawtooth")
  .lpf(2600).resonance(6).decay(0.2).sustain(0.12)
  .dist(0.15).delay(0.25).delaytime(0.1875).room(0.3).gain(0.4)
```

## Signature technique — the palm-muted chug

The Dance With The Dead move: a relentless 16th-note reese chug on the root, played
staccato (near-zero sustain = the "palm mute"), with a fast filter LFO modulating the
cutoff and heavy distortion on top. This is the grinding engine-room texture that
separates darksynth from clean synthwave — an LFO at a 16th-note rate driving the
level and cutoff is exactly the Hex bass recipe
([Synth Ctrl](https://synthctrl.com/blogs/blog/dancing-with-the-dead-hex-breakdown)).

```strudel
setbpm(110);
note("c#1*16").s("supersaw")
  .lpf(sine.range(400, 1400).fast(4)).resonance(11)
  .decay(0.08).sustain(0.0)
  .dist(0.35).gain("0.7 0.45 0.55 0.45")
```

## Night-drive gallop bass

The other canonical synthwave/darksynth bass rhythm besides straight octaves:
the dotted-eighth gallop (3+3+3+3+2+2 sixteenths). Mined from the strudel.cc
bakery's outrun scene ("Outrun June 25" by shadesDrawn and its Jakenheim
remixes, [source](https://strudel.cc/?gyCZOciyjqxS)) — the pulse that says
"driving at night". Sits under a four-on-floor kick so the last two hits pull
against the beat.

```strudel
setbpm(108);
stack(
  s("bd*4").gain(0.9).dist(0.2),
  note("c#1 ~ ~ c#1 ~ ~ c#1 ~ ~ c#1 ~ ~ c#1 ~ c#1 ~")
    .s("sawtooth").lpf(650).decay(0.15).sustain(0.25).dist(0.15).gain(0.55)
)
```

## Sidechain pump (engine-native translation)

strudel-rs has no send/sidechain bus, but the pump reads as a beat-synced
gain ramp: `gain(saw.range(lo, hi).fast(4))` ducks at each kick and swells
into the next — the trick "Dark groove techno" by Enelg
([source](https://strudel.cc/?BqSVVMaJ1bvu), bakery featured) does with
`.mul(gain(saw...))` in web-strudel. Apply to pads and rumble subs; keep
`lo` ≥ 0.1 so the tail never fully vanishes.

```strudel
setbpm(108);
stack(
  s("bd*4").gain(0.92).dist(0.2),
  chord("<C#m A>").voicing().s("supersaw").lpf(1300)
    .attack(0.05).release(0.8)
    .gain(saw.range(0.12, 0.3).fast(4)).chorus(0.4).room(0.5),
  note("c#1*4").s("sine").attack(0.05).release(0.5).lpf(260).dist(0.4)
    .gain(saw.range(0.15, 0.5).fast(4)).room(0.4)
)
```

## Full skeleton

Sections via `pickRestart` (note the `.slow(8)` — each label runs 8 bars). Energy
builds intro -> verse -> drop, with the chug and lead reserved for the drop and the
pad carrying the outro out.

```strudel
setbpm(110);
"<intro verse drop drop outro>".slow(8).pickRestart({
  intro: stack(
    s("bd ~ ~ ~").gain(0.85).dist(0.2),
    chord("<C#m A>").voicing().s("supersaw").lpf(1200).attack(0.6).release(1.4).chorus(0.4).room(0.65).gain(0.26)
  ),
  verse: stack(
    s("bd*4").gain(0.92).dist(0.25),
    s("~ sd ~ sd").room(0.55).roomsize(0.75).gain(0.68),
    s("hh*8").gain(0.24).pan(sine.range(0.4, 0.6)),
    note("c#1 c#2 c#1 c#2 c#1 c#2 c#1 c#2").s("sawtooth").lpf(760).resonance(9).decay(0.18).sustain(0.25).dist(0.2).gain(0.5)
  ),
  drop: stack(
    s("bd*4").gain(0.95).dist(0.28),
    s("~ sd ~ sd").room(0.55).roomsize(0.75).gain(0.72),
    s("hh*8").gain(0.26).pan(sine.range(0.4, 0.6)),
    s("~ ~ ~ oh").gain(0.32),
    note("c#1*16").s("supersaw").lpf(sine.range(400, 1400).fast(4)).resonance(11).decay(0.08).sustain(0.0).dist(0.35).gain("0.6 0.4 0.5 0.4"),
    note("0 2 3 5 7 5 3 2").scale("C#4:harmonic minor").fast(2).s("sawtooth").lpf(2600).resonance(6).decay(0.2).sustain(0.12).dist(0.15).delay(0.25).delaytime(0.1875).room(0.3).gain(0.38)
  ),
  outro: stack(
    s("bd ~ ~ ~").gain(0.8).dist(0.2),
    chord("<C#m E>").voicing().s("supersaw").lpf(1100).attack(0.8).release(1.6).chorus(0.4).room(0.7).gain(0.24)
  )
})
```
