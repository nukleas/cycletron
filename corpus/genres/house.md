---
genre: house
aliases: [deep house, chicago house, classic house]
bpm: [118, 128]
swing: 0.08
scales: [minor, dorian, minor pentatonic]
key_sounds: [bd, cp, oh, hh, rd, sawtooth, sine, triangle, gm_epiano1, RolandTR909]
signature: Four-on-the-floor kick, offbeat open hats, backbeat clap, 16th closed hats, a bass that talks to the kick, and stabbed 7ths or I–V–vi–IV piano at 118–128 BPM.
artists: [Frankie Knuckles, Larry Heard, Kerri Chandler, Daft Punk, Disclosure, Technotronic, Corona]
sources:
  - "https://en.wikipedia.org/wiki/House_music"
  - "https://www.edmprod.com/how-to-make-house-music/"
  - "https://melodycraft.app/insights/house-music-explained-house-vs-techno"
  - "MusicRepo bakery: Pump Up The Jam [8566] — 124 BPM TR-909 layering (hats → kick → clap → ride)"
  - "MusicRepo bakery: The Rhythm Of The Night [6639] — 128 BPM 909 grid + arrange"
  - "github mcp-examples deep-house / tech-house (D / A at 122–126, on-beat sub, I–V–vi–IV stabs)"
---

House is a conversation between four drum roles and a bass. The kick is on every
beat. The clap answers on 2 and 4. Closed hats tick the grid; an open hat lifts
the offbeat ("tsss" between kicks). Tempo sits around **118–128 BPM** — fast
enough to dance, slow enough to last. Deep / Chicago house leans minor or dorian
with a little swing; tech-leaning house stays straighter and a click faster.

The bakery dump agrees with the production writeups. The two most-copied house
tunes on strudel.cc (Technotronic *Pump Up The Jam*, Corona *The Rhythm Of The
Night*) share one drum cell:

`bd*4` + `[~ oh]*4` + `hh*16` + `[~ cp]*2` on a TR-909, ~124–128 BPM.

Everything else in those files is arrangement: hats first, then kick, then clap,
then a ride, then a snare fill. That layering is the form, not extra decoration.

## Four-on-the-floor core

Kick every beat, open hat on every offbeat, clap on the backbeat. This already
reads as house. Use the 909 bank — both bakery covers do.

```strudel
setbpm(124);
stack(
  s("bd*4").gain(0.9),
  s("[~ oh]*4").gain(0.38),
  s("~ cp ~ cp").gain(0.55)
).bank("RolandTR909")
```

## 16th hats and ride

Closed 8ths get boring. Bakery house adds **16th hats** (often quieter than the
open hat) and a ride on the offbeats. Hat gain `[0.22 0.12]*8` is a cheap shuffle
without `.swing()`.

```strudel
setbpm(124);
stack(
  stack(
    s("bd*4").gain(0.9),
    s("[~ oh]*4").gain(0.32),
    s("~ cp ~ cp").gain(0.55),
    s("hh*16").gain("[0.18 0.10]*8")
  ).bank("RolandTR909"),
  s("~ RolandTR909_rd ~ RolandTR909_rd").hpf(4000).gain(0.14)
)
```

## Offbeat bass (Chicago / deep)

The bass lives in the *gaps* between kicks — offbeat roots, filtered low. This
is what makes house move rather than march.

```strudel
setbpm(122);
note("~ a1 ~ a1 ~ a1 ~ a2").s("sawtooth")
  .lpf(500).resonance(6).gain(0.5)
```

## On-beat sub (deep-house sketch)

The github deep-house example puts the sub *on* the kick (`D2 ~ D2 ~`) as a
sine. Use this when the offbeat line is too busy, or under a busier chord stab.

```strudel
setbpm(122);
note("a1 ~ a1 ~ a1 ~ a1 ~").s("sine").lpf(180).gain(0.55)
```

## Stabbed minor-7ths

Short m7 stabs on the offbeats — the classic deep-house organ/saw hit.
`chord(...).voicing()` is required or the symbols play as sample names.

```strudel
setbpm(122);
chord("<Am7 Dm7 Em7 Am7>").voicing().s("sawtooth")
  .struct("~ 1 ~ 1").release(0.16).lpf(1900).gain(0.45).room(0.3)
```

## I–V–vi–IV piano (90s / pop house)

Bakery *Rhythm of the Night* and the mcp deep-house sketch both use diatonic
pop-house changes (Ab–Cm–Bb–F / D–A–Bm–G). Same offbeat `struct`, piano instead
of saw.

```strudel
setbpm(124);
note("<[c4,e4,g4] [g3,b3,d4] [a3,c4,e4] [f3,a3,c4]>")
  .s("gm_epiano1")
  .struct("~ 1 ~ 1")
  .release(0.22)
  .gain(0.4)
  .room(0.35)
```

## Offbeat lead

A short pentatonic answer on the offbeats, delayed. Lifted from the mcp
deep-house melody shape (syncopated 8ths, triangle, small room).

```strudel
setbpm(124);
note("a4 ~ c5 ~ e5 ~ g5 a4 ~ e5 ~ c5 ~ a4 ~")
  .s("triangle")
  .delay(0.25)
  .delaytime(0.375)
  .room(0.3)
  .gain(0.32)
```

## Arrangement: hats, then kick, then clap

*Pump Up The Jam* (bakery) does not drop the full kit at once. Selector
`.slow(4)` so each section lasts four cycles.

```strudel
setbpm(124);
"<hats groove fill>".slow(4).pickRestart({
  hats: stack(
    s("hh*8").gain(0.2),
    s("[~ oh]*4").gain(0.32)
  ).bank("RolandTR909"),
  groove: stack(
    s("bd*4").gain(0.9),
    s("[~ oh]*4").gain(0.36),
    s("~ cp ~ cp").gain(0.55),
    s("hh*16").gain(0.14)
  ).bank("RolandTR909"),
  fill: stack(
    s("bd*4").gain(0.9),
    s("~ cp ~ cp").gain(0.5),
    s("hh*8").gain(0.16),
    s("~ ~ ~ sd*8").gain(0.4)
  ).bank("RolandTR909")
})
```

## Full skeleton

Four-on-the-floor + 16th hats + offbeat bass with a slow filter breath + m7
stabs. Sweep the bass `lpf` up to build; mute the stabs for a stripped section.

```strudel
setbpm(124);
stack(
  s("bd*4").gain(0.9),
  s("[~ oh]*4").gain(0.36),
  s("~ cp ~ cp").gain(0.55),
  s("hh*16").gain("[0.16 0.09]*8"),
  note("~ a1 ~ a1 ~ a1 ~ a2").s("sawtooth")
    .lpf(sine.range(400, 1200).slow(8)).resonance(6).gain(0.48),
  chord("<Am7 Dm7 Em7 Am7>").voicing().s("sawtooth")
    .struct("~ 1 ~ 1").release(0.16).lpf(1900).gain(0.4).room(0.3)
).bank("RolandTR909")
```

## Translation notes

- Bakery house almost always writes `setcps(1)` / `.cpm(124/4)` — that is
  **124 BPM**. Prefer `setbpm(124);`.
- `[~ oh]*4` and `[~ cp]*2` are the same as `~ oh ~ oh ~ oh ~ oh` and
  `~ cp ~ cp`. Keep the compact form.
- `.bank("RolandTR909")` on the *stack* retargets every drum voice. Do not put
  it on the bass/chord layers — apply it to the drum stack only, or the saw
  will no-op (harmless) but a `rim` without a bank is silent.
- `chord("Am7").s("sawtooth")` without `.voicing()` is silent. Always voice.
- Slight swing (`.late()` on offbeat 8ths, or hat gain `[loud quiet]*n`) is
  Chicago/deep. Tech house in this repo stays straight — see `tech-house.md`.
- French-house filter-pump is a sibling recipe (`french-house.md`), not a
  substitute for this grid.
