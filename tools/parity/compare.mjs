#!/usr/bin/env node
/**
 * Strudel Parity Checker
 *
 * Evaluates a set of patterns with both JS strudel and strudel-rs,
 * then compares the Haps (events) to find differences.
 *
 * Usage: node compare.mjs                  # run all test cases
 *        node compare.mjs "s('bd sd')"     # run single pattern
 *        node compare.mjs --mini-only      # only test mini notation (skip DSL)
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_CASES = [
  // === Mini notation basics ===
  { name: 'Single atom',        code: 'bd' },
  { name: 'Two atoms',          code: 'bd sd' },
  { name: 'Four atoms',         code: 'bd sd hh cp' },
  { name: 'Fast (*)',           code: 'bd*4' },
  { name: 'Slow (/)',           code: 'bd/2' },
  { name: 'Group []',           code: '[bd sd] hh' },
  { name: 'Nested group',       code: '[bd [sd sd]] hh cp' },
  { name: 'Alternation <>',     code: '<bd sd hh>' },
  { name: 'Stack (,)',          code: 'bd, hh' },
  { name: 'Stack 3 voices',     code: 'bd*4, ~ sd ~ sd, hh*8' },
  { name: 'Rest (~)',           code: 'bd ~ sd ~' },
  { name: 'Euclidean',          code: 'bd(3,8)' },
  { name: 'Euclidean rotated',  code: 'bd(5,8,2)' },
  { name: 'Replicate (!)',      code: 'bd!3 sd' },
  { name: 'Degrade (?)',        code: 'bd sd?0.5 hh' },
  { name: 'Weight (@)',         code: 'bd@3 sd' },
  { name: 'Range (..)',         code: '0..7' },
  { name: 'Elongation (@)',     code: 'bd sd@2 hh' },
  { name: 'Complex stack',      code: 'bd*4, [~ cp]*2, hh(3,8), ~ sd ~ sd' },
  { name: 'Deep nesting',       code: '[bd [sd [hh cp]]] [~ bd]' },
  { name: 'Alt + fast',         code: '<bd sd>*2' },
  { name: 'Numbers',            code: '0 1 2 3' },
  { name: 'Notes',              code: 'c4 e4 g4' },
  { name: 'Mixed fast/group',   code: '[bd sd]*2 [hh hh hh]*3' },

  // === DSL (method chains) — skipped by --mini-only ===
  { name: 'note().s()',          code: 'note("c4 e4 g4").s("sine")',                    dsl: true },
  { name: 's() basic',          code: 's("bd sd")',                                      dsl: true },
  { name: 's() with fast',      code: 's("bd sd").fast(2)',                              dsl: true },
  { name: 's() with gain',      code: 's("bd*4").gain(0.5)',                             dsl: true },
  { name: 'stack()',             code: 'stack(s("bd*4"), s("hh*8"))',                     dsl: true },
  { name: 'note + scale',       code: 'note("0 1 2 3 4 5 6 7").scale("C4:major")',       dsl: true },
  { name: 'note + cutoff',      code: 'note("c3 e3 g3").s("sawtooth").cutoff(800)',      dsl: true },
  { name: 'rev()',               code: 'note("c4 d4 e4 f4").s("sine").rev()',             dsl: true },
  { name: 'slow()',              code: 's("bd sd hh cp").slow(2)',                        dsl: true },
  { name: 'every()',             code: 's("bd sd hh cp").every(3, x => x.fast(2))',       dsl: true },
  { name: 'jux()',               code: 'note("c4 e4 g4 b4").s("sine").jux(x => x.rev())', dsl: true },
  { name: 'echo()',              code: 's("bd cp").echo(3, 0.125, 0.5)',                  dsl: true },
  { name: 'superimpose()',       code: 'note("c4 e4 g4").s("sine").superimpose(x => x.transpose(12))', dsl: true },
  { name: 'palindrome()',        code: 'note("c4 d4 e4 f4").s("sine").palindrome()',      dsl: true },
  { name: 'chop()',              code: 's("bd").chop(4)',                                 dsl: true },
  { name: 'euclid method',      code: 's("bd").euclid(3, 8)',                            dsl: true },
  { name: 'off()',               code: 'note("c4 e4 g4 b4").s("sine").off(0.125, x => x.transpose(7))', dsl: true },
];

const miniOnly = args().includes('--mini-only');
const singlePattern = args().find(a => !a.startsWith('--'));

async function main() {
  let cases = TEST_CASES;
  if (singlePattern) {
    cases = [{ name: 'custom', code: singlePattern }];
  }
  if (miniOnly) {
    cases = cases.filter(c => !c.dsl);
  }

  let pass = 0, fail = 0, error = 0;
  const failures = [];

  for (const tc of cases) {
    const prefix = tc.dsl ? '  [DSL]' : ' [MINI]';
    let jsResult, rsResult;

    try {
      jsResult = evalJS(tc.code);
    } catch (e) {
      console.log(`${prefix} ⚠ ${tc.name}: JS error — ${shortErr(e)}`);
      error++;
      continue;
    }

    try {
      rsResult = evalRS(tc.code, tc.dsl);
    } catch (e) {
      console.log(`${prefix} ⚠ ${tc.name}: RS error — ${shortErr(e)}`);
      error++;
      continue;
    }

    const diff = compareHaps(jsResult, rsResult);
    if (diff === null) {
      console.log(`${prefix} ✓ ${tc.name} (${jsResult.length} haps)`);
      pass++;
    } else {
      console.log(`${prefix} ✗ ${tc.name}: ${diff}`);
      failures.push({ name: tc.name, code: tc.code, diff, js: jsResult, rs: rsResult });
      fail++;
    }
  }

  console.log(`\n═══ ${pass} passed, ${fail} failed, ${error} errors (${cases.length} total) ═══`);

  if (failures.length > 0 && !singlePattern) {
    console.log('\nFailed patterns:');
    for (const f of failures.slice(0, 5)) {
      console.log(`\n─── ${f.name}: ${f.code} ───`);
      console.log(`  JS haps: ${f.js.length}, RS haps: ${f.rs.length}`);
      if (f.js.length <= 4 && f.rs.length <= 4) {
        console.log('  JS:', JSON.stringify(f.js));
        console.log('  RS:', JSON.stringify(f.rs));
      }
      console.log(`  Diff: ${f.diff}`);
    }
  }
}

function evalJS(code) {
  // Wrap bare mini notation in s("...") for the transpiler.
  // DSL code (with quotes or method chains) passes through as-is.
  const isDSL = code.includes('"') || code.includes("'") || /\.\w+\(/.test(code);
  const escaped = code.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const evalCode = isDSL ? code : `s("${escaped}")`;
  const out = execFileSync('node', [join(__dirname, 'js-eval.mjs'), evalCode], {
    encoding: 'utf-8', timeout: 15000, cwd: __dirname,
    env: { ...process.env, NODE_PATH: join(__dirname, '../../../strudel/node_modules') },
    stdio: ['pipe', 'pipe', 'pipe'], // capture stderr separately
  });
  // Strip any non-JSON lines (strudel prints loading banners to stdout)
  const jsonStart = out.indexOf('[');
  if (jsonStart < 0) throw new Error('no JSON in output: ' + out.slice(0, 100));
  return JSON.parse(out.slice(jsonStart));
}

function evalRS(code, _isDSL) {
  // strudel-mini handles mini notation; for DSL it will fail (caught by caller)
  const out = execFileSync('node', [join(__dirname, 'rs-eval.mjs'), code], {
    encoding: 'utf-8', timeout: 15000, cwd: __dirname,
  });
  return JSON.parse(out);
}

function compareHaps(jsHaps, rsHaps) {
  if (jsHaps.length !== rsHaps.length) {
    return `hap count: JS=${jsHaps.length} RS=${rsHaps.length}`;
  }

  for (let i = 0; i < jsHaps.length; i++) {
    const js = jsHaps[i];
    const rs = rsHaps[i];

    // Compare timing (the most important parity check)
    if (!timesEqual(js.whole, rs.whole)) {
      return `hap ${i} whole: JS=[${js.whole}] RS=[${rs.whole}]`;
    }
    if (!timesEqual(js.part, rs.part)) {
      return `hap ${i} part: JS=[${js.part}] RS=[${rs.part}]`;
    }

    // Compare values (looser — just check the main value key matches)
    const jsVal = js.value?.s || js.value?.n;
    const rsVal = rs.value?.s || rs.value?.n;
    if (jsVal !== undefined && rsVal !== undefined && jsVal !== rsVal) {
      return `hap ${i} value: JS=${JSON.stringify(jsVal)} RS=${JSON.stringify(rsVal)}`;
    }
  }

  return null; // match!
}

function timesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 0.0001 && Math.abs(a[1] - b[1]) < 0.0001;
}

function shortErr(e) {
  const msg = e.stderr || e.message || String(e);
  return msg.split('\n')[0].slice(0, 100);
}

function args() { return process.argv.slice(2); }

main().catch(e => {
  console.error(e);
  process.exit(1);
});
