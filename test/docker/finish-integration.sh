#!/bin/sh
# End-to-end integration test for the init/finish round-trip at the code level,
# run inside the Docker image. The existing unit tests assert finish restores
# the version *string*; this proves the consuming project actually resolves the
# original code again after finish.
#
# The "published" baseline is a local file: dependency (installed as a symlink,
# so it works offline without a registry). packdev tracks a separate dev copy:
#   init   -> consumer resolves DEV
#   finish -> consumer resolves PUBLISHED (the restored original)
set -eu

WORK=/work
mkdir -p "$WORK/app/published-lib" "$WORK/app/dev-lib"
cd "$WORK/app"

cat > published-lib/package.json <<'JSON'
{ "name": "lib", "version": "1.0.0", "main": "index.js" }
JSON
echo 'module.exports = "PUBLISHED";' > published-lib/index.js

cat > dev-lib/package.json <<'JSON'
{ "name": "lib", "version": "1.0.0", "main": "index.js" }
JSON
echo 'module.exports = "DEV";' > dev-lib/index.js

cat > package.json <<'JSON'
{ "name": "app", "version": "1.0.0", "dependencies": { "lib": "file:./published-lib" } }
JSON
echo '{"name":"app","lockfileVersion":2}' > package-lock.json

packdev create-config >/dev/null
packdev add lib ./dev-lib --original-version "file:./published-lib" --no-install >/dev/null

# --- init: consumer should resolve the dev code ------------------------------
echo "=== init ==="
packdev init >/tmp/init.log 2>&1 || { echo "FAIL: init errored"; tail -5 /tmp/init.log; exit 1; }
DEV_VAL=$(node -e 'process.stdout.write(String(require("lib")))' 2>/dev/null || true)
echo "consumer after init: ${DEV_VAL}"
if [ "$DEV_VAL" != "DEV" ]; then
  echo "FAIL: consumer did not resolve the dev dependency (got '${DEV_VAL}')"
  exit 1
fi

# --- finish: consumer should resolve the original (published) code -----------
echo "=== finish ==="
packdev finish >/tmp/finish.log 2>&1 || { echo "FAIL: finish errored"; tail -5 /tmp/finish.log; exit 1; }
PUB_VAL=$(node -e 'process.stdout.write(String(require("lib")))' 2>/dev/null || true)
echo "consumer after finish: ${PUB_VAL}"
if [ "$PUB_VAL" != "PUBLISHED" ]; then
  echo "FAIL: consumer did not resolve the restored original dependency (got '${PUB_VAL}')"
  exit 1
fi

echo "PASS: init/finish round-trip resolved by consumer (PUBLISHED -> DEV -> PUBLISHED)"
exit 0
