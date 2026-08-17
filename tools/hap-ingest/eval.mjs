#!/usr/bin/env node
/**
 * JS-strudel → hap IR.
 *
 * Evaluates web-strudel source (transpiler + @strudel/core) and prints
 * discrete haps as JSON. Stubs REPL-only hooks (samples, sliders, viz)
 * so bakery files can still produce events.
 *
 *   node eval.mjs --file pattern.strudel [--cycles 8]
 */
import { readFileSync } from "fs";

const args = process.argv.slice(2);
let code = "";
let cycles = 8;
let file = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cycles" && args[i + 1]) {
    cycles = parseInt(args[++i], 10);
  } else if (args[i] === "--file" && args[i + 1]) {
    file = args[++i];
    code = readFileSync(file, "utf-8");
  } else if (!args[i].startsWith("--")) {
    code = args[i];
  }
}

if (!code) {
  console.error("usage: node eval.mjs --file pattern.strudel [--cycles N]");
  process.exit(1);
}

globalThis.samples = async () => {};
globalThis.setDefaultVoicings = () => {};
globalThis.setcps = () => {};
globalThis.setCps = () => {};
globalThis.setcpm = () => {};
globalThis.setbpm = () => {};
globalThis.slider = (v) => (typeof v === "number" ? v : 0.5);
globalThis.sliderWithID = (_id, v) => (typeof v === "number" ? v : 0.5);
globalThis.register = (_name, fn) => fn;
globalThis.all = (fn) => fn;

const _log = console.log;
const _warn = console.warn;
console.log = () => {};
console.warn = () => {};
// Dynamic import so the core load banner cannot leak onto stdout.
const { evalScope, evaluate } = await import("@strudel/core/evaluate.mjs");
const { Pattern } = await import("@strudel/core/pattern.mjs");
const { transpiler } = await import("@strudel/transpiler/transpiler.mjs");
const passthrough = function () {
  return this;
};
for (const m of [
  "pianoroll",
  "spiral",
  "punchcard",
  "scope",
  "color",
  "ftype",
  "postgain",
  "fanchor",
  "panchor",
  "fit",
  "ribbon",
  "press",
  "p",
]) {
  if (typeof Pattern.prototype[m] !== "function") {
    Pattern.prototype[m] = passthrough;
  }
}
await evalScope(
  import("@strudel/core/controls.mjs"),
  import("@strudel/core/signal.mjs"),
  import("@strudel/core/pattern.mjs"),
  import("@strudel/core/euclid.mjs"),
  import("@strudel/core/pick.mjs"),
  import("@strudel/mini/mini.mjs"),
  import("@strudel/tonal/tonal.mjs"),
  import("@strudel/tonal/voicings.mjs"),
);
if (typeof globalThis.perlin === "undefined") {
  globalThis.perlin = globalThis.sine;
}
console.log = _log;
console.warn = _warn;

try {
  const { pattern } = await evaluate(code, transpiler);
  if (!pattern || typeof pattern.queryArc !== "function") {
    throw new Error("evaluate did not return a Pattern");
  }
  const haps = pattern.queryArc(0, cycles);
  const normalized = haps
    .filter((h) => h.whole)
    .map((h) => ({
      whole: [num(h.whole.begin), num(h.whole.end)],
      part: [num(h.part.begin), num(h.part.end)],
      value: flattenValue(h.value),
    }))
    .sort((a, b) => a.part[0] - b.part[0] || a.whole[0] - b.whole[0]);

  process.stdout.write(
    JSON.stringify({
      file,
      cycles,
      hap_count: normalized.length,
      haps: normalized,
    }),
  );
} catch (e) {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(2);
}

function num(f) {
  return Math.round(Number(f) * 1_000_000) / 1_000_000;
}

function flattenValue(v) {
  if (v === null || v === undefined) return {};
  if (typeof v === "string") return { s: v };
  if (typeof v === "number") return { n: v };
  if (typeof v !== "object") return { v: String(v) };
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue;
    if (typeof val === "number") out[k] = Math.round(val * 1e6) / 1e6;
    else if (typeof val === "string") out[k] = val;
  }
  return out;
}
