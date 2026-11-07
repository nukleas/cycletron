import {defineConfig} from 'vite';
import tsc from 'vite-plugin-tsc';
import type {Plugin} from 'vite';
import {InlineEnum} from "unplugin-inline-enum";
import {readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';

function wasmMemoryLeakFixPlugin(): Plugin {
    return {
        name: 'wasm-memory-leak-fix',
        transform(code, id) {
            if (!id.endsWith('strudel_audio_wasm.js')) return;

            const freeKeys = [...code.matchAll(/\b(__wbg_\w+_free)\b/g)]
                .map(m => m[1])
                .filter((v, i, a) => a.indexOf(v) === i); // dedupe

            // Only assign to cache variables that are actually declared in the
            // generated module. Wasm-bindgen omits the ones JS never reads
            // (e.g. cachedFloat32ArrayMemory0 isn't emitted for this build),
            // and assigning to an undeclared name in a strict-mode module
            // throws ReferenceError — silently rejecting the dispose promise.
            const cacheCandidates = [
                'cachedDataViewMemory0',
                'cachedFloat32ArrayMemory0',
                'cachedUint8ArrayMemory0',
                'cachedInt32ArrayMemory0',
                'cachedFloat64ArrayMemory0',
            ];
            const presentCacheVars = cacheCandidates.filter(name =>
                new RegExp(`\\blet\\s+${name}\\b`).test(code),
            );

            const entries = freeKeys.map(k => `    ${k}: _noop,`).join('\n');
            const cacheResets = presentCacheVars
                .map(name => `    ${name} = null;`)
                .join('\n');

            // After __drop_wasm() leaves wasm = _deadWasm, wasm-bindgen's init
            // guard (`if (wasm !== undefined) return wasm;`) would short-circuit
            // the re-init we need on a worklet-crash recovery — it sees a
            // defined `wasm` and bails, leaving the dead stub installed and
            // every subsequent `wasm.X()` call throwing "X is not a function".
            // Widen the guard to also treat _deadWasm as "not initialized" so
            // a fresh init can reassign the real exports.
            const patchedCode = code.replace(
                /if \(wasm !== undefined\) return wasm;/g,
                'if (wasm !== undefined && wasm !== _deadWasm) return wasm;',
            );

            const patch = `
const _noop = () => {};
const _deadWasm = {
${entries}
};

export function __drop_wasm() {
    wasm = _deadWasm;
    wasmModule = null;
${cacheResets}
    heap.length = 0;
}`;

            return patchedCode + '\n' + patch;
        }
    };
}

// `_*` folders are local staging (gitignored), but vite copies all of
// `public/` into the build, so one left there would ship in the app.
function noPrivatePublicDirsPlugin(): Plugin {
    let publicDir = '';
    return {
        name: 'no-private-public-dirs',
        apply: 'build',
        configResolved(config) {
            publicDir = config.publicDir;
        },
        buildStart() {
            const found = readdirSync(publicDir).find((name) => name.startsWith('_'));
            if (found) this.error(`${join(publicDir, found)} is private staging; move it out of public/ before building`);
        },
    };
}

// Visualizer packs import the sdk as `@cycletron/viz-sdk`, the workspace
// package in packages/viz-sdk. In the app that resolves to its source; a pack
// loaded at runtime resolves it through the import map in index.html, which
// this plugin points at the built sdk chunk.
// The chunk is emitted here, not as an input, so its exports keep their names:
// vite builds app entries with preserveEntrySignatures off, which would mangle them.
function vizSdkPlugin(base: string): Plugin {
    return {
        name: 'viz-sdk',
        apply: 'build',
        buildStart() {
            this.emitFile({
                type: 'chunk',
                id: resolve(import.meta.dirname, 'packages/viz-sdk/src/index.ts'),
                fileName: 'viz-sdk.js',
                preserveSignature: 'strict',
            });
        },
        transformIndexHtml(html) {
            return html.replace('"@cycletron/viz-sdk": "/packages/viz-sdk/src/index.ts"', `"@cycletron/viz-sdk": "${base}viz-sdk.js"`);
        },
        generateBundle(_options, bundle) {
            const sdk = bundle['viz-sdk.js'];
            if (sdk?.type !== 'chunk' || !sdk.exports.includes('HapField')) {
                this.error('viz-sdk.js lost its named exports; packs import the sdk by name');
            }
        },
    };
}

/** Where the web build is served on cycletron.naderlabs.io. */
const WEB_BASE = '/play/';

// The web build's page: restore-saved.js is a plain script Vite doesn't
// rewrite, so give it the base; and the web-only stylesheet hides what needs
// the desktop shell (saving, export, AI, MIDI, …).
function webIndexPlugin(): Plugin {
    return {
        name: 'web-index',
        transformIndexHtml: {
            // Before Vite collects the page's scripts and styles.
            order: 'pre',
            handler: (html) => html
                .replace('<script src="restore-saved.js" vite-ignore></script>', `<script src="${WEB_BASE}restore-saved.js"></script>`)
                .replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n    <link rel="stylesheet" href="web.css">'),
        },
    };
}

export default defineConfig(({mode}) => ({
    // No base path — served from Tauri webview root. The web build
    // (`--mode web`) is the app on cycletron.naderlabs.io, under /play/.
    base: mode === 'web' ? WEB_BASE : '/',
    clearScreen: false,
    build: {
        outDir: mode === 'web' ? 'dist-web' : 'dist',
        assetsDir: 'assets',
        rollupOptions: {
            input: {
                main: 'index.html',
                // Compile worklet.ts as a separate self-contained script.
                // audio-manager.ts loads it via addModule('worklet.js') at runtime,
                // so it must land at the root of the output directory as worklet.js.
                worklet: 'worklet.ts',
            },
            output: {
                entryFileNames: chunk => chunk.name === 'worklet' ? 'worklet.js' : 'assets/[name]-[hash].js',
                manualChunks: (id) => {
                    // Never pull worklet code into shared chunks - it must remain
                    // a standalone script with no dynamic imports.
                    if (id.includes('worklet')) return undefined;
                    if (id.includes('codemirror') || id.includes('@codemirror') || id.includes('@lezer')) {
                        return 'codemirror';
                    }
                },
            }
        }
    },
    server: {
        port: 5173,
        strictPort: true,
        // Allow importing curated corpus demos from the monorepo root.
        fs: {
            allow: ['.', '..', '../corpus'],
        },
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            // Marks every asset (wasm, worklet, samples) as embeddable
            // under COEP: require-corp; without this, the WKWebView
            // refuses to expose SharedArrayBuffer even with COOP/COEP set.
            'Cross-Origin-Resource-Policy': 'same-origin'
        },
        watch: {
            ignored: ['**/src-tauri/**'],
        }
    },
    optimizeDeps: {
        exclude: ['./pkg/strudel_audio_wasm.js']
    },
    plugins: [
        // The headless renderer (scripts/render-viz.mjs) serves in mode
        // 'render' and needs no type-check watcher.
        ...(mode === 'render' ? [] : [tsc()]),
        InlineEnum.vite(),
        wasmMemoryLeakFixPlugin(),
        noPrivatePublicDirsPlugin(),
        vizSdkPlugin(mode === 'web' ? WEB_BASE : '/'),
        ...(mode === 'web' ? [webIndexPlugin()] : []),
    ]
}));
