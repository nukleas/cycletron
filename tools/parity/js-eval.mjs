#!/usr/bin/env node
/**
 * Evaluate strudel code using the JS reference implementation.
 * Outputs Haps as normalized JSON for comparison with strudel-rs.
 *
 * Usage: node js-eval.mjs "note('c4 e4 g4').s('sine')" [--cycles 1]
 *        node js-eval.mjs --file pattern.strudel [--cycles 1]
 */
import { evalScope, evaluate } from '@strudel/core';
import { transpiler } from '@strudel/transpiler';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
let code = '';
let cycles = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cycles' && args[i + 1]) {
    cycles = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--file' && args[i + 1]) {
    code = readFileSync(args[i + 1], 'utf-8');
    i++;
  } else if (!args[i].startsWith('--')) {
    code = args[i];
  }
}

if (!code) {
  console.error('Usage: node js-eval.mjs "pattern code" [--cycles N]');
  process.exit(1);
}

// Load strudel scope (suppress loading banners)
const _log = console.log;
const _warn = console.warn;
console.log = () => {};
console.warn = () => {};
await evalScope(
  import('@strudel/core'),
  import('@strudel/mini'),
  import('@strudel/tonal'),
);
console.log = _log;
console.warn = _warn;

try {
  const { pattern } = await evaluate(code, transpiler);
  const haps = pattern.queryArc(0, cycles);

  // Normalize to a simple comparable format
  const normalized = haps
    .filter(h => h.whole) // skip continuous signals
    .map(h => ({
      whole: [frac(h.whole.begin), frac(h.whole.end)],
      part: [frac(h.part.begin), frac(h.part.end)],
      value: flattenValue(h.value),
    }))
    .sort((a, b) => a.part[0] - b.part[0] || a.whole[0] - b.whole[0]);

  console.log(JSON.stringify(normalized, null, 2));
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(2);
}

function frac(f) {
  // Fraction.js — get as float, round to 6 decimal places
  return Math.round(Number(f) * 1000000) / 1000000;
}

function flattenValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { s: v };
  if (typeof v === 'number') return { n: v };
  if (typeof v !== 'object') return { v: String(v) };

  // Strudel values are objects with control keys like { s: 'bd', gain: 0.5, note: 60 }
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null) continue;
    if (typeof val === 'number') {
      out[k] = Math.round(val * 1000000) / 1000000;
    } else if (typeof val === 'string') {
      out[k] = val;
    } else {
      out[k] = String(val);
    }
  }
  return out;
}
