#!/usr/bin/env bash
# Regression test: install published npm packages in a fresh container and
# verify each component launches + responds.
#
# Skips systemd (containers don't have it). Tests:
#   1. npm install -g ework-aio resolves all 3 deps
#   2. Bin shims (ework-aio, ework-web, ework-daemon-server) are on PATH
#   3. ework-web launches and /login responds 200
#   4. Bot user creation + PAT mint via API works
#   5. ework-daemon launches and /api/status responds
#   6. Plugin source loadable (opencode-ework resolves)
#
# Usage: ./scripts/regression.sh [container-runtime]
#   container-runtime: docker (default) | podman

set -euo pipefail

RUNTIME="${1:-docker}"
IMAGE="${IMAGE:-ework-aio:regression}"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*"; exit 1; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*"; }

if ! $RUNTIME image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Building $IMAGE (apt deps + npm pre-installed)"
  docker build --network=host -f Dockerfile.regression -t "$IMAGE" .
fi

info "Using image: $IMAGE"

NPM_VER=$($RUNTIME run --rm "$IMAGE" bash -c 'npm --version 2>&1 || echo MISSING' 2>&1)
info "container npm version: $NPM_VER"
[[ "$NPM_VER" != "MISSING" ]] || fail "npm not in $IMAGE"

info "Running regression in $RUNTIME / $IMAGE"

# Pick unique ports to avoid collisions with host's existing ework instances
# when running with --network host. Override via WORK_PORT/DAEMON_PORT env.
WORK_PORT="${WORK_PORT:-14002}"
DAEMON_PORT="${DAEMON_PORT:-14101}"

# --network host so container can reach host's HTTP proxy (HTTP_PROXY).
$RUNTIME run --rm -i --network host \
  -v /home/dog/.local/bin/opencode:/usr/local/bin/opencode:ro \
  -e WORK_PORT="$WORK_PORT" \
  -e DAEMON_PORT="$DAEMON_PORT" \
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

WORK_PORT="${WORK_PORT:-3002}"
DAEMON_PORT="${DAEMON_PORT:-3101}"

info "apt deps already in image (curl/jq/openssl present)"
command -v curl >/dev/null && pass "curl present"
command -v jq   >/dev/null && pass "jq present"

info "opencode binary"
opencode --version | head -1

info "npm install -g (each pkg top-level so bins link to PATH)"
for pkg in ework-web ework-daemon opencode-ework ework-aio; do
  npm install -g "$pkg" 2>&1 | tail -2
done

info "verify bin shims"
for b in ework-aio ework-web ework-daemon-server; do
  command -v "$b" >/dev/null 2>&1 || fail "$b not on PATH"
  pass "$b -> $(command -v "$b")"
done

info "ework-aio CLI smoke"
ework-aio --version
ework-aio env

info "preparing data dir"
mkdir -p /tmp/aio/ework-web /tmp/aio/ework-daemon /tmp/aio/opencode-workdir
cd /tmp/aio

WORK_TOKEN="$(openssl rand -hex 20)"
WORK_COOKIE_SECRET="$(openssl rand -hex 24)"
WEBHOOK_SECRET="$(openssl rand -hex 20)"
BOT_NAME="regression-bot"

cat > ework-web/.env <<EOF
WORK_PORT=$WORK_PORT
WORK_HOST=127.0.0.1
WORK_TOKEN=$WORK_TOKEN
WORK_COOKIE_SECRET=$WORK_COOKIE_SECRET
WORK_OPERATOR_LOGIN=root
WORK_WRITES_ENABLED=true
WORK_DB_PATH=/tmp/aio/ework-web/ework.db
WORK_ATTACHMENT_ROOT=/tmp/aio/ework-web/attachments
WORK_FILE_ROOTS=/tmp
WORK_DAEMON_BOT_LOGIN=$BOT_NAME
WORK_DAEMON_WEBHOOK_URL=http://127.0.0.1:$DAEMON_PORT
WORK_DAEMON_WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
chmod 600 ework-web/.env
info "WORK_TOKEN=$WORK_TOKEN"

info "launch ework-web in background"
cd /tmp/aio/ework-web
set -a; source .env; set +a
bun "$(npm root -g)/ework-web/bin/ework-web.js" \
  > /tmp/aio/ework-web.log 2>&1 &
EWEB_PID=$!
info "ework-web pid=$EWEB_PID"

cleanup() { kill $EWEB_PID ${EDAEMON_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

info "wait for ework-web /login"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
    pass "/login responds (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && { tail -50 /tmp/aio/ework-web.log; fail "ework-web did not come up"; }
done

info "build auth cookie"
COOKIE_SIG=$(printf '%s' "$WORK_TOKEN" \
  | openssl dgst -sha256 -hmac "$WORK_COOKIE_SECRET" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')
AUTH_COOKIE="ework_auth=${WORK_TOKEN}.${COOKIE_SIG}"

info "create bot user"
BOT_PW="$(openssl rand -hex 24)"
CREATE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$WORK_PORT/admin/users/create" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode "login=$BOT_NAME" \
  --data-urlencode "password=$BOT_PW" \
  --data-urlencode "kind=bot" \
  --data-urlencode "is_admin=0")
[[ "$CREATE_CODE" == "303" || "$CREATE_CODE" == "400" || "$CREATE_CODE" == "409" ]] \
  || fail "bot user create failed: HTTP $CREATE_CODE"
pass "bot user create returned $CREATE_CODE"

info "login as bot + mint PAT"
COOKIE_JAR=$(mktemp)
LOGIN_CODE=$(curl -sS -c "$COOKIE_JAR" -X POST "http://127.0.0.1:$WORK_PORT/login" \
  --data-urlencode "login=$BOT_NAME" \
  --data-urlencode "password=$BOT_PW" \
  -o /dev/null -w '%{http_code}')
BOT_COOKIE=$(awk '/ework_auth/ {print $7}' "$COOKIE_JAR")
rm -f "$COOKIE_JAR"
[[ "$LOGIN_CODE" == "302" && -n "$BOT_COOKIE" ]] || fail "bot login failed: HTTP $LOGIN_CODE"
PAT_RES=$(curl -sS -X POST "http://127.0.0.1:$WORK_PORT/me/tokens/create" \
  -H "Cookie: ework_auth=$BOT_COOKIE" \
  --data-urlencode "name=aio-regression")
BOT_TOKEN=$(printf '%s' "$PAT_RES" | grep -oE 'id="t">[a-f0-9]{40}<' | grep -oE '[a-f0-9]{40}' | head -1 || true)
[[ -n "$BOT_TOKEN" ]] || fail "could not extract PAT from token-create page"
pass "bot PAT minted (${#BOT_TOKEN} chars)"

info "write daemon .env + launch"
cat > /tmp/aio/ework-daemon/.env <<EOF
DAEMON_ENV=production
DAEMON_PORT=$DAEMON_PORT
DAEMON_HOST=127.0.0.1
DAEMON_DB_PATH=/tmp/aio/ework-daemon/ework-daemon.db
GITEA_URL=http://127.0.0.1:$WORK_PORT
GITEA_TOKEN=$BOT_TOKEN
GITEA_WEBHOOK_SECRET=$WEBHOOK_SECRET
BOT_USERNAME=$BOT_NAME
BOT_TOKEN=$BOT_TOKEN
OPENCODE_BINARY=$(command -v opencode)
OPENCODE_BASE_WORKDIR=/tmp/aio/opencode-workdir
EOF
chmod 600 /tmp/aio/ework-daemon/.env

cd /tmp/aio/ework-daemon
set -a; source .env; set +a
bun "$(npm root -g)/ework-daemon/bin/ework-daemon-server.js" \
  > /tmp/aio/ework-daemon.log 2>&1 &
EDAEMON_PID=$!
info "ework-daemon pid=$EDAEMON_PID"

info "wait for daemon /api/status"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$DAEMON_PORT/api/status"; then
    pass "/api/status responds (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && { tail -30 /tmp/aio/ework-daemon.log; fail "daemon did not come up"; }
done

info "daemon status:"
curl -sS "http://127.0.0.1:$DAEMON_PORT/api/status" | jq -c '{env,daemon,db,running,issues}'

info "verify opencode-ework plugin loadable from node_modules"
PLUGIN_PATH="$(npm root -g)/ework-aio/node_modules/opencode-ework/src/index.ts"
[[ -f "$PLUGIN_PATH" ]] || PLUGIN_PATH="$(npm root -g)/opencode-ework/src/index.ts"
[[ -f "$PLUGIN_PATH" ]] || fail "opencode-ework/src/index.ts not found"
pass "plugin source at $PLUGIN_PATH"

info "create test project + issue to exercise end-to-end API"
PROJ_RES=$(curl -sS -X POST "http://127.0.0.1:$WORK_PORT/projects" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode 'owner=regression' \
  --data-urlencode 'name=test' \
  -o /dev/null -w '%{http_code}')
[[ "$PROJ_RES" == "303" || "$PROJ_RES" == "302" ]] || fail "project create failed: HTTP $PROJ_RES"
pass "project create -> $PROJ_RES"

info "issue POST (no -L) to capture redirect:"
ISSUE_HEAD=$(curl -sS -i -X POST "http://127.0.0.1:$WORK_PORT/regression/test/issues" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode 'title=regression test' \
  --data-urlencode 'body=verify npm-installed stack works')
ISSUE_LOCATION=$(printf '%s\n' "$ISSUE_HEAD" | grep -i '^Location:' | awk '{print $2}' | tr -d '\r\n')
info "issue create redirect -> $ISSUE_LOCATION"

ISSUE_RES=$(printf '%s\n' "$ISSUE_HEAD" | head -1 | awk '{print $2}')
[[ "$ISSUE_RES" == "303" ]] || fail "issue create failed: HTTP $ISSUE_RES"
pass "issue create -> $ISSUE_RES"

info "GET issue page via Location:"
ISSUE_VIEW_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$ISSUE_LOCATION" -H "Cookie: $AUTH_COOKIE")
[[ "$ISSUE_VIEW_CODE" == "200" ]] || fail "issue view GET failed: HTTP $ISSUE_VIEW_CODE"
pass "issue view GET -> $ISSUE_VIEW_CODE"

ISSUE_LIST=$(curl -sS "http://127.0.0.1:$WORK_PORT/regression/test/issues" \
  -H "Cookie: $AUTH_COOKIE" -L | grep -oE 'issues/[0-9]+' | head -3)
info "found issue links: $ISSUE_LIST"

echo
echo "===== REGRESSION PASSED ====="
echo "  ework-web:    http://127.0.0.1:$WORK_PORT/login  (token: $WORK_TOKEN)"
echo "  ework-daemon: http://127.0.0.1:$DAEMON_PORT/api/status"
echo "  logs:         /tmp/aio/ework-web.log, /tmp/aio/ework-daemon.log"
EOSCRIPT

echo
echo "${c_grn}REGRESSION COMPLETE${c_rst}"
