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

echo "🐳 Running watch integration test..."
docker run --rm "$IMAGE"
