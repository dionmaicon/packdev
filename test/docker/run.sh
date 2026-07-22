#!/usr/bin/env bash
# Build the integration image, run the `packdev watch` test inside a throwaway
# container, and clean the image up afterward. Exit code propagates from the
# in-container test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="packdev-watch-test:local"

cleanup() {
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🐳 Building integration image..."
docker build -f "$ROOT/test/docker/Dockerfile" -t "$IMAGE" "$ROOT"

echo "🐳 [1/5] watch integration test (live rebuild -> consumer)..."
docker run --rm --entrypoint /usr/local/bin/watch-integration.sh "$IMAGE"

echo "🐳 [2/5] git-URL dependency integration test (install from git remote)..."
docker run --rm --entrypoint /usr/local/bin/git-integration.sh "$IMAGE"

echo "🐳 [3/5] multi-package-manager integration test (pnpm walk-up + yarn)..."
docker run --rm --entrypoint /usr/local/bin/pm-integration.sh "$IMAGE"

echo "🐳 [4/5] init/finish round-trip integration test (consumer resolves both)..."
docker run --rm --entrypoint /usr/local/bin/finish-integration.sh "$IMAGE"

echo "🐳 [5/5] watch rebuild-storm guard stress test..."
docker run --rm --entrypoint /usr/local/bin/storm-integration.sh "$IMAGE"
