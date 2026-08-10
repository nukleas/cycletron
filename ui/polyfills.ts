declare const currentTime: number | undefined;

const isWorklet = typeof AudioWorkletProcessor !== 'undefined';

if (isWorklet) {
    if (typeof TextEncoder === 'undefined') {
        (globalThis as any).TextEncoder = class TextEncoder {
            encode(str: string) {
                const s = str || "";
                const arr = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
                return arr;
            }
        };
    }

    if (typeof TextDecoder === 'undefined') {
        (globalThis as any).TextDecoder = class TextDecoder {
            // wasm-bindgen calls this with no args initially, or a Uint8Array
            decode(arr?: Uint8Array | ArrayBufferView) {
                if (!arr) return "";
                // Use a loop for large buffers to avoid "Maximum call stack size exceeded"
                // which happens with String.fromCharCode.apply on large arrays.
                let str = "";
                // noinspection SuspiciousTypeOfGuard
                const view = arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
                for (let i = 0; i < view.length; i++) {
                    str += String.fromCharCode(view[i]);
                }
                return str;
            }
        };
    }

    if (typeof crypto === 'undefined') {
        // Seed with high-res time to ensure a unique random sequence every session
        let seed = (Date.now() ^ ((typeof currentTime !== 'undefined' ? currentTime : 0) * 1000000)) & 0x7FFFFFFF;

        globalThis.crypto = {
            getRandomValues: (b: Uint8Array | Uint32Array) => {
                // noinspection SuspiciousTypeOfGuard
                const is32 = b instanceof Uint32Array;
                for (let i = 0; i < b.length; i++) {
                    // LCG: x = (a * x + c) % m. Fast, non-repeating for ~2 billion calls.
                    seed = (Math.imul(1103515245, seed) + 12345) & 0x7FFFFFFF;
                    b[i] = is32 ? seed : (seed & 0xFF);
                }
                return b;
            }
        } as any;
    }
}

export {};