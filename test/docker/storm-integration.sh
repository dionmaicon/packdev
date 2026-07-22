#!/bin/sh
# Stress test for `packdev watch`'s rebuild-storm guard, run inside the Docker
# image. Worst case: the dependency's build writes its output INTO the watched
# root (not an ignored dist/), so a naive watcher would retrigger itself on
# every build and loop forever. packdev's post-build cooldown must keep the
# rebuild count bounded.
#
# Two checks:
#   1. Idle soak with no edits: the build's own root-write must not self-trigger
#      an ever-growing rebuild loop.
#   2. Under a few real edits: rebuilds stay roughly 1:1 with edits, not
#      amplified into a storm.
set -eu

WORK=/work
mkdir -p "$WORK/proj/lib/src"
cd "$WORK/proj"

# Build appends into the WATCHED ROOT (lib/gen.txt), not an ignored dir.
cat > lib/build.js <<'JS'
const fs = require('fs');
fs.appendFileSync('gen.txt', 'b');
JS
cat > lib/package.json <<'JSON'
{ "name": "lib", "version": "1.0.0", "scripts": { "build": "node build.js" } }
JSON
echo '1' > lib/src/x.js

cat > package.json <<'JSON'
{ "name": "h", "version": "1.0.0", "dependencies": { "lib": "^1.0.0" } }
JSON
echo '{"name":"h","lockfileVersion":2}' > package-lock.json

packdev create-config >/dev/null
packdev add lib ./lib --no-install >/dev/null

count_builds() { grep -c '"event":"build-success"' "$1" 2>/dev/null || echo 0; }

# --- Check 1: idle soak, no edits --------------------------------------------
echo "=== idle soak (no edits) ==="
: > idle.log
packdev watch --json > idle.log 2>/dev/null &
WP=$!
sleep 6
kill -INT "$WP" 2>/dev/null || true
wait "$WP" 2>/dev/null || true
IDLE=$(count_builds idle.log)
echo "builds during 6s idle soak: ${IDLE}"
# Startup builds once; the build's root-write must not perpetuate. Allow a tiny
# margin for a single stray retrigger, but anything large means a storm.
if [ "$IDLE" -gt 3 ]; then
  echo "FAIL: rebuild storm while idle (${IDLE} builds, build output self-triggered)"
  exit 1
fi

# --- Check 2: bounded under real edits ---------------------------------------
echo "=== 3 edits, spaced past the cooldown ==="
: > edit.log
packdev watch --json > edit.log 2>/dev/null &
WP=$!
sleep 1.5
i=1
while [ "$i" -le 3 ]; do
  echo "// edit $i" >> lib/src/x.js
  sleep 1.2
  i=$((i + 1))
done
sleep 3
kill -INT "$WP" 2>/dev/null || true
wait "$WP" 2>/dev/null || true

REBUILDS=$(awk '
  /"event":"watching"/ { w = 1; next }
  w && /"event":"build-success"/ { c++ }
  END { print c + 0 }
' edit.log)
echo "rebuilds after watching (3 edits): ${REBUILDS}"
if [ "$REBUILDS" -lt 1 ]; then
  echo "FAIL: edits did not trigger any rebuild"
  exit 1
fi
# 3 edits should yield a handful of rebuilds, never a storm. If the guard were
# broken, the build's root-write would amplify each edit into many.
if [ "$REBUILDS" -gt 8 ]; then
  echo "FAIL: rebuild storm under edits (${REBUILDS} rebuilds from 3 edits)"
  exit 1
fi

echo "PASS: rebuild-storm guard bounded builds despite build output in the watched root"
exit 0
