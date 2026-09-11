#!/usr/bin/env bash
# End-to-end webhook test for ework.
#
# Boots the test receiver on :8099, registers a webhook against the running
# ework instance (WORK_PORT, default 3002), then triggers real issue events
# (create issue, comment, close, reopen) and verifies the receiver captured
# each one with a valid Gitea-style signature.
#
# Prereqs:
#   - ework running on WORK_PORT (with WORK_TOKEN env known)
#   - bun on PATH
#
# Usage:
#   WORK_TOKEN=xxx ./scripts/webhook-test.sh
#
# Set CLEANUP=0 to keep the test project around for inspection.

set -euo pipefail

PORT="${WORK_PORT:-3002}"
TOKEN="${WORK_TOKEN:?WORK_TOKEN is required (set to your ework token)}"
RECEIVER_PORT="${RECEIVER_PORT:-8099}"
SECRET="${WEBHOOK_SECRET:-test-secret-e2e}"
RECEIVER_LOG="${RECEIVER_LOG:-./webhook-received.jsonl}"
PROJECT_OWNER="e2e"
PROJECT_REPO="wh-test-$(date +%s)"
BASE="http://127.0.0.1:${PORT}"

banner() { printf "\n=== %s ===\n" "$1"; }
info() { printf "  → %s\n" "$1"; }
pass() { printf "  ✅ %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; exit 1; }

# Locate bun on PATH (override with BUN=/path/to/bun if needed).
BUN_BIN="${BUN:-$(command -v bun || true)}"
[[ -n "$BUN_BIN" ]] || { echo "bun not found; set BUN=/path/to/bun or put it on PATH" >&2; exit 1; }
info "using bun: ${BUN_BIN}"

# Receiver must run in background; we manage its lifecycle.
RECEIVER_PID=""

cleanup() {
  if [[ -n "$RECEIVER_PID" ]] && kill -0 "$RECEIVER_PID" 2>/dev/null; then
    echo "→ stopping receiver (pid=$RECEIVER_PID)"
    kill "$RECEIVER_PID" 2>/dev/null || true
    wait "$RECEIVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

banner "1/7 — booting webhook receiver on :${RECEIVER_PORT}"
rm -f "$RECEIVER_LOG"
SECRET="$SECRET" LOG_FILE="$RECEIVER_LOG" PORT="$RECEIVER_PORT" \
  "$BUN_BIN" run "$(dirname "$0")/webhook-receiver.ts" >/tmp/ework-receiver.out 2>&1 &
RECEIVER_PID=$!
info "pid=$RECEIVER_PID"

# Wait for receiver to be ready
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${RECEIVER_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:${RECEIVER_PORT}/healthz" >/dev/null || fail "receiver didn't boot"
pass "receiver up"

banner "2/7 — login to ework"
COOKIE_JAR="$(mktemp)"
curl -fsS -c "$COOKIE_JAR" -X POST -d "token=${TOKEN}" "${BASE}/login" -o /dev/null
pass "logged in"

banner "3/7 — create test project ${PROJECT_OWNER}/${PROJECT_REPO}"
curl -fsS -b "$COOKIE_JAR" -X POST -d "owner=${PROJECT_OWNER}&name=${PROJECT_REPO}" \
  "${BASE}/projects" -o /dev/null
pass "project created"

banner "4/7 — register webhook at receiver"
curl -fsS -b "$COOKIE_JAR" -X POST \
  --data-urlencode "url=http://127.0.0.1:${RECEIVER_PORT}/hook" \
  --data-urlencode "secret=${SECRET}" \
  --data-urlencode "events=issues" \
  --data-urlencode "events=issue_comment" \
  "${BASE}/${PROJECT_OWNER}/${PROJECT_REPO}/settings/webhooks" -o /dev/null
pass "webhook registered"

PROJECT_PAGE="${BASE}/${PROJECT_OWNER}/${PROJECT_REPO}/issues"
info "project page: ${PROJECT_PAGE}"

banner "5/7 — trigger events (create issue, comment, close, reopen)"
# Create issue via the new-issue form
info "creating issue..."
ISSUE_RESP=$(curl -fsS -b "$COOKIE_JAR" -X POST \
  --data-urlencode "title=[E2E] webhook smoke $(date +%s)" \
  --data-urlencode "body=This is an automated e2e test for the webhook pipeline." \
  -o /dev/null -w '%{redirect_url}' \
  "${BASE}/${PROJECT_OWNER}/${PROJECT_REPO}/issues")
ISSUE_URL="${ISSUE_RESP}"
info "issue redirect: ${ISSUE_URL}"
[[ -n "$ISSUE_URL" ]] || fail "issue create did not redirect"
ISSUE_NUM="${ISSUE_URL##*/}"
pass "issue #${ISSUE_NUM} created"

info "posting comment..."
curl -fsS -b "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  --data '{"body":"test comment from e2e"}' \
  "${BASE}/api/${PROJECT_OWNER}/${PROJECT_REPO}/issues/${ISSUE_NUM}/comment" >/dev/null
pass "comment posted"

info "closing issue..."
curl -fsS -b "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  --data '{"close":true}' \
  "${BASE}/api/${PROJECT_OWNER}/${PROJECT_REPO}/issues/${ISSUE_NUM}/comment" >/dev/null
pass "closed"

info "reopening issue..."
curl -fsS -b "$COOKIE_JAR" -X POST \
  -H "Content-Type: application/json" \
  --data '{"reopen":true}' \
  "${BASE}/api/${PROJECT_OWNER}/${PROJECT_REPO}/issues/${ISSUE_NUM}/comment" >/dev/null
pass "reopened"

banner "6/7 — wait for deliveries to flush"
info "allowing 2s for async webhook fanout..."
sleep 2

banner "7/7 — verify receiver log"
[[ -s "$RECEIVER_LOG" ]] || fail "no deliveries received"
DELIVERY_COUNT=$(wc -l < "$RECEIVER_LOG")
info "received ${DELIVERY_COUNT} deliveries:"
cat "$RECEIVER_LOG" | "$BUN_BIN" -e '
  const lines = require("fs").readFileSync(0, "utf8").trim().split("\n");
  const events = { issues_opened: 0, issues_closed: 0, issues_reopened: 0, issue_comment: 0, other: 0 };
  let sigValid = 0, sigInvalid = 0;
  for (const l of lines) {
    try {
      const d = JSON.parse(l);
      if (d.sig_valid) sigValid++; else sigInvalid++;
      if (d.event === "issue_comment") events.issue_comment++;
      else if (d.event === "issues") {
        const a = d.body?.action ?? "?";
        if (a === "opened") events.issues_opened++;
        else if (a === "closed") events.issues_closed++;
        else if (a === "reopened") events.issues_reopened++;
        else events.other++;
      } else events.other++;
    } catch {}
  }
  console.log("  events:", JSON.stringify(events));
  console.log("  signatures valid:", sigValid, "invalid:", sigInvalid);
  if (sigInvalid > 0) process.exit(2);
  // Expect at least: 1 opened + 1 comment + 1 closed + 1 reopened
  const need = ["issues_opened","issues_closed","issues_reopened","issue_comment"];
  for (const k of need) if (events[k] === 0) { console.error("  MISSING:", k); process.exit(3); }
'

pass "all expected event types delivered"
pass "all signatures valid"

banner "PASS — webhook pipeline works end-to-end"
info "receiver log: ${RECEIVER_LOG}"
info "test project: ${BASE}/${PROJECT_OWNER}/${PROJECT_REPO}/issues"
echo
echo "Receiver stdout tail:"
tail -n 20 /tmp/ework-receiver.out || true
