#!/usr/bin/env bash
# End-to-end install + lifecycle + subcommand test.
#
# Spawns a clean debian container (via Dockerfile.regression) and exercises:
#   1. Install paths: --allow-root + re-install idempotency
#   2. Service startup: web /login + daemon /api/status
#   3. Subcommand smoke: status, env, config list/get/set, logs
#   4. Service lifecycle: stop / start / restart (PIDs change)
#   5. Issue flow: create project → create issue → daemon receives webhook
#   6. Cleanup: uninstall removes pidfiles + kills services
#
# Each block also documents which past bug the assertion prevents:
#   v0.2.4 plugin key    → issue-create → daemon receives webhook
#   v0.2.5 daemon binary → /api/status probe (was printing help + exiting 0)
#   v0.2.6 secret drift  → "no invalid signature in daemon.log"
#   v0.2.6 access log    → "no EACCES in web.log"
#   v0.2.7+ regression   → all subcommands exit 0 with expected markers
#
# Usage: ./scripts/e2e-install.sh [container-runtime] [npm-tag]
#   container-runtime: docker (default) | podman
#   npm-tag:           latest (default) | 0.2.7 | file:.. (for local builds)

set -euo pipefail

RUNTIME="${1:-docker}"
NPM_TAG="${2:-latest}"
IMAGE="${IMAGE:-ework-aio:e2e}"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*"; exit 1; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }

if ! "$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Building $IMAGE"
  # Build context = repo root (this script's parent dir + ..). Lets us invoke
  # the script from anywhere (npm run test:e2e, CI, etc.) without cwd issues.
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  "$RUNTIME" build --network=host -f "$REPO_ROOT/Dockerfile.regression" \
    -t "$IMAGE" "$REPO_ROOT"
fi

info "Using image: $IMAGE  (testing npm tag: $NPM_TAG)"

# Unique ports so we don't collide with a host-side ework stack when run with
# --network host. OVERRIDE via env only if you know what you're doing — by
# default we IGNORE any inherited WORK_PORT/DAEMON_PORT from the host shell
# (a host running ework-daemon on :3100 would otherwise leak into the test
# and break assertions about which port the container's daemon binds to).
WORK_PORT="14002"
DAEMON_PORT="14101"

# opencode binary is host-specific (path may differ across machines). Mount
# readonly so the container preflight sees it on PATH. Override via env.
OPENCODE_HOST_BIN="${OPENCODE_HOST_BIN:-/home/dog/.local/bin/opencode}"

# Optional MySQL backend: E2E_DB=mysql starts a throwaway MySQL 8.0 sidecar
# reachable via the host network and passes WORK_DB_* through to ework-web.
# Default sqlite (no sidecar). Needs a published ework-web with MySQL support.
E2E_DB="${E2E_DB:-sqlite}"
MYSQL_FLAGS=()
MYSQL_CONTAINER=""
cleanup_mysql() { [[ -n "$MYSQL_CONTAINER" ]] && docker rm -f "$MYSQL_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup_mysql EXIT
if [[ "$E2E_DB" == "mysql" ]]; then
  MYSQL_PORT="${E2E_MYSQL_PORT:-3312}"
  MYSQL_CONTAINER="ework-e2e-mysql-$$"
  info "E2E_DB=mysql: starting MySQL 8.0 sidecar (container $MYSQL_CONTAINER, host port $MYSQL_PORT)"
  docker run -d --rm --name "$MYSQL_CONTAINER" -p "$MYSQL_PORT:3306" \
    -e MYSQL_ROOT_PASSWORD=testpw -e MYSQL_DATABASE=ework_e2e mysql:8.0 >/dev/null
  info "waiting for MySQL readiness (TCP+query gate, up to 60s)"
  ready=0
  for _ in $(seq 1 60); do
    if docker exec "$MYSQL_CONTAINER" mysql -h 127.0.0.1 -ptestpw -e "SELECT 1" --silent 2>/dev/null; then
      ready=1; break
    fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]] || fail "MySQL sidecar did not become ready in 60s"
  MYSQL_FLAGS=(
    -e WORK_DB_DRIVER=mysql
    -e WORK_DB_HOST=127.0.0.1
    -e WORK_DB_PORT="$MYSQL_PORT"
    -e WORK_DB_USER=root
    -e WORK_DB_PASSWORD=testpw
    -e WORK_DB_NAME=ework_e2e
  )
fi

"$RUNTIME" run --rm -i --network host \
  -v "$OPENCODE_HOST_BIN:/usr/local/bin/opencode:ro" \
  -e WORK_PORT="$WORK_PORT" \
  -e DAEMON_PORT="$DAEMON_PORT" \
  -e NPM_TAG="$NPM_TAG" \
  -e HTTP_PROXY="${HTTP_PROXY:-}" \
  -e HTTPS_PROXY="${HTTPS_PROXY:-}" \
  -e http_proxy="${HTTP_PROXY:-}" \
  -e https_proxy="${HTTPS_PROXY:-}" \
  -e NO_PROXY="127.0.0.1,localhost" \
  "${MYSQL_FLAGS[@]}" \
  "$IMAGE" bash -euo pipefail <<'EOSCRIPT'
set -euo pipefail

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*"; exit 1; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }

WORK_PORT="${WORK_PORT:-14002}"
DAEMON_PORT="${DAEMON_PORT:-14101}"
NPM_TAG="${NPM_TAG:-latest}"
DATA_DIR=/tmp/aio-e2e

# Defend against host env leak: the OUTER script always passes -e WORK_PORT
# and -e DAEMON_PORT, but if the user invokes this heredoc directly from a
# shell that has DAEMON_PORT set (e.g. their production daemon on :3100),
# the assertions below will fail mysteriously. The values above are the
# authoritative defaults; only override via the outer script's env passthrough.

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

# Poll a URL until it returns < 500, or fail after N half-seconds.
wait_for_url() {
  local url="$1" name="$2" half_seconds="${3:-60}"
  for i in $(seq 1 "$half_seconds"); do
    if curl -sf -o /dev/null "$url"; then
      pass "$name responds (after ${i} half-seconds)"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Read .env key value (last match wins — install.ts overwrites keys in place).
env_val() { grep "^$1=" "$2" | tail -1 | cut -d= -f2-; }

# Build admin auth cookie from web .env.
build_auth_cookie() {
  local web_env="$DATA_DIR/ework-web/.env"
  local token secret sig
  token=$(env_val WORK_TOKEN "$web_env")
  secret=$(env_val WORK_COOKIE_SECRET "$web_env")
  sig=$(printf '%s' "$token" \
    | openssl dgst -sha256 -hmac "$secret" -binary \
    | base64 | tr '+/' '-_' | tr -d '=')
  echo "ework_auth=${token}.${sig}"
}

# Read PID from pidfile (or echo empty if missing/empty).
pid_of() {
  local pf="$DATA_DIR/run/$1.pid"
  [[ -f "$pf" ]] || { echo ""; return; }
  echo "$(cat "$pf")"
}

# Is a PID alive?
pid_alive() { kill -0 "$1" >/dev/null 2>&1; }

# Wait for a service's pidfile PID to differ from the given "old" PID.
wait_for_new_pid() {
  local svc="$1" old_pid="$2" half_seconds="${3:-40}"
  for i in $(seq 1 "$half_seconds"); do
    local new_pid
    new_pid=$(pid_of "$svc")
    if [[ -n "$new_pid" && "$new_pid" != "$old_pid" ]] && pid_alive "$new_pid"; then
      pass "$svc pid changed ($old_pid → $new_pid) after ${i} half-seconds"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Wait for a service's pidfile to vanish (or PID to die).
wait_for_no_pid() {
  local svc="$1" half_seconds="${2:-30}"
  for i in $(seq 1 "$half_seconds"); do
    local pid
    pid=$(pid_of "$svc")
    if [[ -z "$pid" ]] || ! pid_alive "$pid"; then
      pass "$svc stopped (no live pid) after ${i} half-seconds"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "====================================================="
echo "Phase 0: clean state + npm install"
echo "====================================================="
info "clean state"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

info "opencode binary on PATH"
opencode --version | head -1
pass "opencode present"

info "npm install -g ework-web@latest ework-daemon@latest opencode-ework@latest ework-aio@${NPM_TAG}"
# Note: ework-web and ework-daemon aren't version-locked to ework-aio. We
# always install latest of the services and only parameterize ework-aio so
# we can E2E-test a PR branch against published services.
for pkg in ework-web ework-daemon opencode-ework; do
  npm install -g "$pkg@latest" 2>&1 | tail -2
done
npm install -g "ework-aio@${NPM_TAG}" 2>&1 | tail -2

# -----------------------------------------------------------------------------
# Phase 1: install paths
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 1: install paths"
echo "====================================================="

info "v0.2.5 regression: all 4 bins on PATH"
for b in ework-aio ework-web ework-daemon ework-daemon-server; do
  command -v "$b" >/dev/null 2>&1 || fail "$b not on PATH"
  pass "$b -> $(command -v "$b")"
done

info "install path A: --allow-root + custom ports + --yes"
# --allow-root: container runs as root; refusing would test an unrealistic
# path. The installer's data still lands in /tmp/aio-e2e via --data-dir.
ework-aio install \
  --allow-root \
  --data-dir "$DATA_DIR" \
  --port "$WORK_PORT" \
  --daemon-port "$DAEMON_PORT" \
  --bot-name e2e-bot \
  --yes 2>&1 | tee /tmp/install.log

pass "install (path A) exited 0"

info "install path B: re-install over existing data dir (idempotency)"
# Re-running install should not crash on existing .env / pidfiles / webhooks.
# This catches bugs where install.ts isn't idempotent (e.g. UNIQUE constraint
# on second bot token, or "file exists" on second .env write).
ework-aio install \
  --allow-root \
  --data-dir "$DATA_DIR" \
  --port "$WORK_PORT" \
  --daemon-port "$DAEMON_PORT" \
  --bot-name e2e-bot \
  --yes 2>&1 | tee /tmp/install2.log | tail -10

pass "install (path B: idempotent re-install) exited 0"

# -----------------------------------------------------------------------------
# Phase 2: post-install assertions (regression suite for v0.2.5 / v0.2.6)
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 2: post-install env / regression assertions"
echo "====================================================="

info "v0.2.6 regression: webhook secrets match across web and daemon .env"
WEB_SEC=$(env_val WORK_DAEMON_WEBHOOK_SECRET "$DATA_DIR/ework-web/.env")
DAE_SEC=$(env_val GITEA_WEBHOOK_SECRET "$DATA_DIR/ework-daemon/.env")
[[ -n "$WEB_SEC" ]] || fail "WORK_DAEMON_WEBHOOK_SECRET empty in web .env"
[[ -n "$DAE_SEC" ]] || fail "GITEA_WEBHOOK_SECRET empty in daemon .env"
[[ "$WEB_SEC" == "$DAE_SEC" ]] \
  || fail "webhook secrets differ (web=$WEB_SEC daemon=$DAE_SEC)"
pass "secrets match (${#WEB_SEC} chars)"

info "v0.2.6 regression: WORK_ACCESS_LOG set, not defaulting to /tmp/ework-access.log"
ACCESS_LOG_VAL=$(env_val WORK_ACCESS_LOG "$DATA_DIR/ework-web/.env")
[[ -n "$ACCESS_LOG_VAL" ]] || fail "WORK_ACCESS_LOG missing from web .env"
[[ "$ACCESS_LOG_VAL" != "/tmp/ework-access.log" ]] \
  || fail "WORK_ACCESS_LOG still defaults to /tmp/ework-access.log"
pass "WORK_ACCESS_LOG=$ACCESS_LOG_VAL"

info "wait for ework-web /login"
wait_for_url "http://127.0.0.1:$WORK_PORT/login" "/login" 60 \
  || { tail -30 "$DATA_DIR/run/web.log" 2>/dev/null; fail "ework-web did not come up"; }

info "wait for daemon /api/status"
wait_for_url "http://127.0.0.1:$DAEMON_PORT/api/status" "/api/status" 60 \
  || { tail -30 "$DATA_DIR/run/daemon.log" 2>/dev/null; fail "daemon did not come up"; }

info "v0.2.6 regression: no EACCES in web.log"
sleep 1
if grep -q "EACCES" "$DATA_DIR/run/web.log" 2>/dev/null; then
  fail "EACCES in web.log:"
  grep EACCES "$DATA_DIR/run/web.log" | head -3
fi
pass "no EACCES in web.log"

info "v0.2.6 regression: no invalid signature in daemon.log (pre-issue-create)"
if grep -q "invalid signature" "$DATA_DIR/run/daemon.log" 2>/dev/null; then
  fail "invalid signature BEFORE issue create — autoWire webhook must have fired"
  grep "invalid signature" "$DATA_DIR/run/daemon.log" | head -3
fi
pass "no invalid signature yet"

# -----------------------------------------------------------------------------
# Phase 3: subcommand smoke tests
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 3: subcommand smoke tests"
echo "====================================================="

info "status: lists both services, both running, both listening"
STATUS_OUT=$(ework-aio status --data-dir "$DATA_DIR" 2>&1)
echo "$STATUS_OUT"
echo "$STATUS_OUT" | grep -q "ework-web"    || fail "status missing ework-web line"
echo "$STATUS_OUT" | grep -q "ework-daemon" || fail "status missing ework-daemon line"
echo "$STATUS_OUT" | grep "ework-web"    | grep -q "✓ running"    || fail "web not reported running"
echo "$STATUS_OUT" | grep "ework-daemon" | grep -q "✓ running"    || {
  echo "$STATUS_OUT" | grep "ework-daemon"
  fail "daemon not reported running (see status output above)"
}
pass "status lists both services as running"

info "env: prints key paths"
ENV_OUT=$(ework-aio env --data-dir "$DATA_DIR" 2>&1)
echo "$ENV_OUT"
echo "$ENV_OUT" | grep -q "data dir"   || fail "env missing 'data dir'"
echo "$ENV_OUT" | grep -q "web env"    || fail "env missing 'web env'"
echo "$ENV_OUT" | grep -q "daemon env" || fail "env missing 'daemon env'"
echo "$ENV_OUT" | grep -q "bot token"  || fail "env missing 'bot token'"
# env.ts globs for bot-token* (install.ts writes bot-token.<botName> when
# --bot-name isn't default). With --bot-name e2e-bot in this run, the env
# output MUST list the suffixed file.
echo "$ENV_OUT" | grep -q "bot-token.e2e-bot" \
  || fail "env missing bot-token.e2e-bot (install wrote it but env didn't list it)"
# Sanity: the printed .env paths must actually exist.
for p in "$DATA_DIR/ework-web/.env" "$DATA_DIR/ework-daemon/.env"; do
  [[ -f "$p" ]] || fail "env printed non-existent path: $p"
done
pass "env prints valid paths (including bot-token suffix)"

info "config list: shows settable keys"
CONFIG_LIST_OUT=$(ework-aio config list --data-dir "$DATA_DIR" 2>&1)
echo "$CONFIG_LIST_OUT"
echo "$CONFIG_LIST_OUT" | grep -q "WORK_PORT"    || fail "config list missing WORK_PORT"
echo "$CONFIG_LIST_OUT" | grep -q "DAEMON_PORT"  || fail "config list missing DAEMON_PORT"
# Secrets must NOT appear (enforced by SECRET_ENV_VARS exclusion).
echo "$CONFIG_LIST_OUT" | grep -q "WORK_TOKEN" \
  && fail "config list leaks WORK_TOKEN (should be excluded)" || true
pass "config list shows settable keys, excludes secrets"

info "config get WORK_PORT: prints the port"
CONFIG_GET_OUT=$(ework-aio config get WORK_PORT --data-dir "$DATA_DIR" 2>&1)
echo "$CONFIG_GET_OUT"
[[ "$CONFIG_GET_OUT" == "$WORK_PORT" ]] \
  || fail "config get WORK_PORT returned '$CONFIG_GET_OUT', expected '$WORK_PORT'"
pass "config get WORK_PORT = $WORK_PORT"

info "config get on a secret key: rejects"
if ework-aio config get WORK_TOKEN --data-dir "$DATA_DIR" 2>/dev/null; then
  fail "config get WORK_TOKEN should have been rejected"
fi
pass "config get on secret rejected"

info "config set WORK_TTS_SPEED 1.5 --no-restart: writes .env, no restart"
ework-aio config set WORK_TTS_SPEED 1.5 --no-restart --data-dir "$DATA_DIR" 2>&1 | tail -5
TTS_VAL=$(env_val WORK_TTS_SPEED "$DATA_DIR/ework-web/.env")
[[ "$TTS_VAL" == "1.5" ]] || fail "WORK_TTS_SPEED not persisted in .env (got '$TTS_VAL')"
pass "config set persisted WORK_TTS_SPEED=1.5"

info "config set with newline value: rejected (env-injection guard)"
# Pre-v0.2.6, a value like "alice\nWORK_TOKEN=evil" would inject a new key
# into .env. cli-dispatch.test.ts:138 covers this in unit tests; we cover
# it here too because the integration surface (bash quoting) differs.
if ework-aio config set WORK_OPERATOR_LOGIN $'alice\nWORK_TOKEN=evil' \
     --no-restart --data-dir "$DATA_DIR" 2>/dev/null; then
  fail "config set accepted a newline value (env-injection regression)"
fi
pass "config set rejects newline value"
# Confirm the injection didn't actually happen.
if grep -q "^WORK_TOKEN=evil" "$DATA_DIR/ework-web/.env"; then
  fail "WORK_TOKEN=evil was injected into .env despite rejection"
fi
pass "no env injection occurred"

info "logs web: starts tailing, exits on SIGTERM"
# logs.ts uses fs.watchFile and never resolves — must be killed.
# Use `timeout` to send SIGTERM after 1s; expect exit 124 (timeout's SIGTERM
# exit) or 143 (SIGTERM). The point: it started without error (no
# "log file not found") and produced output.
set +e
LOGS_OUT=$(timeout -s TERM 1 ework-aio logs web --data-dir "$DATA_DIR" 2>&1)
LOGS_RC=$?
set -e
[[ $LOGS_RC -eq 124 || $LOGS_RC -eq 143 ]] \
  || fail "logs web exited $LOGS_RC (expected 124/143 from SIGTERM)"
# Output should contain SOMETHING (the "tailing" line + recent log content).
[[ -n "$LOGS_OUT" ]] || fail "logs web produced no output"
pass "logs web tail started, exited cleanly on SIGTERM"

# -----------------------------------------------------------------------------
# Phase 4: service lifecycle (stop / start / restart)
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 4: service lifecycle"
echo "====================================================="

WEB_PID_BEFORE=$(pid_of web)
DAEMON_PID_BEFORE=$(pid_of daemon)
[[ -n "$WEB_PID_BEFORE" ]]    || fail "web pid empty before stop"
[[ -n "$DAEMON_PID_BEFORE" ]] || fail "daemon pid empty before stop"
pass "before stop: web pid=$WEB_PID_BEFORE, daemon pid=$DAEMON_PID_BEFORE"

info "stop both services"
ework-aio stop --data-dir "$DATA_DIR" 2>&1 | tail -5
wait_for_no_pid web    || fail "web pid still alive after stop"
wait_for_no_pid daemon || fail "daemon pid still alive after stop"

info "confirm /login stops responding"
sleep 1
if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login" 2>/dev/null; then
  fail "/login still responds after stop — web did not actually stop"
fi
pass "/login stopped responding"

info "start both services"
ework-aio start --data-dir "$DATA_DIR" 2>&1 | tail -5
# Wait for both services to bind their ports again.
wait_for_url "http://127.0.0.1:$WORK_PORT/login" "/login after start" 60 \
  || { tail -30 "$DATA_DIR/run/web.log"; fail "web did not come up after start"; }
wait_for_url "http://127.0.0.1:$DAEMON_PORT/api/status" "/api/status after start" 60 \
  || { tail -30 "$DATA_DIR/run/daemon.log"; fail "daemon did not come up after start"; }

WEB_PID_AFTER_START=$(pid_of web)
DAEMON_PID_AFTER_START=$(pid_of daemon)
[[ "$WEB_PID_AFTER_START" != "$WEB_PID_BEFORE" ]] \
  || fail "web pid unchanged across stop+start ($WEB_PID_BEFORE)"
[[ "$DAEMON_PID_AFTER_START" != "$DAEMON_PID_BEFORE" ]] \
  || fail "daemon pid unchanged across stop+start ($DAEMON_PID_BEFORE)"
pass "PIDs changed after stop+start (web $WEB_PID_BEFORE→$WEB_PID_AFTER_START)"

info "restart both services (config restart both)"
ework-aio config restart both --data-dir "$DATA_DIR" 2>&1 | tail -5
wait_for_new_pid web "$WEB_PID_AFTER_START" 60 \
  || fail "web pid did not change after restart"
wait_for_new_pid daemon "$DAEMON_PID_AFTER_START" 60 \
  || fail "daemon pid did not change after restart"

info "confirm services respond after restart"
wait_for_url "http://127.0.0.1:$WORK_PORT/login" "/login after restart" 60 \
  || fail "web did not come up after restart"
wait_for_url "http://127.0.0.1:$DAEMON_PORT/api/status" "/api/status after restart" 60 \
  || fail "daemon did not come up after restart"

# -----------------------------------------------------------------------------
# Phase 5: issue flow (the actual product path)
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 5: issue flow (create project → create issue → webhook)"
echo "====================================================="

info "build admin auth cookie"
AUTH_COOKIE=$(build_auth_cookie)
[[ -n "$AUTH_COOKIE" ]] || fail "auth cookie empty"
pass "auth cookie built"

info "create test project (triggers autoWire webhook registration)"
PROJ_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$WORK_PORT/projects" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode 'owner=e2e' \
  --data-urlencode 'name=test')
[[ "$PROJ_CODE" == "303" || "$PROJ_CODE" == "302" ]] \
  || fail "project create failed: HTTP $PROJ_CODE"
pass "project create -> $PROJ_CODE"

info "create issue (triggers webhook POST to daemon)"
ISSUE_HEAD=$(curl -sS -i -X POST \
  "http://127.0.0.1:$WORK_PORT/e2e/test/issues" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode 'title=e2e test' \
  --data-urlencode 'body=trigger webhook')
ISSUE_STATUS=$(printf '%s\n' "$ISSUE_HEAD" | head -1 | awk '{print $2}')
[[ "$ISSUE_STATUS" == "303" ]] \
  || fail "issue create did not return 303: $ISSUE_STATUS"
pass "issue create -> 303"

info "wait for webhook delivery + daemon processing"
sleep 5

info "v0.2.6 regression: webhook was accepted (no invalid signature after issue create)"
if grep -q "invalid signature" "$DATA_DIR/run/daemon.log" 2>/dev/null; then
  fail "invalid signature AFTER issue create — webhook secret mismatch"
  grep "invalid signature" "$DATA_DIR/run/daemon.log" | head -5
fi
pass "no invalid signature after issue create"

info "daemon received the issue event"
ACTIVE=$(curl -sS "http://127.0.0.1:$DAEMON_PORT/api/status" | jq -r '.issues // 0')
[[ "$ACTIVE" -ge 1 ]] \
  || fail "daemon did not register the issue (issues=$ACTIVE)"
pass "daemon registered issue (issues=$ACTIVE)"

# -----------------------------------------------------------------------------
# Phase 6: uninstall
# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "Phase 6: uninstall"
echo "====================================================="

info "ework-aio uninstall: stops services + removes pidfiles"
ework-aio uninstall --data-dir "$DATA_DIR" 2>&1 | tail -10

wait_for_no_pid web 15 || fail "web pid still alive after uninstall"
wait_for_no_pid daemon 15 || fail "daemon pid still alive after uninstall"

# pidfiles should be gone OR empty.
for svc in web daemon; do
  pf="$DATA_DIR/run/$svc.pid"
  if [[ -f "$pf" && -s "$pf" ]]; then
    fail "$svc.pid still exists and non-empty after uninstall: $(cat "$pf")"
  fi
done
pass "pidfiles cleared"

info "uninstall preserves data dir"
# uninstall.ts:62 documents "services removed. data preserved at <dir>".
# Verify the .env files survive so a re-install picks up the same token.
[[ -f "$DATA_DIR/ework-web/.env" ]]    || fail "web .env deleted by uninstall"
[[ -f "$DATA_DIR/ework-daemon/.env" ]] || fail "daemon .env deleted by uninstall"
pass "data preserved (both .env files intact)"

# -----------------------------------------------------------------------------
echo
echo "====================================================="
echo "E2E PASSED"
echo "====================================================="
echo "  ework-aio version: $(ework-aio --version 2>/dev/null || echo unknown)"
echo "  data dir:          $DATA_DIR"
echo "  web:               http://127.0.0.1:$WORK_PORT/login"
echo "  daemon:            http://127.0.0.1:$DAEMON_PORT/api/status"
echo "  logs:              $DATA_DIR/run/{web,daemon}.log"
EOSCRIPT

echo
echo "${c_grn}E2E COMPLETE${c_rst}"
