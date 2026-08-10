#!/usr/bin/env bash
# Pull the MusicRepo Supabase strudel corpus to a local JSONL cache, then
# (optionally) run the corpus-check batch validator over it.
#
#   tools/corpus-fetch/fetch-corpus.sh            # fetch → .corpus-cache/corpus.jsonl
#   tools/corpus-fetch/fetch-corpus.sh --validate # fetch, then corpus-check it
#
# Requires DATABASE_URL in .env (see .env.example). Uses psql -tA so each row
# prints as one raw JSON object (no COPY escaping); Postgres already escapes
# newlines inside the JSON string, so one row == one JSONL line.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL not set. Copy .env.example → .env and fill it in." >&2
  exit 1
fi

out_dir="$repo_root/.corpus-cache"
mkdir -p "$out_dir"
out="$out_dir/corpus.jsonl"

# One JSON object per representation: id + strudel metadata + frontmatter-stripped
# code. effects/sounds/tempo come from the precomputed features jsonb, so passing
# rows can be tagged without re-parsing.
read -r -d '' SQL <<'EOSQL' || true
select json_build_object(
  'id',       r.id,
  'work_id',  r.work_id,
  'title',    w.title,
  'source',   w.source,
  'tags',     w.tags,
  'origin',   w.origin,
  'authored_by', w.authored_by,
  'derivative_of', w.derivative_of,
  'tempo',    r.features->'tempo_from_code',
  'effects',  r.features->'effects',
  'sounds',   r.features->'sounds',
  'uses_tracks', r.features->'uses_tracks',
  'code',     btrim(regexp_replace(r.content, '^\s*---[\s\S]*?\n---[ \t]*\r?\n', ''))
)
from representations r
join works w on w.id = r.work_id
where r.kind = 'strudel'
EOSQL

echo "fetching corpus → $out"
psql "$DATABASE_URL" -tA -c "$SQL" > "$out"
n="$(wc -l < "$out" | tr -d ' ')"
echo "wrote $n rows"

if [[ "${1:-}" == "--validate" ]]; then
  echo "building corpus-check…"
  cargo build -q -p corpus-check
  echo "validating…"
  "$repo_root/target/debug/corpus-check" "$out"
fi
