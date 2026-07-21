#!/usr/bin/env bash
# End-to-end install test.
#
# Spawns a clean debian container (via Dockerfile.regression) and runs the
# FULL `ework-aio install` flow — not a hand-rolled .env like the older
# regression.sh. This is the test that would have caught every bug we
# shipped between v0.2.0 and v0.2.6:
#
#   - v0.2.4 plugin key fix    → caught by issue-create → daemon receives webhook
#   - v0.2.5 daemon binary fix → caught by /api/status probe (was printing help)
#   - v0.2.6 webhook secret    → caught by "no invalid signature in daemon.log"
#   - v0.2.6 access log        → caught by "no EACCES in web.log"
#
# Usage: ./scripts/e2e-install.sh [container-runtime] [npm-tag]
#   container-runtime: docker (default) | podman
#   npm-tag:           latest (default) | 0.2.6 | file:.. (for local builds)

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
# --network host. Override via env if needed.
WORK_PORT="${WORK_PORT:-14002}"
DAEMON_PORT="${DAEMON_PORT:-14101}"

# opencode binary is host-specific (path may differ across machines). Mount
# readonly so the container preflight sees it on PATH. Override via env.
OPENCODE_HOST_BIN="${OPENCODE_HOST_BIN:-/home/dog/.local/bin/opencode}"

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

info "clean state"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

info "opencode binary on PATH"
opencode --version | head -1

info "npm install -g ework-web@${NPM_TAG} ework-daemon@latest ework-aio@${NPM_TAG}"
# Note: ework-web and ework-daemon aren't version-locked to ework-aio. We
# always install latest of the services and only parameterize ework-aio so
# we can E2E-test a PR branch against published services.
for pkg in ework-web ework-daemon opencode-ework; do
  npm install -g "$pkg@latest" 2>&1 | tail -2
done
npm install -g "ework-aio@${NPM_TAG}" 2>&1 | tail -2

info "v0.2.5 regression: all 4 bins on PATH"
for b in ework-aio ework-web ework-daemon ework-daemon-server; do
  command -v "$b" >/dev/null 2>&1 || fail "$b not on PATH"
  pass "$b -> $(command -v "$b")"
done

info "run ework-aio install (the real installer — no hand-rolled .env)"
# --allow-root: container runs as root; refusing would test an unrealistic
# path. The installer's data still lands in /tmp/aio-e2e via --data-dir.
ework-aio install \
  --allow-root \
  --data-dir "$DATA_DIR" \
  --port "$WORK_PORT" \
  --daemon-port "$DAEMON_PORT" \
  --bot-name e2e-bot \
  --yes 2>&1 | tee /tmp/install.log

pass "install exited 0"

info "v0.2.6 regression: webhook secrets match across web and daemon .env"
WEB_SEC=$(grep ^WORK_DAEMON_WEBHOOK_SECRET= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
DAE_SEC=$(grep ^GITEA_WEBHOOK_SECRET= "$DATA_DIR/ework-daemon/.env" | cut -d= -f2-)
[[ -n "$WEB_SEC" ]] || fail "WORK_DAEMON_WEBHOOK_SECRET empty in web .env"
[[ -n "$DAE_SEC" ]] || fail "GITEA_WEBHOOK_SECRET empty in daemon .env"
[[ "$WEB_SEC" == "$DAE_SEC" ]] \
  || fail "webhook secrets differ (web=$WEB_SEC daemon=$DAE_SEC)"
pass "secrets match (${#WEB_SEC} chars)"

info "v0.2.6 regression: WORK_ACCESS_LOG set, not defaulting to /tmp/ework-access.log"
ACCESS_LOG_VAL=$(grep ^WORK_ACCESS_LOG= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
[[ -n "$ACCESS_LOG_VAL" ]] || fail "WORK_ACCESS_LOG missing from web .env"
[[ "$ACCESS_LOG_VAL" != "/tmp/ework-access.log" ]] \
  || fail "WORK_ACCESS_LOG still defaults to /tmp/ework-access.log"
pass "WORK_ACCESS_LOG=$ACCESS_LOG_VAL"

info "wait for ework-web /login"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
    pass "/login responds (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && { tail -30 "$DATA_DIR/run/web.log" 2>/dev/null; fail "ework-web did not come up"; }
done

info "wait for daemon /api/status"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$DAEMON_PORT/api/status"; then
    pass "/api/status responds (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && { tail -30 "$DATA_DIR/run/daemon.log" 2>/dev/null; fail "daemon did not come up"; }
done

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

info "build admin auth cookie"
WORK_TOKEN=$(grep ^WORK_TOKEN= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
WORK_COOKIE_SECRET=$(grep ^WORK_COOKIE_SECRET= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
COOKIE_SIG=$(printf '%s' "$WORK_TOKEN" \
  | openssl dgst -sha256 -hmac "$WORK_COOKIE_SECRET" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')
AUTH_COOKIE="ework_auth=${WORK_TOKEN}.${COOKIE_SIG}"

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

echo
echo "===== E2E PASSED ====="
echo "  ework-aio version: $(ework-aio --version 2>/dev/null || echo unknown)"
echo "  data dir:          $DATA_DIR"
echo "  web:               http://127.0.0.1:$WORK_PORT/login"
echo "  daemon:            http://127.0.0.1:$DAEMON_PORT/api/status"
echo "  logs:              $DATA_DIR/run/{web,daemon}.log"
EOSCRIPT

echo
echo "${c_grn}E2E COMPLETE${c_rst}"
