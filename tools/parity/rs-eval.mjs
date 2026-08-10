#!/usr/bin/env node
/**
 * Evaluate strudel code using strudel-rs (via strudel-mini CLI).
 * Normalizes output to the same JSON format as js-eval.mjs.
 *
 * Usage: node rs-eval.mjs "s('bd sd')" [--cycles 1]
 *        node rs-eval.mjs --file pattern.strudel [--cycles 1]
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const DSL_EVAL = process.env.DSL_EVAL
  || new URL('../../target/debug/dsl-eval', import.meta.url).pathname;

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
  console.error('Usage: node rs-eval.mjs "pattern code" [--cycles N]');
  process.exit(1);
}

let rawJson;
try {
  rawJson = execFileSync(DSL_EVAL, [
    code, '--cycles', String(cycles)
  ], { encoding: 'utf-8', timeout: 10000 });
} catch (e) {
  const stderr = e.stderr?.toString() || e.message;
  console.error(`ERROR: dsl-eval failed: ${stderr}`);
  process.exit(2);
}

try {
  const haps = JSON.parse(rawJson);

  // dsl-eval already outputs [whole, part, value] in normalized format
  const normalized = haps
    .filter(h => h.whole)
    .map(h => ({
      whole: h.whole.map(round6),
      part: h.part.map(round6),
      value: h.value,
    }))
    .sort((a, b) => a.part[0] - b.part[0] || a.whole[0] - b.whole[0]);

  console.log(JSON.stringify(normalized, null, 2));
} catch (e) {
  console.error(`ERROR: failed to parse dsl-eval output: ${e.message}`);
  process.exit(2);
}

function round6(n) {
  return Math.round(n * 1000000) / 1000000;
}
