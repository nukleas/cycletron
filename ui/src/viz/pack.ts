/**
 * A visualizer pack: modes and palettes that register as a unit. Today packs
 * are compiled in (see `packs/index.ts`); the manifest is what a downloaded
 * pack will carry.
 */

import type {VizModeDef} from './types.js';

/** A named palette: background, three accents, two more, then three track colours. */
export interface Swatch {
    bg: string;
    neon: string;
    secondary: string;
    active: string;
    violet: string;
    red: string;
    more: [string, string, string];
}

export interface PackManifest {
    /** `author/name`, stable. */
    id: string;
    name: string;
    version: string;
    author: string;
    license: string;
    /** Who made it and how, in a sentence. */
    provenance: string;
    /** Mode ids the pack registers, as show files name them. */
    modes: string[];
    /** Palette names the pack registers. */
    palettes: string[];
}

export interface VizPack {
    manifest: PackManifest;
    modes: readonly VizModeDef[];
    palettes: Readonly<Record<string, Swatch>>;
}

/** Throws when the manifest and the code disagree. */
export function validatePack(pack: VizPack): VizPack {
    const {manifest} = pack;
    const modeIds = pack.modes.map((m) => m.id);
    for (const id of manifest.modes) {
        if (!modeIds.includes(id)) throw new Error(`pack ${manifest.id} lists mode '${id}' but doesn't export it`);
    }
    for (const id of modeIds) {
        if (!manifest.modes.includes(id)) throw new Error(`pack ${manifest.id} exports mode '${id}' but its manifest doesn't list it`);
    }
    const names = Object.keys(pack.palettes);
    for (const name of manifest.palettes) {
        if (!names.includes(name)) throw new Error(`pack ${manifest.id} lists palette '${name}' but doesn't export it`);
    }
    for (const name of names) {
        if (!manifest.palettes.includes(name)) throw new Error(`pack ${manifest.id} exports palette '${name}' but its manifest doesn't list it`);
    }
    return pack;
}
