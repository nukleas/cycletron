/**
 * Ordered registry of ambient visualizer modes. This list is the single
 * source of truth: HUD labels, the Visuals menu, keyboard cycling, auto-cycle,
 * and persistence (by stable `id`) all derive from it. To add a mode, write
 * `viz/modes/<id>.ts` and append its def here, or ship it in a pack
 * (`viz/packs/`). The end card stays last.
 */

import type {VizModeDef, VizPack} from '@cycletron/viz-sdk';
import {neonCircuitDef} from './modes/neon-circuit.js';
import {marbleCoreDef} from './modes/marble-core.js';
import {marbleDropDef} from './modes/marble-drop.js';
import {flameGraphDef} from './modes/flame-graph.js';
import {lissajousDef} from './modes/lissajous.js';
import {waveTerrainDef} from './modes/wave-terrain.js';
import {tunnelDef} from './modes/tunnel.js';
import {attractorDef} from './modes/attractor.js';
import {plasmaDef} from './modes/plasma.js';
import {kaleidoscopeDef} from './modes/kaleidoscope.js';
import {asciiScopeDef} from './modes/ascii-scope.js';
import {matrixRainDef} from './modes/matrix-rain.js';
import {isoCityDef} from './modes/iso-city.js';
import {lensBenchDef} from './modes/lens-bench.js';
import {spotFieldDef} from './modes/spot-field.js';
import {vectorNexusDef} from './modes/vector-nexus.js';
import {forestDriveDef} from './modes/forest-drive.js';
import {cockpitDef} from './modes/cockpit.js';
import {tankFieldDef} from './modes/tank-field.js';
import {starRoadDef} from './modes/star-road.js';
import {logoDef} from './modes/logo.js';
import {PACKS} from './packs/index.js';
import {registerPalettes} from './palettes.js';

const modes: VizModeDef[] = [
    neonCircuitDef,
    marbleCoreDef,
    marbleDropDef,
    flameGraphDef,
    lissajousDef,
    waveTerrainDef,
    tunnelDef,
    attractorDef,
    plasmaDef,
    kaleidoscopeDef,
    asciiScopeDef,
    matrixRainDef,
    isoCityDef,
    lensBenchDef,
    spotFieldDef,
    vectorNexusDef,
    forestDriveDef,
    cockpitDef,
    tankFieldDef,
    starRoadDef,
    logoDef,
];

/** Every mode, in menu order. Packs add theirs before the end card; the array is mutated in place, so hold the reference. */
export const VIZ_MODES: readonly VizModeDef[] = modes;

/** Add a pack's modes and palettes. Throws on an id already taken. */
export function registerPack(pack: VizPack): void {
    for (const m of pack.modes) {
        if (modes.some((o) => o.id === m.id)) throw new Error(`pack ${pack.manifest.id}: a mode with id '${m.id}' is already registered`);
    }
    registerPalettes(pack.manifest.id, pack.palettes);
    modes.splice(modes.length - 1, 0, ...pack.modes);
}

for (const pack of PACKS) registerPack(pack);

/** Resolve a persisted mode id to its registry index; unknown ids → 0. */
export function modeIndexById(id: string | null): number {
    if (!id) return 0;
    const idx = VIZ_MODES.findIndex((m) => m.id === id);
    return idx >= 0 ? idx : 0;
}
