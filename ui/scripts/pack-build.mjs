#!/usr/bin/env node
// Build a visualizer pack: type-check `src/`, then bundle `src/index.ts` into
// `dist/index.js`, one ES module with the sdk left as the external import
// `@cycletron/viz-sdk`, which the app resolves through its import map when it
// loads the pack.
//
// Usage:
//   node scripts/pack-build.mjs <pack-dir> [--no-check]
//
// The pack dir holds pack.json and src/. The type check runs tsc with the
// repo's settings and the sdk path mapped, so a pack needs no tsconfig of its
// own; --no-check skips it.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = path.join(UI, 'src/viz/sdk.ts');

/** Type-check a pack's src/ against the sdk. Throws with tsc's output on errors. */
export function checkPack(dir) {
    const root = path.resolve(dir);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pack-check-'));
    try {
        const config = path.join(tmp, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({
            compilerOptions: {
                target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
                strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true,
                useDefineForClassFields: false, resolveJsonModule: true, skipLibCheck: true, noEmit: true, types: [],
                paths: {'@cycletron/viz-sdk': [SDK]},
            },
            include: [path.join(root, 'src')],
        }));
        const tsc = path.join(UI, 'node_modules', '.bin', 'tsc');
        const run = spawnSync(tsc, ['-p', config, '--pretty', 'false'], {encoding: 'utf8'});
        if (run.status !== 0) {
            throw new Error(`${root}: type errors\n${(run.stdout + run.stderr).trim()}`);
        }
    } finally {
        rmSync(tmp, {recursive: true, force: true});
    }
}

export async function buildPack(dir, {check = true} = {}) {
    const root = path.resolve(dir);
    const manifestPath = path.join(root, 'pack.json');
    if (!existsSync(manifestPath)) throw new Error(`${root}: no pack.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = path.join(root, 'src', 'index.ts');
    if (!existsSync(entry)) throw new Error(`${root}: no src/index.ts`);
    if (check) checkPack(root);
    await build({
        configFile: false,
        root,
        logLevel: 'warn',
        resolve: {alias: {'@cycletron/viz-sdk': SDK}},
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
    const args = process.argv.slice(2);
    const check = !args.includes('--no-check');
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) {
        console.error('usage: pack-build.mjs <pack-dir> [--no-check]');
        process.exit(2);
    }
    const {manifest, out} = await buildPack(dir, {check});
    console.error(`${manifest.id} → ${out}`);
}
