/**
 * Packs compiled into the app. None today: packs load at startup from the
 * library (each pack.json under Packs, its `viz` folders with a built
 * dist/index.js), see `viz/pack-loader.ts` and docs/PACKS.md.
 */

import type {VizPack} from '@cycletron/viz-sdk';

export const PACKS: readonly VizPack[] = [];
