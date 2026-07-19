#!/usr/bin/env bash
# Install ework-daemon CLI globally
# Usage: ./install.sh [daemon-url]
# Example: ./install.sh http://localhost:3101

set -euo pipefail

EDAEMON_URL="${1:-http://localhost:3101}"

echo "=== Building ework-daemon CLI ==="

if ! command -v bun &>/dev/null; then
    echo "ERROR: bun is required. Install from https://bun.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

bun build src/cli.ts --compile --outfile ework-daemon

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"
cp ework-daemon "$INSTALL_DIR/ework-daemon"
chmod +x "$INSTALL_DIR/ework-daemon"

echo ""
echo "=== Setting default EDAEMON_URL ==="
echo "export EDAEMON_URL=$EDAEMON_URL" >> ~/.bashrc 2>/dev/null || true
export EDAEMON_URL="$EDAEMON_URL"

echo ""
echo "=== Installed ==="
"$INSTALL_DIR/ework-daemon" status
