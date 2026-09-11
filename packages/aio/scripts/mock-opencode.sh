#!/usr/bin/env bash
# mock-opencode: Drop-in replacement for `opencode run` in E2E tests.
#
# The daemon spawns: opencode run --format json --dir <workdir> [--session <id>] [--model <m>] "<prompt>"
# This mock:
#   1. Emits {"sessionID":"ses_mock_<ts>_<pid>"} to stdout (what the daemon parses)
#   2. Parses the prompt to extract issue ref (owner/repo#number)
#   3. Posts a [bot] reply via the Gitea API so finishRun sees a recent bot reply (no nudging)
#   4. Exits 0
#
# Env vars used: GITEA_URL, BOT_TOKEN (both set by the daemon's child env)
set -euo pipefail

PROMPT=""
WORKDIR=""
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    run) shift ;;
    --format) shift ;;
    json) shift ;;
    --dir) WORKDIR="$2"; shift 2 ;;
    --session) SESSION_ID="$2"; shift 2 ;;
    --model) shift 2 ;;
    *) PROMPT="$1"; shift ;;
  esac
done

# Emit session ID JSON (daemon reads this from stdout)
SID="ses_mock_$(date +%s)_$$"
echo "{\"sessionID\":\"$SID\"}"

# Try to extract issue ref from the prompt text
# Format 1 (initial):   - Issue: "title" (gitea:owner/repo#number)
# Format 2 (forward):    posted a new comment on owner/repo#number
ISSUE_REF=""
if echo "$PROMPT" | grep -qoP 'Issue:.*?\([\w:]+([\w.-]+/[\w.-]+#\d+)\)' 2>/dev/null; then
  ISSUE_REF=$(echo "$PROMPT" | grep -oP 'Issue:.*?\([\w:]+([\w.-]+/[\w.-]+#\d+)\)' | grep -oP '[\w.-]+/[\w.-]+#\d+' | head -1)
elif echo "$PROMPT" | grep -qoP 'comment on ([\w.-]+/[\w.-]+#\d+)' 2>/dev/null; then
  ISSUE_REF=$(echo "$PROMPT" | grep -oP 'comment on ([\w.-]+/[\w.-]+#\d+)' | grep -oP '[\w.-]+/[\w.-]+#\d+' | head -1)
fi

if [[ -z "$ISSUE_REF" || -z "${GITEA_URL:-}" || -z "${BOT_TOKEN:-}" ]]; then
  # Can't post a reply — daemon will nudge, but that's fine for routing tests
  sleep 0.5
  exit 0
fi

OWNER=$(echo "$ISSUE_REF" | cut -d'#' -f1 | cut -d'/' -f1)
REPO=$(echo "$ISSUE_REF" | cut -d'#' -f1 | cut -d'/' -f2-)
NUMBER=$(echo "$ISSUE_REF" | cut -d'#' -f2)

# Simulate work (1s) then post [bot] reply
sleep 1

curl -sf -X POST \
  -H "Authorization: token $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"body\":\"[bot] Mock processed ($OWNER/$REPO#$NUMBER) on $(hostname)\"}" \
  "${GITEA_URL}/api/v1/repos/${OWNER}/${REPO}/issues/${NUMBER}/comments" \
  > /dev/null 2>&1 || true

exit 0
