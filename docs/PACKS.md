# Visualizer packs

A pack is a folder of visualizer modes and palettes that the app loads at
startup, so a pack and the songs and shows made for it can travel together.
The first one is the Halloween pack in the music library:

```
~/Code/strulibrary/Packs/halloween/        a content pack
  pack.json          id, name, version, author, license, description,
                     viz: ["viz/halloween-8bit"], songs: [...], shows: [...]
  viz/halloween-8bit/                      the visualizer pack it plays on
    pack.json        the viz manifest (below)
    src/index.ts     exports the VizPack: manifest, mode defs, palettes
    src/<mode>.ts    one file per mode, exporting a VizModeDef
    src/lib/         code the modes share
    dist/index.js    the build the app loads
    README.md
  songs/  shows/  renders/
```

## The viz manifest

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

`modes` and `palettes` must match what `src/index.ts` exports; `validatePack`
(`ui/src/viz/pack.ts`) throws when they don't. Mode ids are what show files
name (`mode = "graveyard"`) and must be unique across the app. `src/index.ts`
exports the `VizPack` as its default export.

## What a pack may use

Pack code imports `cycletron/viz-sdk` and nothing else from the app. That is
`ui/src/viz/sdk.ts`: the mode contract (`VizModeDef`, `VizMode`,
`VizServices`, `Theme`), `HapField` for modes that turn scheduled notes into
persistent objects, `TrackModel` for one-bar views, `instrumentFamily`, the
drawing and math helpers (`hash32`, `rand01`, `SeededRandom`, `alphaRamp`,
`lerpRgb`, and so on), and `validatePack`. Inside the repo the name resolves
to the source (`tsconfig.json` paths and the vite alias); a built pack keeps
it as an external import that the page's import map resolves.

## Building

```sh
cd ui && node scripts/pack-build.mjs ~/Code/strulibrary/Packs/halloween/viz/halloween-8bit
```

Bundles `src/index.ts` into `dist/index.js`, one ES module with the sdk left
external. The show renderer does this itself when `src/` is newer than the
build.

## Loading

- **The app** asks the backend for every `Packs/*/pack.json` in the library,
  reads each `viz` folder's `dist/index.js`, imports it from a Blob URL and
  registers it (`ui/src/viz/pack-loader.ts`, called from `boot.ts` before
  anything draws). The import map in `index.html` maps `cycletron/viz-sdk` to
  the app's sdk: the source in dev, the `viz-sdk.js` chunk in a build. A pack
  that fails to load is reported in a notification; the app goes on without it.
- **The renderer** (`ui/scripts/render-viz.mjs`) finds the nearest `pack.json`
  above the show file, builds its `viz` folders if stale, registers them for
  the parser, and passes their sources to the render page.
- **Registration** appends a pack's modes before the end card and its palettes
  after the built-in ones (`registerPack` in `ui/src/viz/registry.ts`). Show
  files, the show pane's suggestions and the Visuals menu see them with no
  other change.

## Rules every mode keeps

- **Deterministic.** The renderer draws the same frame from a cold start and
  from the middle of a song, and `npm run test:render` requires the two to
  match byte for byte, for built-in modes and for a pack loaded from its
  build. Use `hash32`/`rand01`/`SeededRandom` for anything random, never
  `Math.random` or the clock. Spawn objects and draw random numbers in
  `update()`; `render()` reads state and draws.
- **Recolourable.** Draw from the `Theme` handed in each frame; bake colours in
  `layout()`, which runs on entry, resize and palette change.
- **Readable.** Keep the musical mapping legible: what fires on a kick, what a
  pitch moves, what a held note becomes. Write it in the file's header.

## Not yet

- A sandbox: pack code runs in the page, so only packs you trust belong in
  the library. A worker with an offscreen canvas is the next step.
- Sprite assets (PNG sheets). The renderer must have them decoded before frame
  0, so assets load before a render starts.
- A `pack check` command: type check, the seam test and a frame-budget probe
  on one pack.
- Installing a pack from a zip or URL; today a pack is a folder in `Packs/`.
