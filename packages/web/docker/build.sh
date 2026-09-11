#!/usr/bin/env bash
# Build the ework all-in-one Docker image.
#
# Usage: ./docker/build.sh [image-tag]
# Default tag: ework-aio:latest
#
# Stages the opencode binary into docker/build-context/opencode/ then invokes
# docker build with context = parent dir (so ework/ and ework-daemon/ are both
# COPY-able per Dockerfile contract).
set -euo pipefail

TAG="${1:-ework-aio:latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT_DIR="$(cd "$REPO_DIR/.." && pwd)"   # parent of repo

echo "=== ework aio build ==="
echo "  repo dir:   $REPO_DIR"
echo "  context:    $CONTEXT_DIR"
echo "  image tag:  $TAG"

# Locate the opencode binary on the host (glibc linux-x64 build).
OPENCODE_BIN="${OPENCODE_BIN:-}"
if [[ -z "$OPENCODE_BIN" ]]; then
  for cand in \
    "$HOME/.local/bin/opencode" \
    /usr/local/bin/opencode \
    "$(command -v opencode 2>/dev/null || true)"; do
    if [[ -n "$cand" && -x "$cand" ]]; then OPENCODE_BIN="$cand"; break; fi
  done
fi
[[ -n "$OPENCODE_BIN" && -x "$OPENCODE_BIN" ]] || {
  echo "ERROR: opencode binary not found. Set OPENCODE_BIN=/path/to/opencode." >&2
  exit 1
}
echo "  opencode:   $OPENCODE_BIN ($(opencode --version 2>&1 | head -1))"

# Locate bun on the host. Tries PATH first, then common install locations.
BUN_BIN="${BUN_BIN:-}"
if [[ -z "$BUN_BIN" ]]; then
  for cand in \
    "$(command -v bun 2>/dev/null || true)" \
    "$HOME/.bun/bin/bun" \
    /usr/local/bin/bun; do
    if [[ -n "$cand" && -x "$cand" ]]; then BUN_BIN="$cand"; break; fi
  done
fi
[[ -n "$BUN_BIN" && -x "$BUN_BIN" ]] || {
  echo "ERROR: bun binary not found. Set BUN_BIN=/path/to/bun." >&2
  exit 1
}
echo "  bun:        $BUN_BIN ($("$BUN_BIN" --version 2>&1 | head -1))"

STAGED="$REPO_DIR/docker/build-context/opencode-linux-x64/bin"
mkdir -p "$STAGED"
cp "$OPENCODE_BIN" "$STAGED/opencode"
chmod +x "$STAGED/opencode"

STAGED_BUN="$REPO_DIR/docker/build-context/bun/bin"
mkdir -p "$STAGED_BUN"
cp "$BUN_BIN" "$STAGED_BUN/bun"
chmod +x "$STAGED_BUN/bun"

# Invoke docker build.
docker build \
  -f "$REPO_DIR/docker/Dockerfile" \
  -t "$TAG" \
  --build-arg OPENCODE_BIN=ework/docker/build-context/opencode-linux-x64/bin/opencode \
  --build-arg BUN_BIN=ework/docker/build-context/bun/bin/bun \
  "$CONTEXT_DIR"

echo
echo "=== Build complete: $TAG ==="
echo "Run with: docker run --rm -p 3002:3002 -p 3101:3101 -v aio-data:/data --env-file docker/.env.docker $TAG"
