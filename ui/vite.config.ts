import {defineConfig} from 'vite';
import tsc from 'vite-plugin-tsc';
import type {Plugin} from 'vite';
import {InlineEnum} from "unplugin-inline-enum";

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

export default defineConfig({
    // No base path — served from Tauri webview root
    clearScreen: false,
    build: {
        outDir: 'dist',
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
                entryFileNames: chunk =>
                    chunk.name === 'worklet' ? 'worklet.js' :
                        'assets/[name]-[hash].js',
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
        tsc(),
        InlineEnum.vite(),
        wasmMemoryLeakFixPlugin()
    ]
});