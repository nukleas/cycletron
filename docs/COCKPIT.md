# Cockpit

`ui/src/viz/modes/cockpit.ts` is a Canvas 2D vector flight display. Like ISO CITY,
its geometry comes from scheduled events; like LENS BENCH, it uses flat fills,
fine outlines, drafting guides, and small instrument labels. No raster assets,
blur, reflections, or full-screen flashes are used.

| Signal | Flight object / instrument |
| --- | --- |
| Kick | Armored hexagonal target, twin laser hit, canopy-sill accent |
| Snare / clap | Outlined crossing craft |
| Hat / shaker | Outlined peripheral diamonds with a visible center |
| Other percussion | Faceted debris |
| Short pitched note | Hollow navigation diamond |
| Sustained low note | Compact cruiser, destroyed by a paired laser hit |
| Sustained high note | Compact orbital target |
| Scheduled track onsets | SIGNAL BANK activity envelopes and CYCLE SCAN blips |
| Scheduler tempo | BPM readout and four beat segments |
| Event density + FFT energy | DRIVE arc and star-trail length |
| Measured FFT bands | LOW / MID / HIGH meters |

Two forward cannons fire short vector bolts toward upcoming events. Brief corner
brackets identify each incoming shot’s destination, including small percussion
targets that would otherwise be easy to confuse with stars. Targets
reach an intercept plane ahead of the glass on their musical onset; at that
instant they disappear into a brief shock ring and angular fragments. Heavy
kick/bass hits use both cannons, while hats use smaller bursts. Laser travel
uses cycle position with a nominal 160 ms lead; impact timing is always the
scheduled onset, including when tempo changes. At most 16 approaching targets
have bolts drawn at once, and at most 40 impact bursts remain alive for 550 ms.
Stopping or seeking clears those effects. No synthetic beats trigger weapons.

Distance is `cycle × 80`. BPM is already incorporated into the scheduler's cycle
clock, so changing tempo changes approach speed without relocating notes. Chord
pitches have independent identities. Destroyed sustains retain their metadata
across query-clipped bar boundaries, without reappearing or exploding again.
Duration never extrudes a target into a long ribbon. The cycle-view API exposes clipped event parts rather than whole
onset identities, so entering a mode partway through an unknown sustain can only
show the available segment.

Stopping retires the previous schedule without firing its queued events. A seek
rebuilds the flight scene at the destination. Live edits fade removed objects;
those objects cannot trigger activity while fading. Silence alone is not evidence
of a dropout, so rests do not produce warning lamps. SIGNAL BANK is an onset
display, not a per-channel audio meter.

The rail uses four panels on wide canvases, three below 860 CSS pixels, and two
below 580. Short panes show fewer signal rows with an overflow count. All scope
geometry is drawn at the host's current resolution, including DPR 2 and Stage
Mode's fixed-resolution canvas. The mode saves/restores canvas state for overlays.

Validation: `npm run build` checks the frontend integration. Visual review
should include live WASM patterns, stopped playback, dense chords, narrow
panes, and high-DPI rendering.
