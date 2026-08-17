#!/usr/bin/env node
// The published @strudel/core index pulls @kabelsalat/web (browser REPL).
// For Node hap-query we rewrite that one export away after npm install.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@strudel", "core");
const index = join(root, "index.mjs");
if (!existsSync(index)) process.exit(0);
let src = readFileSync(index, "utf-8");
if (src.includes("export * from './repl.mjs'")) {
  src = src.replace("export * from './repl.mjs';", "// patched out: export * from './repl.mjs';");
  writeFileSync(index, src);
  console.error("hap-ingest: patched @strudel/core to skip repl.mjs");
}
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
if (pkg.main !== "index.mjs") {
  pkg.main = "index.mjs";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
for (const name of ["mini", "tonal", "transpiler"]) {
  const p = join(root, "..", name, "package.json");
  if (!existsSync(p)) continue;
  const j = JSON.parse(readFileSync(p, "utf-8"));
  if (j.main !== "index.mjs" && existsSync(join(root, "..", name, "index.mjs"))) {
    j.main = "index.mjs";
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  }
}
