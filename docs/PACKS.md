# Visualizer packs

A pack is a folder of visualizer modes and palettes that registers as a unit.
The first one is `ui/src/viz/packs/halloween-8bit/`, the Halloween scenes.
Packs are compiled into the app for now; the layout and the manifest are
what a downloadable pack will carry.

## Layout

```
ui/src/viz/packs/<pack>/
  pack.json        the manifest
  index.ts         exports the VizPack: manifest, mode defs, palettes
  README.md        what the modes are and how they're drawn
  <mode>.ts        one file per mode, exporting a VizModeDef
  lib/             code the modes share
```

## The manifest

```json
{
  "id": "naderlabs/halloween-8bit",
  "name": "Halloween, 8-bit",
  "version": "0.1.0",
  "author": "NaderLabs",
  "license": "AGPL-3.0-or-later",
  "description": "A graveyard, a haunted house, a monster band and a swamp of ghosts, all 8-bit, made for the Bustin' show.",
  "modes": ["graveyard", "haunted-house", "monster-band", "ghost-fog"],
  "palettes": ["pumpkin"]
}
```

`modes` and `palettes` must match what `index.ts` exports; `validatePack`
(`ui/src/viz/pack.ts`) throws at startup when they don't. Mode ids are what
show files name (`mode = "graveyard"`), and must be unique across the app.

## What a pack may use

Pack code imports from `ui/src/viz/sdk.ts` and nothing else under `viz/`.
The test suite checks this. The sdk exports the mode contract (`VizModeDef`,
`VizMode`, `VizServices`, `Theme`), `HapField` for modes that turn scheduled
notes into persistent objects, `TrackModel` for one-bar views,
`instrumentFamily`, and the drawing and math helpers (`hash32`, `rand01`,
`SeededRandom`, `alphaRamp`, `lerpRgb`, and so on).

## Rules every mode keeps

- **Deterministic.** The offline renderer draws the same frame from a cold
  start and from the middle of a song, and `npm run test:render` requires the
  two to match byte for byte. Use `hash32`/`rand01`/`SeededRandom` for
  anything random, never `Math.random` or the clock. Spawn objects and draw
  random numbers in `update()`; `render()` reads state and draws.
- **Recolourable.** Draw from the `Theme` handed in each frame; bake colours in
  `layout()`, which runs on entry, resize and palette change. A palette in a
  show file must recolour the mode.
- **Readable.** Keep the musical mapping legible: what fires on a kick, what a
  pitch moves, what a held note becomes. Write it in the file's header.

## Registering

A compiled-in pack is one line in `ui/src/viz/packs/index.ts`. The registry
lists built-in modes, then every pack's modes, then the end card; palettes
merge the same way, so show files, the show pane's suggestions and the
renderer see a pack's modes and palettes with no other change.

## Next

- Loading a pack from the app's data folder at startup (`import()` of its
  `index.js`), with the manifest checked first.
- Running downloaded modes in a worker with an offscreen canvas, so pack code
  can't reach the app's IPC.
- Sprite assets (PNG sheets) in a pack. The renderer must have them decoded
  before frame 0, or the seam test breaks, so assets load before a render
  starts.
- A `cycletron pack check` that runs the type check, the seam test and a
  frame-budget probe on one pack.
