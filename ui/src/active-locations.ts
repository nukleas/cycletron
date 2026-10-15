/**
 * Source spans of the notes sounding now, read back from the engine's
 * active-locations buffer. Shared by the live app (editor + Stage Mode
 * highlights) and the offline renderer, so a render lights the same tokens
 * the stage does.
 */

export interface SourceRange {
    from: number;
    to: number;
}

export class ActiveLocations {
    /** Cached byte→char offset map for `mapCode`. */
    private map: Uint32Array | null = null;
    private mapCode = '';

    constructor(
        private readonly memory: WebAssembly.Memory,
        /** `getActiveLocsBufPtr()` from the WASM module. */
        private readonly ptr: number,
    ) {}

    /**
     * Ranges (char offsets into `code`) for the `count` words a
     * `queryActiveLocations` call just wrote, de-duplicated.
     */
    ranges(count: number, code: string): SourceRange[] {
        const locs = new Uint32Array(this.memory.buffer, this.ptr, count);
        const b2c = this.byteToChar(code);
        const ranges: SourceRange[] = [];
        const seen = new Set<string>();

        // The engine packs each active location as a 3-tuple: (startByte,
        // endByte, colorRGB). We highlight the source span and ignore the colour.
        // The stride must be 3 — reading 2-tuples misaligns every entry.
        for (let i = 0; i + 2 < count; i += 3) {
            const fromByte = locs[i];
            const toByte = locs[i + 1];
            const from = fromByte < b2c.length ? b2c[fromByte] : fromByte;
            const to = toByte < b2c.length ? b2c[toByte] : toByte;
            if (from < code.length && to <= code.length && from < to) {
                const key = `${from}-${to}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    ranges.push({from, to});
                }
            }
        }
        return ranges;
    }

    /** Byte-offset → char-offset table for `code`, rebuilt only when it changes. */
    private byteToChar(code: string): Uint32Array {
        if (this.map && this.mapCode === code) return this.map;

        const bytes = new TextEncoder().encode(code);
        // Map: for each byte index, what is the char index?
        const map = new Uint32Array(bytes.length + 1);
        let charIdx = 0;
        let byteIdx = 0;
        while (charIdx < code.length) {
            map[byteIdx] = charIdx;
            const cp = code.codePointAt(charIdx)!;
            const byteLen = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
            const charLen = cp > 0xffff ? 2 : 1;
            for (let j = 1; j < byteLen; j++) {
                map[byteIdx + j] = charIdx; // mid-codepoint bytes map to same char
            }
            byteIdx += byteLen;
            charIdx += charLen;
        }
        map[byteIdx] = charIdx; // sentinel at end
        this.map = map;
        this.mapCode = code;
        return map;
    }
}
