/**
 * Query timing profiler — a removable diagnostic for the "song gets choppy the
 * longer it plays" bug.
 *
 * Hypothesis under test: per-call cost of the WASM pattern queries scales with
 * the absolute cycle index (i.e. a combinator re-walks from cycle 0), so the
 * main thread does steadily more work as the clock climbs, and recovers when
 * playback stops and the cycle resets to 0.
 *
 * To confirm/refute we bucket every measured call by cycle range and print the
 * average duration per bucket. If avg ms climbs with the cycle bucket → engine
 * cost is O(cycle) and the fix belongs in strudel-rs. If it stays flat → the
 * jank is elsewhere (GC / layout) and we go to a sampling profile.
 *
 * Enable at runtime (no rebuild needed):
 *   localStorage.setItem('queryProfiler', '1'); // then reload + play
 * Disable:
 *   localStorage.removeItem('queryProfiler');
 * Dump on demand from the console:
 *   __queryProfilerReport()
 */

const CYCLE_BUCKET = 16; // group samples into 16-cycle bands

interface Bucket {
    sum: number;
    count: number;
    max: number;
}

interface LabelStats {
    // keyed by floor(cycle / CYCLE_BUCKET)
    buckets: Map<number, Bucket>;
    totalCount: number;
}

const stats = new Map<string, LabelStats>();
let enabled = false;
let lastReport = 0;
const REPORT_INTERVAL_MS = 5000;

// Optional memory sources, wired by the app. WASM linear memory only ever
// grows; if byteLength climbs steadily during playback that's the leak, and it
// explains query times rising (allocator pressure / GC) even though native
// benchmarks show the pattern query itself is O(1) in the cycle index.
let wasmMemory: WebAssembly.Memory | null = null;
let memSamples: {cycle: number; wasmMB: number; jsMB: number}[] = [];

export function setWasmMemory(mem: WebAssembly.Memory): void {
    wasmMemory = mem;
}

function sampleMemory(cycle: number): void {
    const wasmMB = wasmMemory ? wasmMemory.buffer.byteLength / 1048576 : 0;
    // performance.memory is Chromium-only; undefined on WebKit (Tauri/mac).
    const jsHeap = (performance as unknown as {memory?: {usedJSHeapSize: number}}).memory;
    const jsMB = jsHeap ? jsHeap.usedJSHeapSize / 1048576 : 0;
    memSamples.push({cycle: Math.round(cycle), wasmMB: +wasmMB.toFixed(1), jsMB: +jsMB.toFixed(1)});
    if (memSamples.length > 256) memSamples.shift();
}

try {
    enabled = localStorage.getItem('queryProfiler') === '1';
} catch {
    enabled = false;
}

export function queryProfilerEnabled(): boolean {
    return enabled;
}

/**
 * Time a synchronous query call, tagging the sample with the cycle it ran at.
 * When disabled this is a single boolean check plus the bare call — negligible.
 */
export function measure<T>(label: string, cycle: number, fn: () => T): T {
    if (!enabled) return fn();

    const t0 = performance.now();
    const result = fn();
    const dt = performance.now() - t0;

    let ls = stats.get(label);
    if (!ls) {
        ls = {buckets: new Map(), totalCount: 0};
        stats.set(label, ls);
    }
    ls.totalCount++;

    const key = Math.floor(Math.max(0, cycle) / CYCLE_BUCKET);
    let b = ls.buckets.get(key);
    if (!b) {
        b = {sum: 0, count: 0, max: 0};
        ls.buckets.set(key, b);
    }
    b.sum += dt;
    b.count++;
    if (dt > b.max) b.max = dt;

    const now = t0;
    if (now - lastReport > REPORT_INTERVAL_MS) {
        lastReport = now;
        sampleMemory(cycle);
        report();
    }

    return result;
}

/**
 * Print a per-label table of avg ms by cycle bucket. Read it top-to-bottom:
 * if avg climbs as the cycle band increases, query cost is O(cycle).
 */
export function report(): void {
    if (stats.size === 0) {
        console.log('[queryProfiler] no samples yet');
        return;
    }
    for (const [label, ls] of stats) {
        const keys = [...ls.buckets.keys()].sort((a, b) => a - b);
        if (keys.length === 0) continue;

        const first = ls.buckets.get(keys[0])!;
        const last = ls.buckets.get(keys[keys.length - 1])!;
        const firstAvg = first.sum / first.count;
        const lastAvg = last.sum / last.count;
        const growth = firstAvg > 0 ? (lastAvg / firstAvg) : 0;

        const rows = keys.map(k => {
            const b = ls.buckets.get(k)!;
            return {
                cycles: `${k * CYCLE_BUCKET}–${(k + 1) * CYCLE_BUCKET - 1}`,
                avgMs: +(b.sum / b.count).toFixed(3),
                maxMs: +b.max.toFixed(3),
                n: b.count,
            };
        });

        console.groupCollapsed(
            `[queryProfiler] ${label}: ${ls.totalCount} calls · ` +
            `first-band ${firstAvg.toFixed(3)}ms → last-band ${lastAvg.toFixed(3)}ms ` +
            `(${growth.toFixed(1)}× ${growth >= 2 ? '⚠ scales with cycle' : ''})`,
        );
        console.table(rows);
        console.groupEnd();
    }

    if (memSamples.length > 1) {
        const first = memSamples[0];
        const last = memSamples[memSamples.length - 1];
        const grew = last.wasmMB - first.wasmMB;
        console.log(
            `[queryProfiler] memory: wasm ${first.wasmMB}→${last.wasmMB}MB ` +
            `(${grew >= 0 ? '+' : ''}${grew.toFixed(1)}MB over cycles ${first.cycle}→${last.cycle})` +
            (last.jsMB ? ` · jsHeap ${first.jsMB}→${last.jsMB}MB` : ' · jsHeap n/a (WebKit)') +
            (grew > 4 ? '  ⚠ WASM memory growing — likely leak' : ''),
        );
    }
}

export function reset(): void {
    stats.clear();
    memSamples = [];
    lastReport = 0;
}

// Console handles so you can dump/reset without a rebuild.
declare global {
    interface Window {
        __queryProfilerReport?: () => void;
        __queryProfilerReset?: () => void;
    }
}
if (typeof window !== 'undefined') {
    window.__queryProfilerReport = report;
    window.__queryProfilerReset = reset;
}
