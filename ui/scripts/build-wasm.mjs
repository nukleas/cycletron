#!/usr/bin/env node
// Rebuild the engine WASM under ui/pkg from a strudel-rs checkout.
//
// The committed ui/pkg must be built from the exact rev the workspace
// Cargo.toml pins, or the live engine and the Rust-side export/analysis
// silently diverge. So this refuses to build from any checkout that is not
// at that rev with a clean crates/ tree. The checkout defaults to the
// sibling ../clean-strudel-rs; point STRUDEL_RS at another one.
//
//   npm run build:wasm            build into ui/pkg
//   npm run build:wasm -- --check verify the checkout only
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(ui, '..');
const checkOnly = process.argv.includes('--check');

const cargo = readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
const pinned = cargo.match(/^strudel-core\s*=\s*\{[^}]*\brev\s*=\s*"([0-9a-f]{40})"/m);
if (!pinned) fail('could not find the strudel-core rev pin in Cargo.toml');
const pin = pinned[1];

const checkout = path.resolve(process.env.STRUDEL_RS ?? path.join(root, '..', 'clean-strudel-rs'));
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {encoding: 'utf8'}).trim();

let head;
try {
    head = git('rev-parse', 'HEAD');
} catch {
    fail(`no git checkout at ${checkout} (set STRUDEL_RS=/path/to/strudel-rs)`);
}
if (head !== pin) {
    fail(`${checkout} is at ${head.slice(0, 7)} but Cargo.toml pins ${pin.slice(0, 7)}\n` +
        `  git -C ${checkout} checkout ${pin}`);
}
const dirty = git('status', '--porcelain', '--', 'crates');
if (dirty) fail(`${checkout} has uncommitted changes under crates/:\n${dirty}`);

console.log(`strudel-rs ${pin.slice(0, 7)} at ${checkout}`);
if (checkOnly) process.exit(0);

execFileSync(
    'wasm-pack',
    ['build', '.', '--target', 'web', '--out-dir', path.join(ui, 'pkg'), '--', '-Z', 'build-std=std,panic_abort'],
    {cwd: path.join(checkout, 'crates', 'strudel-audio-wasm'), stdio: 'inherit'},
);
console.log('ui/pkg rebuilt — commit it together with the Cargo.toml pin bump.');

function fail(msg) {
    console.error(`build:wasm: ${msg}`);
    process.exit(1);
}
