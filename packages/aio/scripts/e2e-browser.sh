#!/usr/bin/env bash
# End-to-end browser test: install → fake LLM → opencode config → Playwright.
#
# This is the "full product path" test. Compared to e2e-install.sh (which
# covers install/subcommand/lifecycle), this script:
#   - Starts a fake OpenAI-compatible LLM server (scripts/fake-llm-server.ts)
#   - Configures opencode.json to use it (no external API needed)
#   - Creates an issue (which triggers daemon → opencode → fake LLM)
#   - Drives a headless browser through ework-web UI
#   - Verifies the resulting session is browsable and shows content
#
# Requires Docker image with Chromium pre-installed. The Dockerfile.regression
# image handles this; pass via IMAGE env or rely on the default.
#
# Usage: ./scripts/e2e-browser.sh [container-runtime] [npm-tag]

set -euo pipefail

RUNTIME="${1:-docker}"
NPM_TAG="${2:-latest}"
IMAGE="${IMAGE:-ework-aio:e2e}"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*"; exit 1; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! "$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Building $IMAGE (with Chromium deps — first build is slow)"
  "$RUNTIME" build --network=host -f "$REPO_ROOT/Dockerfile.regression" \
    -t "$IMAGE" "$REPO_ROOT"
fi

info "Using image: $IMAGE"

# Hardcoded ports — see e2e-install.sh for why we don't inherit from host.
WORK_PORT="14002"
DAEMON_PORT="14101"
FAKE_LLM_PORT="8400"

OPENCODE_HOST_BIN="${OPENCODE_HOST_BIN:-/home/dog/.local/bin/opencode}"

"$RUNTIME" run --rm -i --network host \
  -v "$OPENCODE_HOST_BIN:/usr/local/bin/opencode:ro" \
  -v "$REPO_ROOT/scripts:/host-scripts:ro" \
  -v "$REPO_ROOT/test:/host-test:ro" \
  -e WORK_PORT="$WORK_PORT" \
  -e DAEMON_PORT="$DAEMON_PORT" \
  -e FAKE_LLM_PORT="$FAKE_LLM_PORT" \
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
FAKE_LLM_PORT="${FAKE_LLM_PORT:-8400}"
BOT_LOGIN="${BOT_LOGIN:-e2e-bot}"
NPM_TAG="${NPM_TAG:-latest}"
DATA_DIR=/tmp/aio-browser

info "clean state"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

info "opencode binary on PATH"
opencode --version | head -1

info "install ework-aio@${NPM_TAG} + deps"
for pkg in ework-web ework-daemon opencode-ework; do
  npm install -g "$pkg@latest" 2>&1 | tail -2
done
npm install -g "ework-aio@${NPM_TAG}" 2>&1 | tail -2

info "install Playwright npm package (browser itself is pre-baked into image)"
# Install into a local node_modules so module resolution works regardless of
# whether we drive the test via `node` or `bun`. Global installs don't get
# picked up by Node's import resolver.
mkdir -p /tmp/test-runner
cd /tmp/test-runner
npm init -y >/dev/null
npm install playwright 2>&1 | tail -2

info "start fake LLM server in background"
PORT="$FAKE_LLM_PORT" bun run /host-scripts/fake-llm-server.ts 2>/tmp/fake-llm.log &
FAKE_LLM_PID=$!
# Wait for server to come up.
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$FAKE_LLM_PORT/v1/models" >/dev/null; then
    pass "fake LLM up (pid $FAKE_LLM_PID, port $FAKE_LLM_PORT)"
    break
  fi
  sleep 0.5
  [[ $i -eq 30 ]] && { tail /tmp/fake-llm.log; fail "fake LLM did not come up"; }
done

info "run ework-aio install (writes opencode.json with plugin only)"
ework-aio install \
  --allow-root \
  --data-dir "$DATA_DIR" \
  --port "$WORK_PORT" \
  --daemon-port "$DAEMON_PORT" \
  --bot-name e2e-bot \
  --yes 2>&1 | tee /tmp/install.log | tail -5

pass "install exited 0"

info "verify services respond"
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$WORK_PORT/login" >/dev/null && break
  sleep 0.5
  [[ $i -eq 60 ]] && fail "ework-web did not come up"
done
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$DAEMON_PORT/api/status" >/dev/null && break
  sleep 0.5
  [[ $i -eq 60 ]] && fail "daemon did not come up"
done
pass "both services responding"

info "configure opencode to use fake LLM"
# Overwrite ~/.config/opencode/opencode.json with fake provider + plugin.
# install.ts only registers opencode-ework; we add the fake provider here so
# the test stays isolated from any real API credentials.
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR"
cat > "$OPENCODE_CONFIG_DIR/opencode.json" <<OCJSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ework@latest"],
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake (E2E test)",
      "options": {
        "baseURL": "http://127.0.0.1:$FAKE_LLM_PORT/v1"
      },
      "models": {
        "fake-model": {
          "name": "Fake Model"
        }
      }
    }
  },
  "model": "fake/fake-model"
}
OCJSON
pass "opencode.json points at fake LLM"

info "warm up opencode (first-run DB migration takes minutes)"
# Opencode prints "Performing one time database migration, may take a few
# minutes..." on its first invocation against a fresh DB. If we don't warm
# it up here, both the smoke test AND the daemon's spawned opencode get
# killed mid-migration and never reach the chat step. Running any cheap
# command against the DB triggers the migration once; subsequent runs are
# fast. `session list` is the cheapest touch we can do.
# </dev/null: opencode session list reads stdin (cosmetic for list mode,
# but defensive — see smoke test comment for the heredoc-eof trap).
timeout -s KILL 300 opencode session list </dev/null >/dev/null 2>&1 || true
pass "opencode warm-up done (migration triggered if needed)"

info "verify opencode can reach fake LLM (manual smoke)"
# SIGKILL after 90s — opencode can hang on tool-call prompts if the LLM
# response shape is wrong; SIGTERM is caught for cleanup and takes longer.
# 90s because even post-migration, first stream response can take 10-20s.
#
# </dev/null is critical: this script's heredoc provides bash's stdin.
# opencode run reads stdin when waiting for prompts, which would silently
# consume the rest of the heredoc — bash then hits EOF and exits without
# running any subsequent step.
cd /tmp && timeout -s KILL 90 opencode run --format json --model fake/fake-model --dir /tmp "manual smoke test" </dev/null > /tmp/smoke.json 2>&1 || true
pass "opencode smoke test ran (output captured)"
echo "  events: $(wc -l < /tmp/smoke.json)"
echo "  --- smoke.json content (first 1000 chars) ---"
head -c 1000 /tmp/smoke.json
echo
echo "  --- fake-llm log tail ---"
tail -5 /tmp/fake-llm.log

info "create issue that triggers daemon → opencode → fake LLM"
# Build admin cookie (same recipe as e2e-install.sh).
WORK_TOKEN=$(grep ^WORK_TOKEN= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
WORK_COOKIE_SECRET=$(grep ^WORK_COOKIE_SECRET= "$DATA_DIR/ework-web/.env" | cut -d= -f2-)
COOKIE_SIG=$(printf '%s' "$WORK_TOKEN" \
  | openssl dgst -sha256 -hmac "$WORK_COOKIE_SECRET" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')
AUTH_COOKIE="ework_auth=${WORK_TOKEN}.${COOKIE_SIG}"

# Create project (idempotent — if it exists, 303 is still returned).
curl -sS -o /dev/null -w 'project: %{http_code}\n' -X POST \
  "http://127.0.0.1:$WORK_PORT/projects" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode 'owner=e2e' \
  --data-urlencode 'name=browser-test'

# Create issue (triggers webhook → daemon → opencode).
ISSUE_TITLE="Browser E2E $(date +%s)"
curl -sS -o /dev/null -w 'issue: %{http_code}\n' -X POST \
  "http://127.0.0.1:$WORK_PORT/e2e/browser-test/issues" \
  -H "Cookie: $AUTH_COOKIE" \
  --data-urlencode "title=$ISSUE_TITLE" \
  --data-urlencode 'body=please reply with anything'

info "wait for daemon to process the issue + spawn opencode"
# daemon polls every few seconds; opencode run takes a few seconds against
# fake LLM. Give it generous room.
for i in $(seq 1 60); do
  ACTIVE=$(curl -sS "http://127.0.0.1:$DAEMON_PORT/api/status" | jq -r '.issues // 0')
  if [[ "$ACTIVE" -ge 1 ]]; then
    pass "daemon registered issue after ${i} seconds (issues=$ACTIVE)"
    break
  fi
  sleep 1
  [[ $i -eq 60 ]] && fail "daemon did not register issue"
done

info "wait for opencode to write a session"
OPENCODE_DB="$HOME/.local/share/opencode/opencode.db"
# Query opencode.db via bun (bun:sqlite ships with the runtime, no extra
# dependency to apt install). One-line JS keeps the bash flow readable.
sql_query() {
  bun -e "const db=require('bun:sqlite');const d=new db.Database('$1',{readonly:true,create:false});try{process.stdout.write(JSON.stringify(d.prepare(\`$2\`).all()))}catch(e){process.stdout.write('')}" 2>/dev/null
}
# The smoke test in the previous step already wrote a session row. To avoid
# grabbing that one, capture its ID first and wait for a NEW session ID to
# appear (the daemon spawns its own opencode against a different --dir, so
# its session ID will differ).
PREV_SESSION_ID=$(sql_query "$OPENCODE_DB" "SELECT id FROM session ORDER BY time_updated DESC LIMIT 1;" \
  | jq -r '.[0].id // empty' 2>/dev/null || echo "")
echo "  smoke test session: ${PREV_SESSION_ID:-(none yet)}"
SESSION_ID=""
# 180s window: opencode spawn + fake-LLM roundtrip + write to DB. The
# daemon's poller picks up the issue within ~30s, then opencode takes
# 5-30s depending on warm-up state.
for i in $(seq 1 180); do
  ROWS=$(sql_query "$OPENCODE_DB" "SELECT id FROM session ORDER BY time_updated DESC LIMIT 1;")
  SESSION_ID=$(echo "$ROWS" | jq -r '.[0].id // empty' 2>/dev/null || echo "")
  if [[ -n "$SESSION_ID" && "$SESSION_ID" != "$PREV_SESSION_ID" ]]; then
    pass "session created: $SESSION_ID (after ${i}s)"
    break
  fi
  sleep 1
  [[ $i -eq 180 ]] && {
    echo "--- daemon.log (last 40) ---"
    tail -40 "$DATA_DIR/run/daemon.log" 2>/dev/null || echo "(no daemon.log)"
    echo "--- fake-llm log (last 10) ---"
    tail -10 /tmp/fake-llm.log
    fail "daemon's opencode did not write a new session (last seen: $SESSION_ID)";
  }
done

info "wait for session to have assistant content (fake LLM reply)"
for i in $(seq 1 30); do
  ROWS=$(sql_query "$OPENCODE_DB" "SELECT COUNT(*) AS n FROM message WHERE session_id='${SESSION_ID}';")
  MSG_COUNT=$(echo "$ROWS" | jq -r '.[0].n // 0' 2>/dev/null || echo 0)
  if [[ "$MSG_COUNT" -ge 2 ]]; then
    pass "session has $MSG_COUNT messages (user + assistant)"
    break
  fi
  sleep 1
  [[ $i -eq 30 ]] && fail "session never got assistant reply (msgs=$MSG_COUNT)";
done

info "verify session is browsable via awork-web"
# awork-web's OpencodeClient reads opencode.db and calls `opencode export`.
# Hit the /sessions list and the specific session page. Both require the
# admin auth cookie (otherwise 302 → /login).
SESSIONS_RESP=$(curl -sS -i -H "Cookie: $AUTH_COOKIE" "http://127.0.0.1:$WORK_PORT/sessions")
SESSIONS_HTML=$(echo "$SESSIONS_RESP" | tail -n +5)
SESSIONS_STATUS=$(echo "$SESSIONS_RESP" | head -1)
if ! echo "$SESSIONS_HTML" | grep -q "$SESSION_ID"; then
  echo "--- HTTP status: $SESSIONS_STATUS ---"
  echo "--- /sessions response (first 2000 chars of body) ---"
  echo "$SESSIONS_HTML" | head -c 2000
  echo
  echo "--- sessions actually in opencode.db ---"
  sql_query "$OPENCODE_DB" "SELECT id, time_created, time_archived FROM session ORDER BY time_created DESC LIMIT 5;" | jq . 2>/dev/null
  echo "--- ework-web access log (last 20) ---"
  tail -20 "$DATA_DIR/run/web-access.log" 2>/dev/null || echo "(no access log)"
  fail "/sessions list does not contain the new session ID"
fi
pass "/sessions lists the new session"

# Diagnostic: capture raw `opencode export <id>` stdout to see whether plugins
# emit banners into the JSON stream in this test environment. Production hit a
# bug where ework-web's JSON.parse choked on these preamble lines; if they
# appear here, the test must catch the failure rather than silently passing.
EXPORT_RAW=$(opencode export "$SESSION_ID" 2>/dev/null </dev/null || true)
EXPORT_LINE_COUNT=$(printf '%s\n' "$EXPORT_RAW" | wc -l)
JSON_START_LINE=$(printf '%s\n' "$EXPORT_RAW" | grep -nE '^\s*[{]' | head -1 | cut -d: -f1 || echo 0)
echo "  opencode export raw stdout: $EXPORT_LINE_COUNT lines, JSON object opens at line $JSON_START_LINE"
if [[ "$EXPORT_LINE_COUNT" -gt 1 && "$JSON_START_LINE" -gt 1 ]]; then
  echo "  --- first 5 lines (non-JSON preamble) ---"
  printf '%s\n' "$EXPORT_RAW" | head -5 | sed 's/^/    /'
  echo "  WARNING: stdout has non-JSON preamble — ework-web's old JSON.parse would fail here"
fi

SESSION_PAGE_HTML=$(curl -sS -H "Cookie: $AUTH_COOKIE" "http://127.0.0.1:$WORK_PORT/sessions/$SESSION_ID")
# Look for any marker that the fake LLM reply rendered. The reply body always
# starts with "E2E fake-LLM reply" so we grep for that substring.
echo "$SESSION_PAGE_HTML" | grep -q "E2E fake-LLM" \
  || fail "session page does not contain fake-LLM reply text"
pass "session page renders fake-LLM reply content"

info "check whether the bot actually replied on the issue (auto-reply)"
# ework-web exposes the issue comments via /api/v1/repos/<o>/<r>/issues/<n>/comments
# (Gitea-compatible). Two distinct kinds of bot-authored comments exist:
#   1. [system] "picked up this issue" — posted by the daemon on session start
#      (NOT an LLM reply; doesn't count).
#   2. [bot] actual reply — posted by the LLM via the opencode-ework `reply`
#      tool. This is the auto-reply behaviour we're validating.
COMMENTS_JSON=$(curl -sS -H "Cookie: $AUTH_COOKIE" \
  "http://127.0.0.1:$WORK_PORT/api/v1/repos/e2e/browser-test/issues/1/comments")
COMMENTS_COUNT=$(echo "$COMMENTS_JSON" | jq 'length' 2>/dev/null || echo 0)
BOT_COMMENTS_COUNT=$(echo "$COMMENTS_JSON" \
  | jq --arg bot "$BOT_LOGIN" '[.[] | select(.user.login == $bot)] | length' 2>/dev/null || echo 0)
LLM_REPLIES=$(echo "$COMMENTS_JSON" \
  | jq --arg bot "$BOT_LOGIN" \
       '[.[] | select(.user.login == $bot and (.body | startswith("[bot]")))] | length' 2>/dev/null || echo 0)
echo "  comments on issue #1: total=$COMMENTS_COUNT bot=$BOT_COMMENTS_COUNT llm-reply=$LLM_REPLIES"
echo "  --- all bot comment bodies (first 400 chars each) ---"
echo "$COMMENTS_JSON" | jq -r --arg bot "$BOT_LOGIN" \
  '.[] | select(.user.login == $bot) | "  • " + (.body | .[0:400])' 2>/dev/null
if [[ "$LLM_REPLIES" -ge 1 ]]; then
  pass "bot auto-replied on issue #1 ($LLM_REPLIES [bot]-prefixed LLM reply)"
else
  echo "  --- daemon.log (last 40) ---"
  tail -40 "$DATA_DIR/run/daemon.log" 2>/dev/null || echo "(no daemon.log)"
  echo "  --- fake-llm.log (last 20) ---"
  tail -20 /tmp/fake-llm.log 2>/dev/null
  fail "bot did NOT post an LLM-driven reply on issue #1 (got $BOT_COMMENTS_COUNT bot comments but 0 starting with [bot])"
fi

info "drive headless browser through the UI"
# bun (not tsx) because the script imports `bun:sqlite` to peek at opencode.db.
cp /host-test/browser-flow.ts /tmp/test-runner/
WORK_PORT="$WORK_PORT" \
WORK_DATA_DIR="$DATA_DIR" \
OPENCODE_DB="$OPENCODE_DB" \
HEADLESS=1 \
bun /tmp/test-runner/browser-flow.ts
pass "browser flow test PASSED"

info "fake LLM log tail"
tail -10 /tmp/fake-llm.log

echo
echo "====================================================="
echo "BROWSER E2E PASSED"
echo "====================================================="
echo "  session ID:       $SESSION_ID"
echo "  session URL:      http://127.0.0.1:$WORK_PORT/sessions/$SESSION_ID"
echo "  fake LLM log:     /tmp/fake-llm.log"
echo "  data dir:         $DATA_DIR"

# Kill fake LLM (container exit also does this, but explicit is clearer).
kill "$FAKE_LLM_PID" 2>/dev/null || true
EOSCRIPT

echo
echo "${c_grn}BROWSER E2E COMPLETE${c_rst}"
