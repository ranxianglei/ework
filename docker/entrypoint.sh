#!/usr/bin/env bash
# ework all-in-one entrypoint.
#
#   1. Generate the daemon's opencode config (provider + plugins) from env.
#   2. Background-start ework-web so its API is reachable for bootstrap.
#   3. First-boot bootstrap: create the ework-daemon bot user + PAT.
#   4. exec supervisord to run web + daemon + router.
#
# Required env (fail fast if missing):
#   WORK_TOKEN, WORK_COOKIE_SECRET  — ework auth
#   GITEA_WEBHOOK_SECRET            — daemon webhook signing
#
# Optional env (defaults shown):
#   WORK_OPERATOR_LOGIN=op
#   BOT_USERNAME=ework-daemon
#   WORK_LLM_BASE_URL               — OpenAI-compatible endpoint (e.g.
#                                      http://host.docker.internal:8199/v1).
#                                      With it, agents work out of the box;
#                                      without it, users configure their own
#                                      opencode auth (docker exec + opencode
#                                      auth login).
#   WORK_LLM_MODEL=main             — model name at that endpoint
#   WORK_LLM_API_KEY=dummy          — API key the endpoint expects
#   WORK_LLM_PROVIDER=ework         — provider id in opencode config; model
#                                      refs look like "ework/main"
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

NPM_ROOT="$(npm root -g)"
WORK_BIN="$NPM_ROOT/ework-web/bin/ework-web.js"
DAEMON_BIN="$NPM_ROOT/ework-daemon/bin/ework-daemon-server.js"
ROUTER_BIN="$NPM_ROOT/ework-router/bin/ework-router.js"
OPENCODE_BASE_WORKDIR="${OPENCODE_BASE_WORKDIR:-/data/opencode-workdir}"
export GITEA_URL="${GITEA_URL:-http://127.0.0.1:3002}"
export OPENCODE_BINARY="${OPENCODE_BINARY:-$(command -v opencode)}"
export HOME=/data

mkdir -p "$OPENCODE_BASE_WORKDIR"

# ── 1. opencode config for the daemon's spawned agents ────────────────────
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_CONFIG="$OPENCODE_CONFIG_DIR/opencode.json"
PLUGINS=("opencode-acp@latest" "omo-stable@latest")
# opencode-ework is baked into the image at a stable path; referencing the
# absolute path keeps it working offline. npm-named plugins self-install
# into the config dir on first load and are cached in /data thereafter.
if [[ -d "$NPM_ROOT/opencode-ework" ]]; then
    PLUGINS=("$NPM_ROOT/opencode-ework" "${PLUGINS[@]}")
else
    PLUGINS=("opencode-ework@latest" "${PLUGINS[@]}")
fi

json_array() {
    # bash args → JSON array of strings; deterministic without jq/python
    local out="[" first=1 item
    for item in "$@"; do
        [[ $first -eq 1 ]] || out+=","
        out+="\"$item\""
        first=0
    done
    printf '%s]' "$out"
}

if [[ -n "${WORK_LLM_BASE_URL:-}" ]]; then
    WORK_LLM_PROVIDER="${WORK_LLM_PROVIDER:-ework}"
    WORK_LLM_MODEL="${WORK_LLM_MODEL:-main}"
    WORK_LLM_API_KEY="${WORK_LLM_API_KEY:-dummy}"
    mkdir -p "$OPENCODE_CONFIG_DIR"
    # modalities.input gates the read tool's image support: without it the
    # runtime reports "no vision" even when the model has it.
    cat > "$OPENCODE_CONFIG" <<JSON
{
  "plugin": $(json_array "${PLUGINS[@]}"),
  "provider": {
    "$WORK_LLM_PROVIDER": {
      "npm": null,
      "name": "$WORK_LLM_PROVIDER",
      "api": "openai.compatible",
      "baseURL": "$WORK_LLM_BASE_URL",
      "apiKey": "$WORK_LLM_API_KEY",
      "models": {
        "$WORK_LLM_MODEL": {
          "name": "$WORK_LLM_MODEL",
          "attachment": false,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "reasoning": false,
          "temperature": false,
          "tool_call": true
        }
      }
    }
  },
  "model": "$WORK_LLM_PROVIDER/$WORK_LLM_MODEL",
  "small_model": "$WORK_LLM_PROVIDER/$WORK_LLM_MODEL"
}
JSON
    log "opencode config written (provider=$WORK_LLM_PROVIDER model=$WORK_LLM_MODEL)"
else
    log "WORK_LLM_BASE_URL not set — skipping opencode provider generation."
    log "Configure auth inside the container: docker exec -it ework opencode auth login"
    mkdir -p "$OPENCODE_CONFIG_DIR"
    if [[ ! -f "$OPENCODE_CONFIG" ]]; then
        printf '{"plugin": %s}\n' "$(json_array "${PLUGINS[@]}")" > "$OPENCODE_CONFIG"
    fi
fi

# ── 2. Required env ────────────────────────────────────────────────────────
: "${WORK_TOKEN:?WORK_TOKEN is required (>=8 chars)}"
: "${WORK_COOKIE_SECRET:?WORK_COOKIE_SECRET is required (>=8 chars)}"
: "${GITEA_WEBHOOK_SECRET:?GITEA_WEBHOOK_SECRET is required}"
export WORK_OPERATOR_LOGIN="${WORK_OPERATOR_LOGIN:-op}"
export BOT_USERNAME="${BOT_USERNAME:-ework-daemon}"

# ── 3. Background-start web for bootstrap ─────────────────────────────────
log "starting ework-web in background for bootstrap..."
WORK_PORT=3002 WORK_HOST=0.0.0.0 \
  WORK_DB_PATH=/data/ework.db WORK_ATTACHMENT_ROOT=/data/attachments \
  bun "$WORK_BIN" >/tmp/ework-bootstrap.log 2>&1 &
EWORK_BOOT_PID=$!

cleanup() {
  [[ -n "${EWORK_BOOT_PID:-}" ]] && kill "$EWORK_BOOT_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:3002/login"; then
    log "ework-web ready (after ${i} half-seconds)"
    break
  fi
  sleep 0.5
  [[ $i -eq 60 ]] && die "ework-web did not come up within 30s; check /tmp/ework-bootstrap.log"
done

# ── 4. Bootstrap daemon bot user + PAT (idempotent) ───────────────────────
# checkAuth accepts the legacy cookie "<token>.<sig>" where sig is
# HMAC-SHA256(cookieSecret, token) in base64url. Bearer WORK_TOKEN does NOT
# work on HTML routes (that path expects a DB-stored PAT).
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
  case "$CREATE_RESP" in
    303) log "bot user created" ;;
    400|409) log "bot user already exists (continuing)" ;;
    *) die "failed to create bot user: HTTP $CREATE_RESP" ;;
  esac

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
  BOT_TOKEN=$(printf '%s' "$PAT_RES" | grep -oE 'id="t">[a-f0-9]{40}<' | grep -oE '[a-f0-9]{40}' | head -1 || true)
  [[ -n "$BOT_TOKEN" ]] || die "could not extract PAT from response"
  umask 077
  printf '%s' "$BOT_TOKEN" > "$BOT_TOKEN_FILE"
  export BOT_TOKEN="$BOT_TOKEN"
  log "bot PAT minted and stored at $BOT_TOKEN_FILE"
fi

# ── 5. Hand over to supervisord ────────────────────────────────────────────
trap - EXIT
kill "$EWORK_BOOT_PID" 2>/dev/null || true
sleep 0.3
log "starting supervisord..."
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
