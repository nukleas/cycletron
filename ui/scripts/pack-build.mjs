#!/usr/bin/env node
// Build a visualizer pack: `src/index.ts` into `dist/index.js`, one ES module
// with the sdk left as the external import `@cycletron/viz-sdk`, which the app
// resolves through its import map when it loads the pack.
//
// Usage:
//   node scripts/pack-build.mjs <pack-dir>
//
// The pack dir holds pack.json and src/. The app type-checks nothing here;
// run `npx tsc` against the pack with the repo's tsconfig paths if you want
// types checked.

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPack(dir) {
    const root = path.resolve(dir);
    const manifestPath = path.join(root, 'pack.json');
    if (!existsSync(manifestPath)) throw new Error(`${root}: no pack.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = path.join(root, 'src', 'index.ts');
    if (!existsSync(entry)) throw new Error(`${root}: no src/index.ts`);
    await build({
        configFile: false,
        root,
        logLevel: 'warn',
        resolve: {alias: {'@cycletron/viz-sdk': path.join(UI, 'src/viz/sdk.ts')}},
        build: {
            outDir: path.join(root, 'dist'),
            emptyOutDir: true,
            target: 'es2022',
            minify: false,
            lib: {entry, formats: ['es'], fileName: () => 'index.js'},
            rollupOptions: {external: ['@cycletron/viz-sdk']},
        },
    });
    return {manifest, out: path.join(root, 'dist', 'index.js')};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dir = process.argv[2];
    if (!dir) {
        console.error('usage: pack-build.mjs <pack-dir>');
        process.exit(2);
    }
    const {manifest, out} = await buildPack(dir);
    console.error(`${manifest.id} → ${out}`);
}
