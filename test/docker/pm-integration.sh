#!/bin/sh
# End-to-end integration test for multi-package-manager support, run inside the
# Docker image. Proves packdev drives the project's actual package manager (not
# just npm) and that lockfile detection walks UP to a monorepo root:
#
#   pnpm: lockfile at the repo root, `init` run from a child directory ->
#         packdev detects pnpm by walking up, runs `pnpm install`, and the
#         consumer resolves the local dependency.
#   yarn: yarn.lock present -> packdev runs `yarn install` (not npm), and the
#         consumer resolves the local dependency.
#
# The manager that actually ran is verified by its distinctive artifact
# (pnpm's node_modules/.pnpm; the absence of an npm package-lock.json).
set -eu

WORK=/work

# --- pnpm: lockfile at root, init from a child directory ---------------------
echo "=== pnpm: detect from a child dir (walk-up) + install ==="
mkdir -p "$WORK/pnpm-mono/sub/lib"
cd "$WORK/pnpm-mono"
echo 'lockfileVersion: 9.0' > pnpm-lock.yaml   # only at the monorepo root

cat > sub/lib/package.json <<'JSON'
{ "name": "plib", "version": "1.0.0", "main": "index.js" }
JSON
echo 'module.exports = "PNPM_LOCAL";' > sub/lib/index.js

cd sub
cat > package.json <<'JSON'
{ "name": "papp", "version": "1.0.0", "dependencies": { "plib": "^1.0.0" } }
JSON

packdev create-config >/dev/null
packdev add plib ./lib --no-install >/dev/null
packdev init >/tmp/pnpm-init.log 2>&1 || { echo "FAIL: pnpm init errored"; tail -8 /tmp/pnpm-init.log; exit 1; }

if [ ! -d node_modules/.pnpm ]; then
  echo "FAIL: pnpm was not used (no node_modules/.pnpm) — walk-up detection failed"
  grep -iE "Running (npm|pnpm|yarn)" /tmp/pnpm-init.log || true
  exit 1
fi
if [ -f package-lock.json ]; then
  echo "FAIL: npm ran instead of pnpm (package-lock.json created)"
  exit 1
fi
PNPM_VAL=$(node -e 'process.stdout.write(String(require("plib")))' 2>/dev/null || true)
echo "consumer resolves: ${PNPM_VAL}"
if [ "$PNPM_VAL" != "PNPM_LOCAL" ]; then
  echo "FAIL: consumer did not resolve the pnpm-installed dependency (got '${PNPM_VAL}')"
  exit 1
fi
echo "PASS: pnpm detected via walk-up from a child dir, installed, consumer resolved"

# --- yarn: yarn.lock present -------------------------------------------------
echo "=== yarn: detect yarn.lock + install ==="
mkdir -p "$WORK/yarn-app/lib"
cd "$WORK/yarn-app"
touch yarn.lock

cat > lib/package.json <<'JSON'
{ "name": "ylib", "version": "1.0.0", "main": "index.js" }
JSON
echo 'module.exports = "YARN_LOCAL";' > lib/index.js

cat > package.json <<'JSON'
{ "name": "yapp", "version": "1.0.0", "dependencies": { "ylib": "^1.0.0" } }
JSON

packdev create-config >/dev/null
packdev add ylib ./lib --no-install >/dev/null
packdev init >/tmp/yarn-init.log 2>&1 || { echo "FAIL: yarn init errored"; tail -8 /tmp/yarn-init.log; exit 1; }

if [ -f package-lock.json ]; then
  echo "FAIL: npm ran instead of yarn (package-lock.json created)"
  exit 1
fi
if ! grep -qiE "Running yarn install" /tmp/yarn-init.log; then
  echo "FAIL: packdev did not run yarn install"
  grep -iE "Running (npm|pnpm|yarn)" /tmp/yarn-init.log || true
  exit 1
fi
YARN_VAL=$(node -e 'process.stdout.write(String(require("ylib")))' 2>/dev/null || true)
echo "consumer resolves: ${YARN_VAL}"
if [ "$YARN_VAL" != "YARN_LOCAL" ]; then
  echo "FAIL: consumer did not resolve the yarn-installed dependency (got '${YARN_VAL}')"
  exit 1
fi
echo "PASS: yarn detected, installed, consumer resolved"

echo "PASS: multi-package-manager integration (pnpm walk-up + yarn) verified"
exit 0
