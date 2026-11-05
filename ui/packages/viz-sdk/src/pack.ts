/**
 * A visualizer pack: modes and palettes that register as a unit. A pack's
 * `src/index.ts` exports one; the app loads it from the pack's build
 * (`ui/src/viz/pack-loader.ts`).
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
    /** What's in it, in a sentence. */
    description: string;
    /** The sdk versions the pack was built for: `^1`, `^1.2`, `1.x` or an exact version. */
    sdk?: string;
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

/**
 * Whether sdk `version` satisfies `range`: `^1`, `^1.2`, `1`, `1.x`, or an
 * exact version. Same major, and at least the minor the range names.
 */
export function sdkSatisfies(range: string, version: string): boolean {
    const want = /^\^?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(range.trim());
    const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!want || !have) return false;
    const [, major, minor] = want;
    if (Number(major) !== Number(have[1])) return false;
    if (minor === undefined || minor === 'x') return true;
    return Number(have[2]) >= Number(minor);
}
