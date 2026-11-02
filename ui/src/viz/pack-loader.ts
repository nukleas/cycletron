/**
 * Loads a built visualizer pack at runtime. A pack's `dist/index.js` is an
 * ES module with one external import, `cycletron/viz-sdk`, which the import
 * map in the page resolves to the app's sdk. The source is imported from a
 * Blob URL, so nothing depends on where the file came from.
 */

import {validatePack, type VizPack} from './pack.js';
import {registerPack} from './registry.js';

/** Import a pack's built module from its source text and register it. */
export async function loadPackSource(source: string, from = 'a pack'): Promise<VizPack> {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    let mod: Record<string, unknown>;
    try {
        mod = await import(/* @vite-ignore */ url);
    } finally {
        URL.revokeObjectURL(url);
    }
    const pack = (mod.default ?? mod.pack ?? Object.values(mod).find(isPack)) as VizPack | undefined;
    if (!pack || !isPack(pack)) throw new Error(`${from} doesn't export a VizPack`);
    validatePack(pack);
    registerPack(pack);
    return pack;
}

function isPack(v: unknown): v is VizPack {
    return typeof v === 'object' && v !== null && 'manifest' in v && 'modes' in v && 'palettes' in v;
}
