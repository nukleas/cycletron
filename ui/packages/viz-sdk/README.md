# @cycletron/viz-sdk

The surface a Cycletron visualizer pack builds against. A pack imports this
package and nothing else from the app; the app's own modes import it too, so
there is one list of what a mode can see (`src/index.ts`).

- `types.ts` — the mode contract: `VizModeDef`, `VizMode`, `VizServices`,
  `Theme`, and `PatternQuery`, the slice of the engine's pattern handle the
  sdk reads.
- `hap-field.ts` — scheduled haps as persistent objects (`HapField`).
- `tracks.ts` — the per-bar track model (`TrackModel`) and the cycle-view
  buffer constants.
- `util.ts` — hashing, seeded random, colour and label helpers.
- `pixel.ts` — the 320x180 pixel screen and bitmap sprites.
- `pack.ts` — the pack manifest and `validatePack`.

The package ships its TypeScript source; consumers resolve it with
`moduleResolution: "bundler"`. At runtime the app provides the implementation
through an import map, so a built pack keeps `@cycletron/viz-sdk` as an
external import. The package version is the sdk version a pack's manifest
ranges over (`"sdk": "^1"`); a breaking change bumps the major.

Rules and the build are in `docs/PACKS.md`.
