#!/usr/bin/env bash
# Unified local CI check runner for Cycletron (Rust + UI + corpus + site).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Rust: fmt"
cargo fmt --all --check

echo "==> Rust: clippy"
cargo clippy --workspace --all-targets -- -D warnings

echo "==> Rust: test"
cargo test --workspace

echo "==> Rust: corpus-check"
cargo run -p corpus-check

echo "==> UI: typecheck + lint + unit tests"
(cd ui && npm run typecheck && npm run lint && npm test)

echo "==> UI: generated files check"
(cd ui && npm run gen:dsl && npm run gen:manifest)
git diff --exit-code -- ui/src/generated ui/public/cycletron.strudel.json

echo "==> UI: production builds (desktop + web)"
(cd ui && npm run build && npm run build:web)

echo "==> Site: syntax check"
for f in site/build.mjs site/lib/*.mjs; do
  node --check "$f"
done

echo "All Cycletron checks passed."
