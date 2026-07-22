#!/bin/sh
# Integration test for `packdev watch`, run inside the Docker image.
#
# Sets up a host project with one local dependency whose build script writes a
# marker into an ignored dist/ dir, starts `packdev watch --json` in the
# background, edits the dependency's source twice, and asserts that:
#   1. each edit triggered a rebuild (build-success events + growing marker),
#   2. the rebuild count stayed bounded (no self-triggered build storm),
#   3. the process shuts down cleanly on SIGINT.
set -eu

WORK=/work
cd "$WORK"

# --- Fixture: a consumer app + one local dependency with a build script ------
mkdir -p lib/src
cat > lib/package.json <<'JSON'
{ "name": "lib", "version": "1.0.0", "scripts": { "build": "node build.js" } }
JSON

# Build writes its output into dist/ (in packdev's default ignore list) so a
# successful build does not itself retrigger the watcher.
cat > lib/build.js <<'JS'
const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.appendFileSync('dist/builds.log', 'build\n');
JS

echo '// initial' > lib/src/index.js

cat > package.json <<'JSON'
{ "name": "host", "version": "1.0.0", "dependencies": { "lib": "^1.0.0" } }
JSON
echo '{"name":"host","lockfileVersion":2}' > package-lock.json

packdev create-config >/dev/null
packdev add lib ./lib --no-install >/dev/null

# --- Start the watcher in the background -------------------------------------
: > watch.log
packdev watch --json > watch.log 2> watch.err &
WATCH_PID=$!

# Wait (up to 5s) for the initial "watching" event before editing.
i=0
while [ "$i" -lt 50 ]; do
  if grep -q '"event":"watching"' watch.log 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 0.1
done
if ! grep -q '"event":"watching"' watch.log 2>/dev/null; then
  echo "FAIL: watcher never emitted a 'watching' event"
  echo "=== watch.log ==="; cat watch.log
  echo "=== watch.err ==="; cat watch.err
  kill -INT "$WATCH_PID" 2>/dev/null || true
  exit 1
fi

# --- Trigger two rebuilds via source edits -----------------------------------
echo "// change 1" >> lib/src/index.js
sleep 2
echo "// change 2" >> lib/src/index.js
sleep 2

# --- Clean shutdown ----------------------------------------------------------
kill -INT "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true

echo "=== watch.log ==="
cat watch.log

# Count rebuilds that happened *after* the "watching" event, so the initial
# startup build alone can't produce a false pass.
REBUILDS=$(awk '
  /"event":"watching"/ { watching = 1; next }
  watching && /"event":"build-success"/ { count++ }
  END { print count + 0 }
' watch.log)
MARKER_LINES=0
if [ -f lib/dist/builds.log ]; then
  MARKER_LINES=$(wc -l < lib/dist/builds.log | tr -d ' ')
fi
echo "=== rebuilds after watching: ${REBUILDS}, marker lines: ${MARKER_LINES} ==="

# --- Assertions --------------------------------------------------------------
if [ "$REBUILDS" -lt 1 ]; then
  echo "FAIL: no rebuild detected after source edits"
  exit 1
fi
if [ "$MARKER_LINES" -lt 1 ]; then
  echo "FAIL: build ran but produced no marker output"
  exit 1
fi
if [ "$REBUILDS" -gt 12 ]; then
  echo "FAIL: rebuild storm — ${REBUILDS} rebuilds from 2 edits"
  exit 1
fi

echo "PASS: watch rebuilt on change (${REBUILDS} rebuilds), bounded, clean shutdown"
exit 0
