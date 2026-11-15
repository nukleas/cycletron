#!/usr/bin/env bash
# Fail when added comment lines excuse a shortcut instead of fixing it.
# Usage: scripts/check-comments.sh [base-ref]   (default origin/master)
set -euo pipefail
base="${1:-origin/master}"
words='for now|temporar(y|ily)|workaround|hack(y)?|good enough|quick fix|stopgap|kludge|TODO|FIXME|XXX'
comment='(//|/\*|^\+\s*\*|^\+\s*#)'
hits=$(git diff -U0 "$base"...HEAD -- '*.rs' '*.ts' '*.mjs' '*.sh' '*.yml' '*.toml' \
    ':!ui/pkg' ':!scripts/check-comments.sh' \
  | grep -E '^\+[^+]' | grep -E "$comment" | grep -iE "\b($words)\b" || true)
if [ -n "$hits" ]; then
  echo "Added comments that defer or excuse work:"
  echo "$hits"
  echo
  echo "Fix the underlying problem, or record it as a tracked issue and say what the code does."
  exit 1
fi
echo "comment check OK"
