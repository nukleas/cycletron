/**
 * Loads a built visualizer pack at runtime. A pack's `dist/index.js` is an
 * ES module with one external import, `@cycletron/viz-sdk`, which the import
 * map in the page resolves to the app's sdk. The source is imported from a
 * Blob URL, so nothing depends on where the file came from.
 */

import {sdkSatisfies, validatePack, type VizPack} from './pack.js';
import {SDK_VERSION} from './sdk.js';
import {registerPack} from './registry.js';
import {invoke, isTauri} from '../tauri.js';
import {diag} from '../diagnostics.js';
import type {VizPackSource} from '../types/tauri-commands.js';

/** Ids of the packs loaded so far, so a pack enabled later isn't loaded twice. */
export const LOADED_PACKS = new Set<string>();

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
    if (pack.manifest.sdk && !sdkSatisfies(pack.manifest.sdk, SDK_VERSION)) {
        throw new Error(`${pack.manifest.id} needs sdk ${pack.manifest.sdk}; this Cycletron has ${SDK_VERSION}`);
    }
    registerPack(pack);
    LOADED_PACKS.add(pack.manifest.id);
    return pack;
}

/**
 * Load the library's enabled visualizer packs that aren't loaded yet. Returns
 * the ids loaded now; a pack that fails is reported through `onError` and
 * skipped.
 */
export async function loadLibraryPacks(onError: (id: string, message: string) => void): Promise<string[]> {
    if (!isTauri) return [];
    let packs: VizPackSource[];
    try {
        packs = await invoke<VizPackSource[]>('list_viz_packs');
    } catch (e) {
        void diag('warn', 'viz-packs', `couldn't list packs: ${String(e)}`);
        return [];
    }
    const loaded: string[] = [];
    for (const p of packs) {
        if (LOADED_PACKS.has(p.id)) continue;
        try {
            await loadPackSource(p.source, p.id);
            void diag('info', 'viz-packs', `loaded ${p.id} from ${p.path}`);
            loaded.push(p.id);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            void diag('error', 'viz-packs', `${p.id} failed to load: ${message}`);
            onError(p.id, message);
        }
    }
    return loaded;
}

function isPack(v: unknown): v is VizPack {
    return typeof v === 'object' && v !== null && 'manifest' in v && 'modes' in v && 'palettes' in v;
}
