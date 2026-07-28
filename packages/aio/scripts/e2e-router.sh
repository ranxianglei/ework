#!/usr/bin/env bash
set -euo pipefail

NPM_TAG="${2:-latest}"
DATA_DIR="${E2E_DATA_DIR:-/tmp/e2e-router}"
FAKE_HOME="${E2E_FAKE_HOME:-/tmp/e2e-router-home}"
FAKE_LLM_PORT="${E2E_LLM_PORT:-8401}"
WEB_PORT="${E2E_WEB_PORT:-3002}"
ROUTER_PORT="${E2E_ROUTER_PORT:-3104}"
D1_PORT="${E2E_D1_PORT:-3101}"
D2_PORT="${E2E_D2_PORT:-3102}"
D3_PORT="${E2E_D3_PORT:-3103}"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
phase() { echo ""; c_blue "━━━ Phase $1: $2 ━━━"; }
ok()    { c_green "  ✓ $*"; }
warn()  { c_yellow "  ! $*"; }
fail()  { c_red "  ✗ FAIL: $*"; FAILED=$((FAILED+1)); }

FAILED=0
assert_eq() { if [[ "$1" == "$2" ]]; then ok "$3: $1"; else fail "$3: expected '$2', got '$1'"; fi; }
assert_ge() { if [[ "$1" -ge "$2" ]]; then ok "$3: $1 ≥ $2"; else fail "$3: expected ≥ $2, got $1"; fi; }
assert_gt() { if [[ "$1" -gt "$2" ]]; then ok "$3: $1 > $2"; else fail "$3: expected > $2, got $1"; fi; }

if [[ "${1:-}" == "docker" ]]; then
  IMAGE="ework-aio:router-e2e"
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  echo "Building Docker image $IMAGE..."
  docker build -f "$SCRIPT_DIR/../Dockerfile.regression" -t "$IMAGE" "$SCRIPT_DIR/.."
  echo "Running router E2E (npm tag: $NPM_TAG)..."
  docker run --rm --network host \
    -e NPM_TAG="$NPM_TAG" \
    -v "$SCRIPT_DIR/e2e-router.sh:/e2e-router.sh:ro" \
    -v "$SCRIPT_DIR/fake-llm-server.ts:/fake-llm-server.ts:ro" \
    "$IMAGE" \
    bash -c "npm install -g ework-aio@\"\$NPM_TAG\" 2>/dev/null && bash /e2e-router.sh local"
  exit $?
fi

echo "╔════════════════════════════════════════════╗"
echo "║  e2e-router.sh — Multi-daemon routing E2E  ║"
echo "║  Real opencode + fake LLM + 3 daemons      ║"
echo "╚════════════════════════════════════════════╝"

phase 0 "Bootstrap (fake LLM + opencode config + services)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ework-aio stop 2>/dev/null || true
ework-aio stop --data-dir "$DATA_DIR" 2>/dev/null || true
sleep 2

bun run "${SCRIPT_DIR}/fake-llm-server.ts" 2>/tmp/e2e-fakellm.log &
FAKE_LLM_PID=$!
sleep 1
if curl -sf "http://127.0.0.1:$FAKE_LLM_PORT/v1/models" >/dev/null 2>&1; then
  ok "fake LLM on :$FAKE_LLM_PORT (pid $FAKE_LLM_PID)"
else
  fail "fake LLM not responding"; cat /tmp/e2e-fakellm.log; exit 1
fi

FAKE_XDG="$FAKE_HOME/.config"
rm -rf "$FAKE_HOME"
mkdir -p "$FAKE_XDG/opencode"
cat > "$FAKE_XDG/opencode/opencode.json" <<OCJSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ework@latest"],
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake (E2E)",
      "options": { "baseURL": "http://127.0.0.1:$FAKE_LLM_PORT/v1" },
      "models": { "fake-model": { "name": "Fake Model" } }
    }
  },
  "model": "fake/fake-model",
  "permission": { "reply": "allow", "bash": "allow" }
}
OCJSON
ok "opencode config with fake provider"

export XDG_CONFIG_HOME="$FAKE_XDG"
OC_BIN="${OPENCODE_BINARY:-$(which opencode 2>/dev/null || echo /usr/local/bin/opencode)}"
timeout 120 "$OC_BIN" session list </dev/null >/dev/null 2>&1 || true
ok "opencode warmed up ($OC_BIN)"

rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"
rm -f "$DATA_DIR/bot-token"

ework-aio install --yes --allow-root \
  --data-dir "$DATA_DIR" \
  --port "$WEB_PORT" \
  --daemon-port "$D1_PORT" 2>&1 | tail -5

sleep 5
[[ "$(curl -sf http://127.0.0.1:$WEB_PORT/healthz 2>/dev/null || echo FAIL)" != "FAIL" ]] \
  && ok "web on :$WEB_PORT" || { fail "web not responding"; exit 1; }
[[ "$(curl -sf http://127.0.0.1:$ROUTER_PORT/api/health 2>/dev/null || echo FAIL)" != "FAIL" ]] \
  && ok "router on :$ROUTER_PORT" || { fail "router not responding"; exit 1; }

WORK_TOKEN=$(grep WORK_TOKEN "$DATA_DIR/ework-web/.env" | cut -d= -f2)
COOKIE_SECRET=$(grep WORK_COOKIE_SECRET "$DATA_DIR/ework-web/.env" | cut -d= -f2)
BOT_TOKEN=$(cat "$DATA_DIR/bot-token" 2>/dev/null || echo "")

AUTH_COOKIE=$(node -e "
const crypto = require('crypto');
const now = Math.floor(Date.now()/1000);
const msg = 'v2.dog.' + now;
console.log(msg + '.' + crypto.createHmac('sha256', '$COOKIE_SECRET').update(msg).digest('base64url'));
")

ework-aio add-daemon "$D2_PORT" --data-dir "$DATA_DIR" --allow-root -y 2>&1 | tail -2
sleep 2
ework-aio add-daemon "$D3_PORT" --data-dir "$DATA_DIR" --allow-root -y 2>&1 | tail -2
sleep 5

DAEMON_DB="$DATA_DIR/ework-daemon/ework-daemon.db"
DAEMON_COUNT=$(sqlite3 "$DAEMON_DB" "SELECT COUNT(*) FROM daemons WHERE status='active';" 2>/dev/null || echo 0)
assert_ge "$DAEMON_COUNT" 3 "daemons registered in DB"

phase 1 "Project + webhook → router"
LOC=$(curl -s -o /dev/null -D - -X POST \
  -H "Cookie: ework_auth=$AUTH_COOKIE" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "title=bootstrap&body=init" \
  "http://127.0.0.1:$WEB_PORT/e2e/router-test/issues/new" 2>/dev/null \
  | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
[[ -n "$LOC" ]] && ok "project+issue created" || { fail "issue creation failed"; exit 1; }
sleep 8

ROUTER_LOG="$DATA_DIR/run/router.log"
ROUTE_BEFORE=$(grep -c '"routing"' "$ROUTER_LOG" 2>/dev/null || echo 0)
assert_gt "$ROUTE_BEFORE" 0 "router routed bootstrap issue"

phase 2 "Least-loaded distribution (3 issues)"
create_issue() {
  curl -s -o /dev/null -D - -X POST \
    -H "Cookie: ework_auth=$AUTH_COOKIE" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "title=$1&body=$2" \
    "http://127.0.0.1:$WEB_PORT/e2e/router-test/issues/new" 2>/dev/null \
    | grep -i '^location:' | tr -d '\r' | awk '{print $2}' | grep -oP '\d+$'
}

ISSUE1=$(create_issue "route-1" "test")
ISSUE2=$(create_issue "route-2" "test")
ISSUE3=$(create_issue "route-3" "test")
assert_gt "${#ISSUE1}" 0 0 "issue-1 (#$ISSUE1)"
assert_gt "${#ISSUE2}" 0 0 "issue-2 (#$ISSUE2)"
assert_gt "${#ISSUE3}" 0 0 "issue-3 (#$ISSUE3)"

sleep 15

ROUTE_AFTER=$(grep -c '"routing"' "$ROUTER_LOG" 2>/dev/null || echo 0)
NEW_ROUTES=$((ROUTE_AFTER - ROUTE_BEFORE))
assert_ge "$NEW_ROUTES" 3 "≥3 routing decisions"

D1_HITS=$(grep '"routing"' "$ROUTER_LOG" | grep -c "127.0.0.1:$D1_PORT" || echo 0)
D2_HITS=$(grep '"routing"' "$ROUTER_LOG" | grep -c "127.0.0.1:$D2_PORT" || echo 0)
D3_HITS=$(grep '"routing"' "$ROUTER_LOG" | grep -c "127.0.0.1:$D3_PORT" || echo 0)
echo "  distribution: d1=$D1_HITS d2=$D2_HITS d3=$D3_HITS"

UNIQUE=0
[[ $D1_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
[[ $D2_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
[[ $D3_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
assert_ge "$UNIQUE" 2 "≥2 unique daemons used"

phase 3 "[bot] replies via real opencode + fake LLM"
for n in $ISSUE1 $ISSUE2 $ISSUE3; do
  REPLIES=$(curl -sf -H "Authorization: token $BOT_TOKEN" \
    "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues/$n/comments" 2>/dev/null \
    | jq -r '[.[] | select(.body | startswith("[bot]"))] | length' 2>/dev/null || echo 0)
  assert_ge "$REPLIES" 1 "issue #$n has ≥1 [bot] reply"
done

phase 4 "Close → re-route"
curl -sf -X PATCH -H "Authorization: token $BOT_TOKEN" \
  -H "Content-Type: application/json" -d '{"state":"closed"}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues/$ISSUE1" >/dev/null 2>&1
sleep 3
ISSUE4=$(create_issue "route-4-after-close" "test")
assert_gt "${#ISSUE4}" 0 0 "issue-4 (#$ISSUE4)"
sleep 10
FINAL_ROUTES=$(grep -c '"routing"' "$ROUTER_LOG" 2>/dev/null || echo 0)
assert_gt "$FINAL_ROUTES" "$ROUTE_AFTER" "new route after issue-4"

phase 5 "Failover (kill daemon-2)"
D2_PID=$(cat "$DATA_DIR/run/daemon-2.pid" 2>/dev/null || echo "")
if [[ -n "$D2_PID" ]] && kill -0 "$D2_PID" 2>/dev/null; then
  kill "$D2_PID" 2>/dev/null || true
  ok "daemon-2 killed (pid $D2_PID)"
  sleep 3
  ISSUE5=$(create_issue "route-5-failover" "test")
  assert_gt "${#ISSUE5}" 0 0 "issue-5 (#$ISSUE5)"
  sleep 10
  POST_KILL_D2=$(grep '"routing"' "$ROUTER_LOG" | tail -5 \
    | grep -c "127.0.0.1:$D2_PORT" || echo 0)
  assert_eq "$POST_KILL_D2" 0 "no routes to dead daemon-2"
else
  warn "daemon-2 not running, skipping failover"
fi

phase 6 "Webhook delivery audit"
WEB_DB="$DATA_DIR/ework-web/ework-web.db"
if [[ -f "$WEB_DB" ]]; then
  DELIVERIES=$(sqlite3 "$WEB_DB" \
    "SELECT COUNT(*) FROM webhook_deliveries WHERE status_code >= 200 AND status_code < 300;" \
    2>/dev/null || echo 0)
  assert_ge "$DELIVERIES" 3 "≥3 successful webhook deliveries"
else
  warn "web DB not found"
fi

echo ""
echo "════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  c_green "✅ ALL ROUTER E2E PHASES PASSED"
else
  c_red "❌ $FAILED ASSERTION(S) FAILED"
fi
echo "════════════════════════════════════════════"

kill "$FAKE_LLM_PID" 2>/dev/null || true
[[ "${KEEP_ALIVE:-0}" != "1" ]] && ework-aio stop 2>/dev/null || true
exit $FAILED
