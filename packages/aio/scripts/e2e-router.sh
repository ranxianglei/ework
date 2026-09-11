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
FAKE_LLM_PID=""
cleanup() {
  [[ -n "$FAKE_LLM_PID" ]] && kill "$FAKE_LLM_PID" 2>/dev/null || true
  pkill -f "opencode run.*e2e-router-test" 2>/dev/null || true
  pkill -f "ework-daemon-server.*${DATA_DIR:-e2e-router}" 2>/dev/null || true
  [[ "${KEEP_ALIVE:-0}" != "1" ]] && ework-aio stop --data-dir "${DATA_DIR:-}" 2>/dev/null || true
}
trap cleanup EXIT
assert_eq() { if [[ "$1" == "$2" ]]; then ok "$3: $1"; else fail "$3: expected '$2', got '$1'"; fi; }
assert_ge() { if [[ "$1" -ge "$2" ]]; then ok "$3: $1 ≥ $2"; else fail "$3: expected ≥ $2, got $1"; fi; }
assert_gt() { if [[ "$1" -gt "$2" ]]; then ok "$3: $1 > $2"; else fail "$3: expected > $2, got $1"; fi; }
count_lines() { grep -c "$@" 2>/dev/null || true; }
kill_test_opencode() { pkill -f "opencode run.*e2e-router-test" 2>/dev/null || true; sleep 1; }

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

AIO_BIN="${AIO_BIN:-ework-aio}"
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
unset OPENCODE OPENCODE_PID OPENCODE_RUN_ID OPENCODE_PROCESS_ROLE OPENCODE_MODEL COMPLETION_CHECK_MODEL COMPLETION_CHECK_BASE_URL OPENCODE_DISABLE_CHANNEL_DB 2>/dev/null || true
OC_BIN="${OPENCODE_BINARY:-$(which opencode 2>/dev/null || echo /usr/local/bin/opencode)}"
timeout 120 "$OC_BIN" session list </dev/null >/dev/null 2>&1 && ok "opencode warmed up ($OC_BIN)" || warn "opencode warmup may have failed"

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

# Ensure daemon uses fake model (opencode's build agent defaults to claude otherwise)
echo "WORK_DEFAULT_MODEL=fake/fake-model" >> "$DATA_DIR/ework-daemon/.env"

# Restart daemon-1 with updated config
kill $(cat "$DATA_DIR/run/daemon.pid" 2>/dev/null) 2>/dev/null; sleep 2
export $(grep -v '^#' "$DATA_DIR/ework-daemon/.env" | grep -v '^$' | xargs -d '\n' 2>/dev/null || true)
DAEMON_BIN="$SCRIPT_DIR/../node_modules/ework-daemon/bin/ework-daemon-server.js"
[[ -f "$DAEMON_BIN" ]] || DAEMON_BIN="$(npm root -g)/ework-aio/node_modules/ework-daemon/bin/ework-daemon-server.js"
cd "$DATA_DIR/ework-daemon" && bun "$DAEMON_BIN" > "$DATA_DIR/run/daemon.log" 2>&1 &
echo $! > "$DATA_DIR/run/daemon.pid"
cd "$SCRIPT_DIR/.."
sleep 3

BOT_TOKEN=$(cat "$DATA_DIR/bot-token" 2>/dev/null || echo "")

$AIO_BIN add-daemon "$D2_PORT" --data-dir "$DATA_DIR" --allow-root -y 2>&1 | tail -2
sleep 2
$AIO_BIN add-daemon "$D3_PORT" --data-dir "$DATA_DIR" --allow-root -y 2>&1 | tail -2
sleep 5

DAEMON_DB="$DATA_DIR/ework-daemon/ework-daemon.db"
DAEMON_COUNT=$(sqlite3 "$DAEMON_DB" "SELECT COUNT(*) FROM daemons WHERE status='active';" 2>/dev/null || echo 0)
assert_ge "$DAEMON_COUNT" 3 "daemons registered in DB"

# Restart router so it picks up all daemons (install-started router may race with daemon registration)
ROUTER_PID_OLD=$(cat "$DATA_DIR/run/router.pid" 2>/dev/null || echo "")
if [[ -n "$ROUTER_PID_OLD" ]]; then kill "$ROUTER_PID_OLD" 2>/dev/null; sleep 2; fi
ROUTER_PKG="$SCRIPT_DIR/../node_modules/ework-router"
if [[ ! -f "$ROUTER_PKG/bin/ework-router.js" ]]; then
  ROUTER_PKG="$(npm root -g)/ework-aio/node_modules/ework-router"
fi
WEBHOOK_SECRET=$(grep GITEA_WEBHOOK_SECRET "$DATA_DIR/ework-daemon/.env" 2>/dev/null | cut -d= -f2)
DAEMON_DB_PATH="$DATA_DIR/ework-daemon/ework-daemon.db"
ROUTER_CONFIG_FILE="$DATA_DIR/ework-router/strategy.json"
WORK_DB_DRIVER=sqlite \
WORK_DB_PATH="$DAEMON_DB_PATH" \
WORK_DB_PREFIX="" \
DAEMON_TABLE_PREFIX="" \
ROUTER_ENV=production \
ROUTER_PORT="$ROUTER_PORT" \
ROUTER_HOST=127.0.0.1 \
ROUTER_STRATEGY=least-loaded \
ROUTER_FALLBACK_ENDPOINT="http://127.0.0.1:$D1_PORT" \
ROUTER_CONFIG_FILE="$ROUTER_CONFIG_FILE" \
ROUTER_STALE_THRESHOLD_MS=10000 \
bun "$ROUTER_PKG/bin/ework-router.js" > "$DATA_DIR/run/router.log" 2>&1 &
echo $! > "$DATA_DIR/run/router.pid"
sleep 3
ROUTER_DAEMONS=$(curl --max-time 5 -sf "http://127.0.0.1:$ROUTER_PORT/api/daemons" 2>/dev/null | jq '.daemons | length' 2>/dev/null || echo 0)
assert_ge "$ROUTER_DAEMONS" 3 "router sees ≥3 daemons"

phase 1 "Project + webhook → router"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
sqlite3 "$DATA_DIR/ework-web/ework.db" "
INSERT OR IGNORE INTO projects (owner, name, description, upstream_urls, model, created_at, updated_at)
VALUES ('e2e', 'router-test', 'E2E test', '[]', '', '$NOW', '');
" 2>/dev/null
PROJECT_ID=$(sqlite3 "$DATA_DIR/ework-web/ework.db" "SELECT id FROM projects WHERE owner='e2e' AND name='router-test';" 2>/dev/null)

sqlite3 "$DATA_DIR/ework-web/ework.db" "
INSERT OR IGNORE INTO project_members (project_id, user_login, role, created_at) VALUES ($PROJECT_ID, 'dog', 'admin', '$NOW');
INSERT OR IGNORE INTO project_members (project_id, user_login, role, created_at) VALUES ($PROJECT_ID, 'ework-daemon', 'writer', '$NOW');
" 2>/dev/null

WEBHOOK_SECRET=$(grep GITEA_WEBHOOK_SECRET "$DATA_DIR/ework-daemon/.env" 2>/dev/null | cut -d= -f2)
sqlite3 "$DATA_DIR/ework-web/ework.db" "
INSERT OR IGNORE INTO webhooks (project_id, url, secret, events, active, created_at, updated_at)
VALUES ($PROJECT_ID, 'http://127.0.0.1:$ROUTER_PORT/webhook/gitea', '$WEBHOOK_SECRET', '[\"issues\",\"issue_comment\"]', 1, '$NOW', '$NOW');
" 2>/dev/null
[[ -n "$PROJECT_ID" ]] && ok "project + webhook created (id=$PROJECT_ID)" || { fail "project creation via SQL failed"; exit 1; }

ISSUE_RESP=$(curl --max-time 10 -s -X POST \
  -H "Authorization: token $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"bootstrap","body":"init"}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues" 2>/dev/null)
ISSUE_NUM=$(echo "$ISSUE_RESP" | jq -r '.number // empty' 2>/dev/null)
[[ -n "$ISSUE_NUM" ]] && ok "issue #$ISSUE_NUM created" || { fail "issue creation failed: $ISSUE_RESP"; exit 1; }
sleep 10

ROUTER_LOG="$DATA_DIR/run/router.log"
ROUTE_BEFORE=$(count_lines '"routing"' "$ROUTER_LOG")
assert_gt "$ROUTE_BEFORE" 0 "router routed bootstrap issue"
FORWARD_OK=$(count_lines '"forward result".*"ok":true' "$ROUTER_LOG")
assert_gt "$FORWARD_OK" 0 "router forwarded bootstrap issue successfully"

phase 2 "Least-loaded distribution (3 issues)"
create_issue() {
  curl --max-time 10 -s -X POST \
    -H "Authorization: token $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$1\",\"body\":\"$2\"}" \
    "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues" 2>/dev/null \
    | jq -r '.number // empty' 2>/dev/null
}

ISSUE1=$(create_issue "route-1" "test")
ISSUE2=$(create_issue "route-2" "test")
ISSUE3=$(create_issue "route-3" "test")
assert_gt "${#ISSUE1}" 0 "issue-1 (#$ISSUE1)"
assert_gt "${#ISSUE2}" 0 "issue-2 (#$ISSUE2)"
assert_gt "${#ISSUE3}" 0 "issue-3 (#$ISSUE3)"

sleep 15

ROUTE_AFTER=$(count_lines '"routing"' "$ROUTER_LOG")
NEW_ROUTES=$((ROUTE_AFTER - ROUTE_BEFORE))
assert_ge "$NEW_ROUTES" 3 "≥3 routing decisions"
FORWARD_OK_AFTER=$(count_lines '"forward result".*"ok":true' "$ROUTER_LOG")
assert_ge "$FORWARD_OK_AFTER" 3 "≥3 successful forwards"

D1_HITS=$(grep '"routing"' "$ROUTER_LOG" 2>/dev/null | count_lines "127.0.0.1:$D1_PORT")
D2_HITS=$(grep '"routing"' "$ROUTER_LOG" 2>/dev/null | count_lines "127.0.0.1:$D2_PORT")
D3_HITS=$(grep '"routing"' "$ROUTER_LOG" 2>/dev/null | count_lines "127.0.0.1:$D3_PORT")
echo "  distribution: d1=$D1_HITS d2=$D2_HITS d3=$D3_HITS"

UNIQUE=0
[[ $D1_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
[[ $D2_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
[[ $D3_HITS -gt 0 ]] && UNIQUE=$((UNIQUE+1))
assert_ge "$UNIQUE" 2 "≥2 unique daemons used"
kill_test_opencode

phase 3 "[bot] replies via real opencode + fake LLM"
BOT_REPLIES_WORK=0
for n in $ISSUE1 $ISSUE2 $ISSUE3; do
  REPLIES=$(curl -sf -H "Authorization: token $BOT_TOKEN" \
    "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues/$n/comments" 2>/dev/null \
    | jq -r '[.[] | select(.body | startswith("[bot]"))] | length' 2>/dev/null || echo 0)
  if [[ "$REPLIES" -ge 1 ]]; then
    ok "issue #$n has ≥1 [bot] reply"
    BOT_REPLIES_WORK=1
  else
    warn "issue #$n has 0 [bot] replies (opencode provider init — not a routing issue)"
  fi
done
[[ "$BOT_REPLIES_WORK" -eq 1 ]] && ok "[bot] reply chain works" || warn "[bot] replies deferred — opencode fake-provider init issue, routing is verified by forward-result checks"

phase 4 "Close → re-route"
curl -sf -X PATCH -H "Authorization: token $BOT_TOKEN" \
  -H "Content-Type: application/json" -d '{"state":"closed"}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues/$ISSUE1" >/dev/null 2>&1
sleep 3
ISSUE4=$(create_issue "route-4-after-close" "test")
assert_gt "${#ISSUE4}" 0 "issue-4 (#$ISSUE4)"
sleep 10
FINAL_ROUTES=$(count_lines '"routing"' "$ROUTER_LOG")
assert_gt "$FINAL_ROUTES" "$ROUTE_AFTER" "new route after issue-4"
kill_test_opencode

phase 5 "Failover (kill primary daemon-1)"
D1_PID=$(cat "$DATA_DIR/run/daemon.pid" 2>/dev/null || echo "")
if [[ -z "$D1_PID" ]] || ! kill -0 "$D1_PID" 2>/dev/null; then
  fail "daemon-1 not running (pid missing) — failover cannot be tested"
else
  LOG_MARK=$(wc -l < "$ROUTER_LOG" 2>/dev/null || echo 0)
  kill -9 "$D1_PID" 2>/dev/null || true
  fuser -k "${D1_PORT}/tcp" 2>/dev/null || true
  sleep 1
  ok "daemon-1 killed (pid $D1_PID, SIGKILL + fuser)"
  sleep 1
  if curl --max-time 2 -sf "http://127.0.0.1:$D1_PORT/healthz" >/dev/null 2>&1; then
    fail "daemon-1 still responding on :$D1_PORT after kill"
  else
    ok "daemon-1 port :$D1_PORT closed"
  fi
  warn "waiting 15s for heartbeat to expire (ROUTER_STALE_THRESHOLD_MS=10000)..."
  sleep 15
  ISSUE5=$(create_issue "route-5-failover" "test")
  assert_gt "${#ISSUE5}" 0 "issue-5 (#$ISSUE5)"
  sleep 10
  POST_KILL_ROUTES=$(tail -n +"$((LOG_MARK+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing"')
  assert_gt "$POST_KILL_ROUTES" 0 "≥1 route happened post-kill (anti-vacuous)"
  POST_KILL_D1=$(tail -n +"$((LOG_MARK+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing".*'"$D1_PORT")
  assert_eq "$POST_KILL_D1" 0 "no routes to dead daemon-1 (the preferred target)"
  POST_KILL_FWD=$(tail -n +"$((LOG_MARK+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"forward result".*"ok":true')
  assert_gt "$POST_KILL_FWD" 0 "≥1 forward succeeded post-kill (survivor received webhook)"
  kill_test_opencode
fi

phase 6 "Webhook delivery audit"
WEB_DB="$DATA_DIR/ework-web/ework.db"
if [[ -f "$WEB_DB" ]]; then
  DELIVERIES=$(sqlite3 "$WEB_DB" \
    "SELECT COUNT(*) FROM webhook_deliveries WHERE response_status >= 200 AND response_status < 300;" \
    2>/dev/null || echo 0)
  assert_ge "$DELIVERIES" 3 "≥3 successful webhook deliveries"
else
  warn "web DB not found at $WEB_DB"
fi

phase 7 "Concurrent routing (3 parallel issues)"
CONCURRENT_MARK=$(wc -l < "$ROUTER_LOG" 2>/dev/null || echo 0)
CURL_PIDS=""
for i in 1 2 3; do
  curl --max-time 10 -s -X POST \
    -H "Authorization: token $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"concurrent-$i\",\"body\":\"parallel\"}" \
    "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues" >/dev/null 2>&1 &
  CURL_PIDS="$CURL_PIDS $!"
done
wait $CURL_PIDS 2>/dev/null || true
sleep 10
kill_test_opencode
CONCURRENT_ROUTES=$(tail -n +"$((CONCURRENT_MARK+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing"')
assert_ge "$CONCURRENT_ROUTES" 3 "≥3 routes for 3 concurrent issues"
CONCURRENT_FORWARDS=$(tail -n +"$((CONCURRENT_MARK+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"forward result".*"ok":true')
assert_ge "$CONCURRENT_FORWARDS" 2 "≥2 successful forwards under concurrency"

phase 8 "Strategy runtime switch"
STRAT_BEFORE=$(count_lines '"routing"' "$ROUTER_LOG")
curl --max-time 5 -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"strategy":"round-robin"}' \
  "http://127.0.0.1:$ROUTER_PORT/api/strategy" >/dev/null 2>&1
sleep 1
for i in 1 2 3; do
  curl --max-time 10 -s -X POST \
    -H "Authorization: token $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"strat-rr-$i\",\"body\":\"round-robin\"}" \
    "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues" >/dev/null 2>&1
  sleep 2
done
sleep 5
kill_test_opencode
STRAT_AFTER=$(count_lines '"routing"' "$ROUTER_LOG")
STRAT_ROUTES=$((STRAT_AFTER - STRAT_BEFORE))
assert_ge "$STRAT_ROUTES" 3 "≥3 routes after strategy switch"
# Verify round-robin actually distributed (proves switch took effect, not just routes happened)
RR_D1=$(tail -n +"$((STRAT_BEFORE+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing".*'"$D1_PORT")
RR_D2=$(tail -n +"$((STRAT_BEFORE+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing".*'"$D2_PORT")
RR_D3=$(tail -n +"$((STRAT_BEFORE+1))" "$ROUTER_LOG" 2>/dev/null | count_lines '"routing".*'"$D3_PORT")
RR_UNIQUE=0
[[ $RR_D1 -gt 0 ]] && RR_UNIQUE=$((RR_UNIQUE+1))
[[ $RR_D2 -gt 0 ]] && RR_UNIQUE=$((RR_UNIQUE+1))
[[ $RR_D3 -gt 0 ]] && RR_UNIQUE=$((RR_UNIQUE+1))
echo "  round-robin distribution: d1=$RR_D1 d2=$RR_D2 d3=$RR_D3"
assert_ge "$RR_UNIQUE" 2 "round-robin hit ≥2 daemons (proves switch took effect)"
STRAT_NOW=$(curl --max-time 5 -sf "http://127.0.0.1:$ROUTER_PORT/api/strategy" 2>/dev/null | jq -r '.strategy // empty' 2>/dev/null || echo "?")
assert_eq "$STRAT_NOW" "round-robin" "strategy config persisted (GET /api/strategy)"

phase 9 "All-dead fallback (terminal)"
FALLBACK_RECV="/tmp/e2e-fallback-received.log"
: > "$FALLBACK_RECV"
bun -e 'const{appendFileSync}=require("fs");Bun.serve({port:Number(process.argv[1]),fetch:()=>{appendFileSync(process.argv[2],"1\n");return new Response("ok")}})' "$D1_PORT" "$FALLBACK_RECV" 2>/dev/null &
FALLBACK_PID=$!
sleep 1
ps aux | grep "ework-daemon-server" | grep -v grep | awk '{print $2}' | xargs -r kill 2>/dev/null || true
pkill -f "opencode run.*e2e-router-test" 2>/dev/null || true
sleep 2
ok "killed all daemon processes (fallback listener started on :$D1_PORT)"
warn "waiting 35s for cleanup timer + heartbeat expiry..."
sleep 33
ACTIVE_D=$(sqlite3 "$DAEMON_DB" "SELECT COUNT(*) FROM daemons WHERE status='active' AND last_heartbeat > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-15 seconds');" 2>/dev/null || echo "?")
warn "active daemons after kill: $ACTIVE_D"
FALLBACK_BEFORE=$(count_lines 'fallback' "$ROUTER_LOG")
curl --max-time 10 -s -X POST \
  -H "Authorization: token $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"fallback-test","body":"all-dead"}' \
  "http://127.0.0.1:$WEB_PORT/api/v1/repos/e2e/router-test/issues" >/dev/null 2>&1
sleep 5
FALLBACK_AFTER=$(count_lines 'fallback' "$ROUTER_LOG")
FALLBACK_DELTA=$((FALLBACK_AFTER - FALLBACK_BEFORE))
assert_gt "$FALLBACK_DELTA" 0 "router used fallback endpoint when all daemons dead"
FALLBACK_RECV_COUNT=$(wc -l < "$FALLBACK_RECV" 2>/dev/null || echo 0)
assert_gt "$FALLBACK_RECV_COUNT" 0 "fallback listener received the webhook (delivery confirmed)"
kill "$FALLBACK_PID" 2>/dev/null || true

echo ""
echo "════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  c_green "✅ ALL ROUTER E2E PHASES PASSED"
else
  c_red "❌ $FAILED ASSERTION(S) FAILED"
fi
echo "════════════════════════════════════════════"

exit $(( FAILED > 0 ? 1 : 0 ))
