/**
 * Ordered registry of ambient visualizer modes. This list is the single
 * source of truth: HUD labels, the Visuals menu, keyboard cycling, auto-cycle,
 * and persistence (by stable `id`) all derive from it. To add a mode, write
 * `viz/modes/<id>.ts` and append its def here.
 */

import type {VizModeDef} from './types.js';
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

export const VIZ_MODES: readonly VizModeDef[] = [
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
];

/** Resolve a persisted mode id to its registry index; unknown ids → 0. */
export function modeIndexById(id: string | null): number {
    if (!id) return 0;
    const idx = VIZ_MODES.findIndex((m) => m.id === id);
    return idx >= 0 ? idx : 0;
}
