# AGENCY — Original Soundtrack

Concept album for the game **Agency**: you are a new agent inside an
organization modernizing legacy systems while fending off hackers, bureaucracy,
and everything else the AI era throws at a terminal. The album follows one
full crisis cycle — badge-in to ship day.

Every track is a single validated `.strudel` file (gated by `corpus-check` +
`song-check`), loopable by construction, playable in the robostrudel app.

## Tracklist

| # | Track | Story beat | Genre | BPM | Key |
|---|-------|-----------|-------|-----|-----|
| 1 | Legacy System | Boot-up; the old mainframe hums | dark ambient → Berlin school | 58 | C# minor |
| 2 | Ticket Queue | Fluorescent office, endless forms | synthwave (darksynth shading) | 100 | F# minor |
| 3 | Red Tape | Bureaucracy as a boss fight | EBM / industrial | 128 | C# phrygian |
| 4 | First Incident | The pager goes off | darksynth | 110 | C# minor |
| 5 | Zero Day | Full hacker duel | industrial techno | 135 | C# phrygian |
| 6 | Cascade Failure | Systems fall like dominoes | neurofunk / breakcore edits | 174 | G# minor |
| 7 | The All-Nighter | 3 AM rebuild | dub techno / future garage | 120 | F# minor |
| 8 | Green Build | It ships. Dawn. | synthwave, major-key reprise | 102 | E major |

**Act II — The Counterattack** (stop-riff tracks: the bass is the riff, and
the whole mix stops with it — Perturbator / The Rebel Path mold)

| # | Track | Story beat | Genre | BPM | Key |
|---|-------|-----------|-------|-----|-----|
| 9 | Night Drive | Called back in at 11 PM; city sliding past | outrun gallop + sidechain pump | 104 | C# minor |
| 10 | Black ICE | The Agency deploys its own countermeasure AI | darksynth, stop-riff | 106 | C# minor |
| 11 | War Room | The org mobilizes around the screen wall | brooding half-time (Rebel Path mold) | 92 | G# minor |
| 12 | Rogue Process | The escaped process forks itself | Perturbator club-mode | 122 | F# minor |
| 13 | Kill Switch | One command ends it — and the old system too | motif-as-riff finale | 100 | C# minor |

## Cohesion contract

- **The Agency motif** — scale degrees `0 2 4 6 · 7 4 2 0` (rise to the
  subtonic, answer falling from the octave). Introduced as Track 1's sequencer
  arp, returns as Track 4's lead, hammered as Track 5's stab rhythm, and
  re-voiced in E major as Track 8's resolution.
- **Key scheme** — home is C# minor. Excursions: iv (F# minor) for the grind
  tracks, v (G# minor) for the collapse, phrygian C# for the adversarial
  tracks, E major (relative major) for the dawn.
- **The mainframe drone** — Track 1's C#1 hum reappears under Track 8's intro
  before resolving up a major third, and returns to die in Track 12's flip.
- **The pump** — Act II's four-on-floor tracks (9, 10, 12, 13) duck their
  pads on every beat via `gain(saw.range(lo,hi).fast(4))` — the sidechain
  translation mined from the bakery corpus (see darksynth.md).
- **Act II stop-riff** — tracks 10–13 share one arrangement device: every layer
  writes the same rest gaps, so the full mix slams to a stop and the reverb
  hangs. In Track 12 the Agency motif itself becomes the stop-riff bass.

Every track states its FORM contract (sections · bars · energy · layers) in a
header comment and uses `pickRestart` with 4-bar section granularity, so the
in-app song map lights up per section.
