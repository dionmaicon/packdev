#!/bin/sh
# End-to-end integration test for git-URL dependencies, run inside the Docker
# image. Proves packdev's headline differentiator — git dependencies, which
# npm link / yalc cannot do — resolves real code in the consuming project,
# fully offline via a local bare git repo as the "remote".
#
# Scope note: this asserts the init-from-git path (add -> init -> consumer
# resolves the git code). It does NOT assert a finish swap-back for git deps:
# npm pins a git dependency to a resolved commit in package-lock.json, so
# rewriting the ref and re-running `npm install` keeps the pinned commit unless
# the lockfile/node_modules are cleared. That is npm behavior, not packdev's;
# local (file:) deps do not have this limitation.
set -eu

WORK=/work
cd "$WORK"

git config --global user.email packdev-test@example.com
git config --global user.name packdev-test

# --- Build a bare git "remote" for the dependency ----------------------------
mkdir gitlib
cd gitlib
git init -q -b main
echo '{ "name": "gitlib", "version": "1.0.0", "main": "index.js" }' > package.json
echo 'module.exports = "FROM_GIT";' > index.js
git add -A
git commit -qm "initial release"
cd "$WORK"

git clone -q --bare gitlib remote.git

GIT_URL="git+file:///work/remote.git"

# --- Consumer app ------------------------------------------------------------
mkdir app
cd app
cat > package.json <<'JSON'
{ "name": "app", "version": "1.0.0", "dependencies": { "gitlib": "^1.0.0" } }
JSON
echo '{"name":"app","lockfileVersion":2}' > package-lock.json

packdev create-config >/dev/null

if ! packdev add gitlib "$GIT_URL" --original-version ^1.0.0 --no-install --json >/tmp/add.log 2>&1; then
  echo "FAIL: packdev add did not accept the git+file URL"
  cat /tmp/add.log
  exit 1
fi

# The dependency must be classified as a git dependency, not a local path.
if ! packdev list --json 2>/dev/null | grep -q '"type":"git"'; then
  echo "FAIL: git+file dependency was not classified as a git dependency"
  packdev list --json
  exit 1
fi

# --- init: install from the git remote ---------------------------------------
echo "=== init (clone + install from git) ==="
packdev init >/tmp/init.log 2>&1 || { echo "FAIL: init errored"; tail -5 /tmp/init.log; exit 1; }

if [ ! -e node_modules/gitlib ]; then
  echo "FAIL: git dependency was not installed into node_modules"
  exit 1
fi

VAL=$(node -e 'process.stdout.write(String(require("gitlib")))' 2>/dev/null || true)
echo "consumer resolves: ${VAL}"
if [ "$VAL" != "FROM_GIT" ]; then
  echo "FAIL: consumer did not resolve the git dependency's code (got '${VAL}')"
  exit 1
fi

# The consumer's package.json should now carry the git URL.
if ! grep -q 'git+file:///work/remote.git' package.json; then
  echo "FAIL: package.json was not switched to the git URL"
  cat package.json
  exit 1
fi

echo "PASS: git-URL dependency installed from a git remote and resolved by the consumer"
exit 0
