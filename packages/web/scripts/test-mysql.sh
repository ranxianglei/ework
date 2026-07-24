#!/usr/bin/env bash
# Run the full test suite against a throwaway MySQL 8.0 container.
# Self-contained: starts MySQL, waits for readiness, runs `bun test`, tears
# down. Requires Docker. Extra args forward to `bun test`, e.g.
#   bun run test:mysql tests/store.test.ts
# to scope a single file. Override the host port with WORK_DB_TEST_PORT
# (default 3310) if it collides with a local MySQL. The container name is
# PID-suffixed so parallel runs don't clash.
#
# No Docker? Start MySQL yourself and run bun test directly with the WORK_DB_*
# env vars (see WORK_DB_DRIVER / WORK_DB_HOST / WORK_DB_PORT / WORK_DB_USER /
# WORK_DB_PASSWORD / WORK_DB_NAME in src/db.ts).
set -euo pipefail

PORT="${WORK_DB_TEST_PORT:-3310}"
CONTAINER="ework-mysql-test-$$"
DB="ework_test"
ROOT_PW="testpw"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — start MySQL manually and run:" >&2
  echo "  WORK_DB_DRIVER=mysql WORK_DB_HOST=... WORK_DB_PORT=... bun test" >&2
  exit 1
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "starting MySQL 8.0 (container $CONTAINER, host port $PORT)..."
docker run -d --rm --name "$CONTAINER" -p "$PORT:3306" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" -e MYSQL_DATABASE="$DB" \
  mysql:8.0 >/dev/null

echo "waiting for MySQL readiness (up to 60s)..."
# Gate on TCP + a real query, not just mysqladmin ping: the mysql:8.0 entrypoint
# runs a socket-only temp server during init, then restarts the real one. A
# socket-based ping succeeds during the temp phase and races the restart —
# TCP+query only succeeds once the real server is up.
ready=0
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" mysql -h 127.0.0.1 -p"$ROOT_PW" -e "SELECT 1" --silent 2>/dev/null; then
    ready=1; echo "  ready after ${i}s"; break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "MySQL did not become ready in 60s" >&2; exit 1; }

echo "running bun test against MySQL (args: $*)..."
WORK_DB_DRIVER=mysql \
WORK_DB_HOST=127.0.0.1 \
WORK_DB_PORT="$PORT" \
WORK_DB_USER=root \
WORK_DB_PASSWORD="$ROOT_PW" \
WORK_DB_NAME="$DB" \
bun test "$@"

echo "done; tearing down MySQL container."
