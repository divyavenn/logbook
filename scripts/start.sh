#!/bin/sh
# Boot sequence for a deployed logbook: bring the schema up to date, give any
# entry still kept as markdown its document, then serve.
#
# The backfill needs the editor's own schema to read markdown, which is
# JavaScript, so it cannot run inside the Python process. It runs here instead,
# where the disk is mounted: a build cannot reach it. Everything below is
# idempotent, and nothing here can keep the logbook from starting -- an entry
# without a document is still read, just the long way round.
set -e

python="python3"
if [ -x .venv/bin/python ]; then python=".venv/bin/python"; fi

"$python" -c "from backend.db import initialize; initialize()"

backfill="dist/backfill.mjs"
if [ -f "$backfill" ] && command -v node > /dev/null 2>&1; then
  node "$backfill" --write --quiet || echo "still: document backfill skipped; entries will be read as markdown."
fi

exec "$python" -m uvicorn backend.app:app --host 0.0.0.0 --port "${PORT:-8000}"
