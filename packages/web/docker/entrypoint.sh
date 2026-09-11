#!/usr/bin/env bash
# ework all-in-one entrypoint.
#
# Responsibilities:
#   1. Symlink /data state into expected locations.
#   2. First-boot bootstrap: create the ework-daemon bot user + PAT (so the
#      daemon can authenticate to ework's Gitea-compat API using BOT_TOKEN).
#   3. exec supervisord to run ework + ework-daemon.
#
# Required env (fail fast if missing):
#   WORK_TOKEN, WORK_COOKIE_SECRET  — ework auth
#   GITEA_WEBHOOK_SECRET             — daemon webhook signing
#   OPENCODE_BASE_WORKDIR            — where opencode clones/checks out repos
#
# Optional env (defaults shown):
#   WORK_OPERATOR_LOGIN=op
#   BOT_USERNAME=ework-daemon
#   OPENCODE_BINARY=/usr/local/bin/opencode
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# ── 1. Required env ────────────────────────────────────────────────────────
: "${WORK_TOKEN:?WORK_TOKEN is required (>=8 chars)}"
: "${WORK_COOKIE_SECRET:?WORK_COOKIE_SECRET is required (>=8 chars)}"
: "${GITEA_WEBHOOK_SECRET:?GITEA_WEBHOOK_SECRET is required}"

export WORK_OPERATOR_LOGIN="${WORK_OPERATOR_LOGIN:-op}"
export BOT_USERNAME="${BOT_USERNAME:-ework-daemon}"
export OPENCODE_BINARY="${OPENCODE_BINARY:-/usr/local/bin/opencode}"
export OPENCODE_BASE_WORKDIR="${OPENCODE_BASE_WORKDIR:-/data/opencode-workdir}"
export GITEA_URL="${GITEA_URL:-http://127.0.0.1:3002}"
# GITEA_TOKEN default is set after BOT_TOKEN bootstrap below — daemon reads
# must auth as the bot user. Defaulting to WORK_TOKEN here silently breaks
# listComments (cookie-only token via Authorization → 302 → JSON parse fail).

mkdir -p "$OPENCODE_BASE_WORKDIR"

# ── 1b. Soft-warn on missing LLM credentials ───────────────────────────────
# opencode needs either an API key in env or a pre-existing auth.json.
# Without either, every spawned run will fail at first LLM call.
LLM_ENV_FOUND=0
for var in OPENCODE_AI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY; do
  if [[ -n "${!var:-}" ]]; then LLM_ENV_FOUND=1; break; fi
done
OPENCODE_AUTH="/root/.config/opencode/auth.json"
if [[ $LLM_ENV_FOUND -eq 0 && ! -f "$OPENCODE_AUTH" ]]; then
  log "WARNING: no LLM credentials detected (env API key or $OPENCODE_AUTH)."
  log "         opencode spawns will fail until you 'opencode auth login' inside"
  log "         the container, or pass OPENCODE_AI_API_KEY=... at docker run."
fi

# ── 2. Background-start ework so we can hit its API for bootstrap ──────────
# Supervisord will manage ework as a child; but for first-boot user/PAT
# bootstrap we need ework already listening. Start a temporary instance.
log "starting ework in background for bootstrap..."
cd /app/ework
WORK_PORT=3002 WORK_HOST=0.0.0.0 \
  WORK_DB_PATH=/data/ework.db WORK_ATTACHMENT_ROOT=/data/attachments \
  bun run src/index.ts >/tmp/ework-bootstrap.log 2>&1 &
EWORK_BOOT_PID=$!

cleanup() {
  [[ -n "${EWORK_BOOT_PID:-}" ]] && kill "$EWORK_BOOT_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for ework to come up (max ~30s)
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:3002/login"; then
    log "ework ready (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && die "ework did not come up within 30s; check /tmp/ework-bootstrap.log"
done

# ── 3. Bootstrap daemon bot user + PAT (idempotent) ───────────────────────
# Auth: WORK_TOKEN is cfg.authToken (legacy shared-token form). checkAuth in
# src/auth.ts accepts the legacy cookie "<token>.<sig>" where sig is
# HMAC-SHA256(cookieSecret, token) in base64url. Bearer WORK_TOKEN does NOT
# work (Bearer path expects a DB-stored PAT). Build the cookie with openssl.
WORK_TOKEN_SIG=$(printf '%s' "$WORK_TOKEN" \
  | openssl dgst -sha256 -hmac "$WORK_COOKIE_SECRET" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')
AUTH_COOKIE="ework_auth=${WORK_TOKEN}.${WORK_TOKEN_SIG}"

BOT_TOKEN_FILE=/data/.bot-token
if [[ -f "$BOT_TOKEN_FILE" ]]; then
  log "reusing existing bot token from $BOT_TOKEN_FILE"
  export BOT_TOKEN="$(cat "$BOT_TOKEN_FILE")"
else
  log "bootstrapping bot user '$BOT_USERNAME'..."
  BOT_PW="$(openssl rand -hex 24)"
  CREATE_RESP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:3002/admin/users/create" \
    -H "Cookie: $AUTH_COOKIE" \
    --data-urlencode "login=$BOT_USERNAME" \
    --data-urlencode "password=$BOT_PW" \
    --data-urlencode "kind=bot" \
    --data-urlencode "is_admin=0") || CREATE_RESP=000
  # 303 = created (redirect to /admin/users?ok=1). 400 = already exists.
  case "$CREATE_RESP" in
    303) log "bot user created" ;;
    400|409) log "bot user already exists (continuing)" ;;
    *) die "failed to create bot user: HTTP $CREATE_RESP" ;;
  esac

  # Login as bot to issue a PAT via /me/tokens/create. /login returns 302 on
  # success (set-cookie) or 401 on failure. Cookie jar saved to temp file
  # because mixing -c - with -w on stdout would taint the parsed value.
  log "logging in as bot to mint PAT..."
  COOKIE_JAR=$(mktemp)
  LOGIN_CODE=$(curl -sS -c "$COOKIE_JAR" -X POST "http://127.0.0.1:3002/login" \
    --data-urlencode "login=$BOT_USERNAME" \
    --data-urlencode "password=$BOT_PW" \
    -o /dev/null -w '%{http_code}') || LOGIN_CODE=000
  BOT_COOKIE=$(awk '/ework_auth/ {print $7}' "$COOKIE_JAR")
  rm -f "$COOKIE_JAR"
  [[ "$LOGIN_CODE" == "302" && -n "$BOT_COOKIE" ]] || die "bot login failed: HTTP $LOGIN_CODE"

  log "minting PAT..."
  PAT_RES=$(curl -sS -X POST "http://127.0.0.1:3002/me/tokens/create" \
    -H "Cookie: ework_auth=$BOT_COOKIE" \
    --data-urlencode "name=docker-runtime")
  # buildTokenCreatedPage puts the plaintext inside <code id="t">…</code>.
  # PAT is randomHex(20) → 40 lowercase hex chars, no prefix.
  BOT_TOKEN=$(printf '%s' "$PAT_RES" | grep -oE 'id="t">[a-f0-9]{40}<' | grep -oE '[a-f0-9]{40}' | head -1 || true)
  [[ -n "$BOT_TOKEN" ]] || die "could not extract PAT from response"

  printf '%s' "$BOT_TOKEN" > "$BOT_TOKEN_FILE"
  chmod 600 "$BOT_TOKEN_FILE"
  export BOT_TOKEN
  log "bot token saved to $BOT_TOKEN_FILE"
fi

export GITEA_TOKEN="${GITEA_TOKEN:-$BOT_TOKEN}"

# ── 4. Stop bootstrap ework; supervisord will own the real one ─────────────
log "stopping bootstrap ework (pid=$EWORK_BOOT_PID); supervisor takes over"
kill "$EWORK_BOOT_PID" 2>/dev/null || true
wait "$EWORK_BOOT_PID" 2>/dev/null || true
EWORK_BOOT_PID=""

# ── 4b. Register opencode-ework plugin in global opencode.json (idempotent) ─
# The image bakes the plugin source at /opt/opencode-ework (see Dockerfile §4b).
# opencode 1.14 auto-loads `~/.config/opencode/opencode.json` and resolves the
# `/opt/opencode-ework` path-plugin via its package.json main field. Without
# this file the daemon's spawned `opencode run` won't see the issue/reply
# tools. Idempotent: skip if file exists without our entry (assume user
# customised); skip if our entry already present.
OPENCODE_CFG="/root/.config/opencode/opencode.json"
mkdir -p "$(dirname "$OPENCODE_CFG")"
if [[ ! -f "$OPENCODE_CFG" ]]; then
  log "writing $OPENCODE_CFG (registering /opt/opencode-ework plugin)"
  cat > "$OPENCODE_CFG" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/opt/opencode-ework"]
}
EOF
elif grep -q '/opt/opencode-ework' "$OPENCODE_CFG"; then
  log "opencode-ework plugin already registered in $OPENCODE_CFG"
else
  log "WARNING: $OPENCODE_CFG exists without /opt/opencode-ework — please merge manually"
fi

# Export for supervisord's environment expansion
export WORK_TOKEN WORK_COOKIE_SECRET WORK_OPERATOR_LOGIN GITEA_WEBHOOK_SECRET
export BOT_USERNAME BOT_TOKEN GITEA_URL GITEA_TOKEN OPENCODE_BINARY OPENCODE_BASE_WORKDIR

log "handing off to supervisord: $*"
exec "$@"
