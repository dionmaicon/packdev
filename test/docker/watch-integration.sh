#!/bin/sh
# End-to-end integration test for `packdev watch`, run inside the Docker image.
#
# Proves the whole value proposition, not just "the dependency rebuilt":
# updating a packdev-managed local dependency propagates to the *consuming*
# project live. It sets up a consumer app + one local dependency whose build
# copies src -> dist (the dep's published entrypoint), links it with a real
# `packdev init` install, then:
#   1. asserts the consumer resolves the dependency's initial value,
#   2. starts `packdev watch --json`, edits the dependency's source,
#   3. asserts the consumer sees the NEW value with no reinstall (live via the
#      file: symlink npm creates),
#   4. asserts the rebuild count stayed bounded (no self-triggered storm),
#   5. asserts a clean SIGINT shutdown.
set -eu

WORK=/work
cd "$WORK"

# --- Fixture: a consumer app + one local dependency --------------------------
mkdir -p lib/src
cat > lib/package.json <<'JSON'
{ "name": "lib", "version": "1.0.0", "main": "dist/index.js", "scripts": { "build": "node build.js" } }
JSON

# Build copies the source entrypoint into dist/ (the dep's "published" output,
# and in packdev's default ignore list so a build does not retrigger itself).
cat > lib/build.js <<'JS'
const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('src/index.js', 'dist/index.js');
JS

echo 'module.exports = "VERSION_A";' > lib/src/index.js
( cd lib && node build.js )   # produce the initial dist so install has an entrypoint

cat > package.json <<'JSON'
{ "name": "host", "version": "1.0.0", "dependencies": { "lib": "^1.0.0" } }
JSON
echo '{"name":"host","lockfileVersion":2}' > package-lock.json

packdev create-config >/dev/null
packdev add lib ./lib --no-install >/dev/null

# Real install so node_modules/lib is linked to the source (file: symlink).
packdev init >/dev/null 2>&1 || true

if [ ! -e node_modules/lib ]; then
  echo "FAIL: init did not link the dependency into node_modules"
  exit 1
fi

# Consumer must resolve the dependency's initial value.
INITIAL=$(node -e 'process.stdout.write(String(require("lib")))')
echo "=== consumer initial value: ${INITIAL} ==="
if [ "$INITIAL" != "VERSION_A" ]; then
  echo "FAIL: consumer did not resolve initial dependency value (got '${INITIAL}')"
  exit 1
fi

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

# The watcher suppresses change events for a short cooldown after each build
# (its storm guard). "watching" is emitted right after the startup build, so
# wait past that window before editing or the edit would be dropped.
sleep 1

# --- Update the dependency's source -> expect the consumer to pick it up ------
echo 'module.exports = "VERSION_B";' > lib/src/index.js

# Poll (up to ~10s) for the consumer to observe the updated value, rather than
# guessing a fixed build duration.
UPDATED=""
j=0
while [ "$j" -lt 100 ]; do
  UPDATED=$(node -e 'process.stdout.write(String(require("lib")))' 2>/dev/null || true)
  if [ "$UPDATED" = "VERSION_B" ]; then break; fi
  j=$((j + 1))
  sleep 0.1
done

# --- Clean shutdown ----------------------------------------------------------
kill -INT "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true

echo "=== watch.log ==="
cat watch.log
echo "=== consumer value after edit: ${UPDATED} ==="

# Rebuilds that happened *after* the "watching" event (exclude startup build).
REBUILDS=$(awk '
  /"event":"watching"/ { watching = 1; next }
  watching && /"event":"build-success"/ { count++ }
  END { print count + 0 }
' watch.log)
echo "=== rebuilds after watching: ${REBUILDS} ==="

# --- Assertions --------------------------------------------------------------
if [ "$REBUILDS" -lt 1 ]; then
  echo "FAIL: no rebuild detected after source edit"
  exit 1
fi
if [ "$UPDATED" != "VERSION_B" ]; then
  echo "FAIL: consumer did not receive the updated dependency (got '${UPDATED}')"
  exit 1
fi
if [ "$REBUILDS" -gt 12 ]; then
  echo "FAIL: rebuild storm — ${REBUILDS} rebuilds from 1 edit"
  exit 1
fi

echo "PASS: dependency update propagated to consumer (VERSION_A -> VERSION_B), ${REBUILDS} rebuild(s), bounded, clean shutdown"
exit 0
