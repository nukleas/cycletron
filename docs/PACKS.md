# Visualizer packs

A pack is a folder of visualizer modes and palettes that the app loads at
startup, so a pack and the songs and shows made for it can travel together.
The first one is the Halloween pack in the music library:

```
~/Code/strulibrary/Packs/halloween/        a library pack
  pack.json          schema 1, id (= the folder name), name, version, authors,
                     license, description, then any of: banks (samples),
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

## The library pack manifest

`Packs/*/pack.json` is the same file sample packs use (`src-tauri/src/packs.rs`):
`schema: 1`, an `id` equal to the folder name, `name`, `version`, `authors`,
`license` (an SPDX id) and `description`. A pack carries whichever sections it
has: `banks` of samples (with a `license_file`), `viz` folders, `songs` and
`shows`. The sample manager lists packs with banks; the visualizer loader reads
`viz`.

## The viz manifest

```json
{
  "id": "naderlabs/halloween-8bit",
  "name": "Halloween, 8-bit",
  "version": "0.1.0",
  "author": "NaderLabs",
  "license": "AGPL-3.0-or-later",
  "sdk": "^1",
  "description": "A graveyard, a haunted house, a monster band and a swamp of ghosts, all 8-bit, made for the Bustin' show.",
  "modes": ["graveyard", "haunted-house", "monster-band", "ghost-fog"],
  "palettes": ["pumpkin"]
}
```

The two manifests have different ids on purpose: the library pack's `id` is
its folder name (`halloween`), the viz pack's is `author/name`
(`naderlabs/halloween-8bit`), the name the loader and its errors use.

`sdk` is the sdk range the pack was built for (`^1`); the loader refuses a
pack whose range this Cycletron's `SDK_VERSION` doesn't satisfy. `modes` and
`palettes` must match what `src/index.ts` exports; `validatePack`
(`ui/src/viz/pack.ts`) throws when they don't. Mode ids are what show files
name (`mode = "graveyard"`) and must be unique across the app. `src/index.ts`
exports the `VizPack` as its default export.

## What a pack may use

Pack code imports `@cycletron/viz-sdk` and nothing else from the app. That is
`ui/src/viz/sdk.ts`: the mode contract (`VizModeDef`, `VizMode`,
`VizServices`, `Theme`), `HapField` for modes that turn scheduled notes into
persistent objects, `TrackModel` for one-bar views, `instrumentFamily`, the
drawing and math helpers (`hash32`, `rand01`, `SeededRandom`, `alphaRamp`,
`lerpRgb`, and so on), the 320×180 pixel screen for 8-bit modes (`PxScreen`,
`spr` bitmaps, `drawSprite`, `frameRect`, `fillTri`, `nearest`; sdk 1.1), and
`validatePack`. Inside the repo the name resolves
to the source (`tsconfig.json` paths and the vite alias); a built pack keeps
it as an external import that the page's import map resolves.

## Building

```sh
cd ui && node scripts/pack-build.mjs ~/Code/strulibrary/Packs/halloween/viz/halloween-8bit
```

Type-checks `src/` against the sdk with the repo's settings (a pack needs no
tsconfig; `--no-check` skips it), then bundles `src/index.ts` into
`dist/index.js`, one ES module with the sdk left external. The show renderer
does this itself when `src/` is newer than the build.

To check a pack's determinism, run the seam test on its build:

```sh
VIZ_PACK=<viz pack folder> npm run test:render
```

Author a pack outside `Packs/` (a `_` folder in the library is fine) and
install it; a folder dropped straight into `Packs/` skips the install checks.

## Loading

- **The app** asks the backend for every `Packs/*/pack.json` in the library,
  reads each `viz` folder's `dist/index.js`, imports it from a Blob URL and
  registers it (`ui/src/viz/pack-loader.ts`, called from `boot.ts` before
  anything draws). The import map in `index.html` maps `@cycletron/viz-sdk` to
  the app's sdk: the source in dev, the `viz-sdk.js` chunk in a build. A pack
  that fails to load is reported in a notification; the app goes on without it.
- **The renderer** (`ui/scripts/render-viz.mjs`) finds the nearest `pack.json`
  above the show file, builds its `viz` folders if stale, registers them for
  the parser, and passes their sources to the render page.
- **Registration** appends a pack's modes before the end card and its palettes
  after the built-in ones (`registerPack` in `ui/src/viz/registry.ts`). Show
  files, the show pane's suggestions and the Visuals menu see them with no
  other change.

## Installing and enabling

A pack arrives as a folder or a `.zip` with `pack.json` at its root (or one
folder down). Drop it on the window, or open the Samples panel (the command
palette's "Samples… (sets & packs)", or Manage in the Sounds panel) and use
Install from Folder… / Install from Zip…. A zip with a `pack.json` is staged
whole, code and all; one without is treated as samples and only its audio is
read. The dialog shows the pack's name, author, license and what it carries; a
pack with visualizer code says so, since that code runs inside the app with
the app's permissions. Install copies the folder to `Packs/<id>/` and enables
it, and its visualizers load right away. Installing a pack whose id is already
installed offers to replace it; the pack keeps its enabled state, and new
visualizer code loads at the next launch.

Only enabled packs load. `Packs/enabled.json` lists them; the Samples panel
toggles any installed pack, with or without sample banks. A pack copied into
`Packs/` by hand shows up there disabled until you enable it. Disabling takes
effect at the next launch.

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
- A `pack check` command: the seam test and a frame-budget probe on one pack
  in one step (the type check runs in the build; the seam test is a `VIZ_PACK`
  run of `npm run test:render`).
- Installing from a URL, and a community index to pick from.
