#!/usr/bin/env bash
# ework-daemon deploy — sync code from the dev repo into the runtime dir.
#
# Dev/prod separation: development happens in the git repo (here), but the
# systemd service runs from a separate runtime directory. This script copies
# the type-checked code into the runtime dir. It does NOT restart the service
# by default — restart kills running OpenCode processes (red line, see
# AGENTS.md §6), so it is a separate deliberate step.
#
# Usage:
#   ./scripts/deploy.sh              # sync code, no restart
#   ./scripts/deploy.sh --restart    # sync code, then restart IF no processes running
#   AWORK_RUNTIME_DIR=/path ./scripts/deploy.sh
#
# Synced (code only):  src/  package.json  tsconfig.json  bun.lock
# Never synced (runtime-only):  .env  *.db  node_modules/  data/  test/

set -euo pipefail

DEV_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${EDAEMON_RUNTIME_DIR:-$HOME/.local/share/ework-daemon}"
PORT="${EDAEMON_PORT:-3101}"

RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

G="\033[32m"; R="\033[31m"; Y="\033[33m"; B="\033[1m"; X="\033[0m"
ok()   { printf "${G}✓${X} %s\n" "$1"; }
fail() { printf "${R}✗${X} %s\n" "$1" >&2; }
info() { printf "${Y}!${X} %s\n" "$1"; }
head() { printf "\n${B}%s${X}\n" "$1"; }

head "ework-daemon deploy"
echo "  dev:     $DEV_DIR"
echo "  runtime: $RUNTIME_DIR"

# 1. type check — never ship broken types
head "1/3  type check"
if ! (cd "$DEV_DIR" && bun run check); then
  fail "type check failed — aborting deploy"
  exit 1
fi
ok "type check passed"

# 2. sync code
head "2/3  sync code"
if [ ! -d "$RUNTIME_DIR" ]; then
  fail "runtime dir does not exist: $RUNTIME_DIR"
  fail "run 'bun run setup' first to initialize it"
  exit 1
fi

LOCK_CHANGED=0
if ! cmp -s "$DEV_DIR/bun.lock" "$RUNTIME_DIR/bun.lock" 2>/dev/null; then
  LOCK_CHANGED=1
fi

rsync -a --delete --exclude='node_modules' "$DEV_DIR/src/" "$RUNTIME_DIR/src/"
cp "$DEV_DIR/package.json" "$RUNTIME_DIR/package.json"
cp "$DEV_DIR/tsconfig.json" "$RUNTIME_DIR/tsconfig.json"
cp "$DEV_DIR/bun.lock" "$RUNTIME_DIR/bun.lock"
ok "code synced (src/, package.json, tsconfig.json, bun.lock)"

# 3. deps — only if lockfile changed
head "3/3  deps"
if [ "$LOCK_CHANGED" = "1" ]; then
  info "bun.lock changed — bun install in runtime dir"
  (cd "$RUNTIME_DIR" && bun install)
else
  ok "bun.lock unchanged — skipping install"
fi

# optional restart — refuses if processes are running (red line)
if [ "$RESTART" = "1" ]; then
  head "restart"
  PROCS="$(curl -fsS "http://localhost:${PORT}/api/processes" 2>/dev/null || echo "[]")"
  COUNT="$(printf '%s' "$PROCS" | grep -c '"pid"' || true)"
  if [ "$COUNT" -gt 0 ]; then
    fail "$COUNT process(es) running — restart would kill them (red line)"
    printf '%s\n' "$PROCS" | python3 -c "import sys,json; [print('   ',p['key'],'pid='+str(p['pid'])) for p in json.load(sys.stdin)]" 2>/dev/null || printf '%s\n' "$PROCS"
    exit 1
  fi
  sudo systemctl restart ework-daemon.service
  sleep 2
  systemctl is-active ework-daemon.service && ok "restarted"
else
  echo ""
  info "code deployed. To activate, restart when idle:"
  echo "    ./scripts/deploy.sh --restart"
  echo "    # or manually:  curl -s http://localhost:${PORT}/api/processes && sudo systemctl restart ework-daemon.service"
fi
