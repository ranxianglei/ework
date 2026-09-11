#!/bin/bash
set -euo pipefail

# Paths are overridable via env. Defaults assume:
#   - Source repo = parent dir of this script
#   - Deploy dir  = /var/lib/ework (matches scripts/ework.service)
#   - bun is on PATH (override with BUN=... if your install differs)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SOURCE:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DEPLOY="${DEPLOY:-/var/lib/ework}"
SERVICE="ework.service"
BUN="${BUN:-$(command -v bun)}"

if [[ -z "$BUN" ]]; then
    echo "ERROR: bun not found on PATH. Set BUN=/path/to/bun or install bun." >&2
    exit 1
fi

echo "🔍 Type checking..."
cd "$SOURCE" && "$BUN" run check 2>&1 | tail -1

echo "📦 Deploying to $DEPLOY..."
mkdir -p "$DEPLOY"
rsync -a --delete \
    --exclude '.git' \
    --exclude 'test/' \
    --exclude 'docs/' \
    --exclude 'node_modules/.cache' \
    "$SOURCE/src/" "$DEPLOY/src/"
cp "$SOURCE/package.json" "$SOURCE/tsconfig.json" "$DEPLOY/"
if [ -f "$SOURCE/.env" ]; then
    cp "$SOURCE/.env" "$DEPLOY/.env"
fi

echo "🔧 Installing dependencies..."
cd "$DEPLOY" && "$BUN" install 2>&1 | tail -1

SERVICE_FILE="/etc/systemd/system/$SERVICE"
UNIT_TEMPLATE="$SOURCE/scripts/ework.service"

if ! systemctl list-unit-files | grep -q "^$SERVICE"; then
    echo "📝 Installing $SERVICE..."
    if [ ! -f "$UNIT_TEMPLATE" ]; then
        echo "ERROR: $UNIT_TEMPLATE missing. Create it first (see scripts/ework.service)."
        exit 1
    fi
    sudo cp "$UNIT_TEMPLATE" "$SERVICE_FILE"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE"
fi

echo "🔄 Restarting $SERVICE..."
sudo systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
    echo "✅ Deploy successful"
else
    echo "❌ ERROR: service not active. Check: sudo journalctl -u $SERVICE -n 30"
    exit 1
fi
