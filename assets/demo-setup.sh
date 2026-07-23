#!/usr/bin/env bash
# Prepare a throwaway demo project for assets/demo.tape and print its path.
# Keeps all quoting/JSON out of the .tape file (VHS's Type parser is fragile
# with escaped quotes). Usage: demo-setup.sh <repo-root>
set -e

REPO="$1"
d=$(mktemp -d)

# A `packdev` wrapper on PATH that runs the local dist build.
mkdir -p "$d/bin"
cat > "$d/bin/packdev" <<EOF
#!/bin/sh
exec node "$REPO/dist/index.js" "\$@"
EOF
chmod +x "$d/bin/packdev"

cd "$d"
cat > package.json <<'JSON'
{ "name": "app", "version": "1.0.0", "dependencies": { "my-lib": "^1.0.0" } }
JSON
cp package.json package.json.orig       # for the hidden reset between add and init
echo '{}' > package-lock.json

mkdir my-lib
printf '{ "name": "my-lib", "version": "1.0.0" }\n' > my-lib/package.json

echo "$d"
