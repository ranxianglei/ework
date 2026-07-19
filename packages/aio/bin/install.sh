#!/usr/bin/env bash
# ework-aio — host installer for the ework stack.
#
# Boots:
#   • ework-web       — multi-project issue tracker (web UI + Gitea-compat REST)
#   • ework-daemon    — issue-driven AI bridge (spawns opencode)
#   • opencode-ework  — plugin registered in ~/.config/opencode/opencode.json
#
# Idempotent. Re-runs preserve existing .env, bot token, and DB.
# Data lives under $DATA_DIR (default ~/.local/share/ework-aio).
# Services run as the current user via systemd --user (or --system if root).

set -euo pipefail

# ─── Pretty output ──────────────────────────────────────────────────────────
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_red=$'\033[31m';   c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_blu=$'\033[34m'
log()  { printf '%s•%s %s\n' "$c_blu" "$c_reset" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_ylw" "$c_reset" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }
hr()   { printf '%s──%s\n' "$c_dim" "$c_reset"; }

# ─── Defaults & arg parsing ─────────────────────────────────────────────────
MODE="install"
SCOPENAME="--user"
DATA_DIR=""
WORK_PORT="3002"
DAEMON_PORT="3101"
BOT_NAME="ework-daemon"
NO_START=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
ework-aio install [options]

Options:
  --user                         Use user-level systemd units (default if non-root)
  --system                       Use system-level systemd units (default if root)
  --data-dir <path>              Override data directory (default: ~/.local/share/ework-aio)
  --port <n>                     ework-web port (default: 3002)
  --daemon-port <n>              ework-daemon port (default: 3101)
  --bot-name <login>             Bot username (default: ework-daemon)
  --no-start                     Install units but don't start services
  --yes                          Skip all prompts (use generated defaults)
  --mode <install|uninstall|status|logs|env>   (internal; first positional arg wins)
  -h, --help                     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    install|uninstall|status|logs|env) MODE="$1"; shift ;;
    --user)   SCOPENAME="--user"; shift ;;
    --system) SCOPENAME="--system"; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port)   WORK_PORT="$2"; shift 2 ;;
    --daemon-port) DAEMON_PORT="$2"; shift 2 ;;
    --bot-name) BOT_NAME="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

# Resolve scope: default by uid
if [[ "$SCOPENAME" == "--user" && "${EUID:-$(id -u)}" == "0" ]]; then
  SCOPENAME="--system"
fi

# ─── Pre-flight: command dependencies ───────────────────────────────────────
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1. $2"
}
need_cmd bun        "Install from https://bun.sh"
need_cmd npm        "Install Node.js or Bun (ships npm)"
need_cmd opencode   "Install from https://opencode.ai"
need_cmd systemctl  "This installer requires systemd."
need_cmd openssl    "Install the openssl package."
need_cmd curl       "Install curl."
need_cmd jq         "Install jq (for opencode.json merge)."
need_cmd awk        "Should be present on any Linux."

# Verify the 3 npm packages are reachable. If not, try to install them now.
ensure_pkg() {
  local pkg="$1"
  if ! command -v "$pkg" >/dev/null 2>&1 \
     && ! [[ -d "$(npm root -g 2>/dev/null)/$pkg" ]]; then
    log "npm package '$pkg' not detected; installing globally now..."
    npm install -g "$pkg" || die "npm install -g $pkg failed"
  fi
}
case "$MODE" in
  install)
    log "Ensuring npm packages are installed..."
    ensure_pkg "ework-web"
    ensure_pkg "ework-daemon"
    # opencode-ework is a library, not a bin; check node_modules
    if ! [[ -d "$(npm root -g)/opencode-ework" ]] \
       && ! [[ -d "$(npm root -g)/ework-aio/node_modules/opencode-ework" ]]; then
      npm install -g opencode-ework || die "npm install -g opencode-ework failed"
    fi
    ok "npm packages ready"

    # Absolute paths to the bin shims (resolved once, baked into systemd units)
    EWORK_WEB_BIN="$(command -v ework-web 2>/dev/null || true)"
    EWORK_DAEMON_BIN="$(command -v ework-daemon-server 2>/dev/null || true)"
    [[ -n "$EWORK_WEB_BIN" ]]   || EWORK_WEB_BIN="$(npm root -g)/ework-web/bin/ework-web.js"
    [[ -n "$EWORK_DAEMON_BIN" ]] || EWORK_DAEMON_BIN="$(npm root -g)/ework-daemon/bin/ework-daemon-server.js"
    [[ -x "$EWORK_WEB_BIN" || -f "$EWORK_WEB_BIN" ]]   || die "ework-web bin not found at $EWORK_WEB_BIN"
    [[ -x "$EWORK_DAEMON_BIN" || -f "$EWORK_DAEMON_BIN" ]] || die "ework-daemon-server bin not found at $EWORK_DAEMON_BIN"
    export EWORK_WEB_BIN EWORK_DAEMON_BIN
    ;;
esac

# ─── Paths ──────────────────────────────────────────────────────────────────
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_DIR="${DATA_DIR:-$XDG_DATA_HOME/ework-aio}"
WEB_DATA_DIR="$DATA_DIR/ework-web"
DAEMON_DATA_DIR="$DATA_DIR/ework-daemon"
WEB_ENV="$WEB_DATA_DIR/.env"
DAEMON_ENV="$DAEMON_DATA_DIR/.env"
BOT_TOKEN_FILE="$DATA_DIR/.bot-token"
OPENCODE_CFG="$XDG_CONFIG_HOME/opencode/opencode.json"

# systemd unit dir
if [[ "$SCOPENAME" == "--user" ]]; then
  UNIT_DIR="$XDG_CONFIG_HOME/systemd/user"
else
  UNIT_DIR="/etc/systemd/system"
fi
mkdir -p "$UNIT_DIR"

# ─── Helpers ────────────────────────────────────────────────────────────────
gen_token() { openssl rand -hex "${1:-24}"; }

write_web_env() {
  mkdir -p "$(dirname "$WEB_ENV")"
  if [[ -f "$WEB_ENV" ]]; then
    log "Preserving existing $WEB_ENV"
    return
  fi
  local tok secret webhook
  tok=$(gen_token 20)
  secret=$(gen_token 24)
  webhook=$(gen_token 20)
  cat > "$WEB_ENV" <<EOF
# Generated by ework-aio at $(date -u +%Y-%m-%dT%H:%M:%SZ)
WORK_PORT=$WORK_PORT
WORK_HOST=127.0.0.1
WORK_TOKEN=$tok
WORK_COOKIE_SECRET=$secret
WORK_OPERATOR_LOGIN=$USER
WORK_WRITES_ENABLED=true
WORK_DB_PATH=$WEB_DATA_DIR/ework.db
WORK_ATTACHMENT_ROOT=$WEB_DATA_DIR/attachments
WORK_FILE_ROOTS=/tmp,$DATA_DIR
WORK_DAEMON_BOT_LOGIN=$BOT_NAME
WORK_DAEMON_WEBHOOK_URL=http://127.0.0.1:$DAEMON_PORT
WORK_DAEMON_WEBHOOK_SECRET=$webhook
EOF
  chmod 600 "$WEB_ENV"
  ok "Wrote $WEB_ENV"
}

write_daemon_env() {
  mkdir -p "$(dirname "$DAEMON_ENV")"
  local bot_token="$1"
  local webhook
  # Reuse webhook secret from web env so daemon's signature matches web's verify
  webhook=$(awk -F= '/^WORK_DAEMON_WEBHOOK_SECRET=/{print $2}' "$WEB_ENV" 2>/dev/null || true)
  [[ -n "$webhook" ]] || webhook=$(gen_token 20)
  cat > "$DAEMON_ENV" <<EOF
# Generated by ework-aio at $(date -u +%Y-%m-%dT%H:%M:%SZ)
DAEMON_ENV=production
DAEMON_PORT=$DAEMON_PORT
DAEMON_HOST=127.0.0.1
DAEMON_DB_PATH=$DAEMON_DATA_DIR/ework-daemon.db
GITEA_URL=http://127.0.0.1:$WORK_PORT
GITEA_TOKEN=$bot_token
GITEA_WEBHOOK_SECRET=$webhook
BOT_USERNAME=$BOT_NAME
BOT_TOKEN=$bot_token
OPENCODE_BINARY=$(command -v opencode)
OPENCODE_BASE_WORKDIR=$DATA_DIR/opencode-workdir
EOF
  chmod 600 "$DAEMON_ENV"
  ok "Wrote $DAEMON_ENV"
}

write_unit_file() {
  # $1=name $2=description $3=execstart $4=workdir $5=envfile $6=unit-file-path
  local name="$1" desc="$2" execstart="$3" workdir="$4" envfile="$5" out="$6"
  local extra_env="${7:-}"
  cat > "$out" <<EOF
[Unit]
Description=$desc
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$workdir
ExecStart=$execstart
Restart=on-failure
RestartSec=5
KillMode=process
EnvironmentFile=$envfile
Environment="PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.bun/bin"
Environment="XDG_DATA_HOME=$XDG_DATA_HOME"
Environment="XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
Environment="HOME=$HOME"$extra_env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$name

[Install]
${SCOPENAME:+WantedBy=default.target}
EOF
  # If system-level, WantedBy is multi-user.target
  if [[ "$SCOPENAME" == "--system" ]]; then
    sed -i 's/^WantedBy=default.target/WantedBy=multi-user.target/' "$out"
  fi
}

ctl() { systemctl "$SCOPENAME" "$@"; }

# ─── Modes ──────────────────────────────────────────────────────────────────
case "$MODE" in
env)
  hr; log "ework-aio paths"; hr
  printf '  data dir      : %s\n' "$DATA_DIR"
  printf '  web env       : %s\n' "$WEB_ENV"
  printf '  daemon env    : %s\n' "$DAEMON_ENV"
  printf '  bot token     : %s\n' "$BOT_TOKEN_FILE"
  printf '  opencode cfg  : %s\n' "$OPENCODE_CFG"
  printf '  systemd scope : %s\n' "$SCOPENAME"
  printf '  unit dir      : %s\n' "$UNIT_DIR"
  exit 0
  ;;

status)
  hr; log "ework-aio status ($SCOPENAME)"; hr
  ctl is-active ework-web.service    || true
  ctl is-active ework-daemon.service || true
  ctl status --no-pager --lines=0 ework-web.service    2>/dev/null || true
  hr
  ctl status --no-pager --lines=0 ework-daemon.service 2>/dev/null || true
  exit 0
  ;;

logs)
  svc="${1:-ework-web.service}"
  [[ "$svc" == "daemon" || "$svc" == "ework-daemon" ]] && svc="ework-daemon.service"
  [[ "$svc" == "web"     || "$svc" == "ework-web" ]]    && svc="ework-web.service"
  exec journalctl "$SCOPENAME" -u "$svc" -f
  ;;

uninstall)
  hr; log "Uninstalling ework-aio services (keeping data)"; hr
  ctl stop    ework-web.service ework-daemon.service 2>/dev/null || true
  ctl disable ework-web.service ework-daemon.service 2>/dev/null || true
  rm -f "$UNIT_DIR/ework-web.service" "$UNIT_DIR/ework-daemon.service"
  ctl daemon-reload
  ok "Services removed. Data preserved at $DATA_DIR"
  warn "To fully remove: rm -rf $DATA_DIR && npm uninstall -g ework-aio ework-web ework-daemon opencode-ework"
  exit 0
  ;;
esac

# ─── Install mode ───────────────────────────────────────────────────────────
hr
log "ework-aio install"
log "  scope      : $SCOPENAME"
log "  data dir   : $DATA_DIR"
log "  web bin    : $EWORK_WEB_BIN"
log "  daemon bin : $EWORK_DAEMON_BIN"
log "  opencode   : $(command -v opencode) ($($(command -v opencode) --version 2>&1 | head -1))"
hr

if [[ "$SCOPENAME" == "--user" ]] && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  warn "User-level systemd requires lingering to keep services alive after logout."
  if [[ "$ASSUME_YES" == "1" ]]; then
    warn "Run this manually: sudo loginctl enable-linger $USER"
  else
    read -rp "Enable linger now? (needs sudo) [Y/n] " ans
    if [[ "${ans:-Y}" =~ ^[Yy]?$ ]]; then
      sudo loginctl enable-linger "$USER" || warn "enable-linger failed; services will stop on logout"
    fi
  fi
fi

mkdir -p "$WEB_DATA_DIR" "$DAEMON_DATA_DIR" "$DATA_DIR/opencode-workdir"

write_web_env

# ─── Write ework-web systemd unit ──────────────────────────────────────────
WEB_UNIT="$UNIT_DIR/ework-web.service"
write_unit_file \
  "ework-web" \
  "ework — multi-project issue tracker" \
  "$EWORK_WEB_BIN" \
  "$WEB_DATA_DIR" \
  "$WEB_ENV" \
  "$WEB_UNIT"
ok "Wrote $WEB_UNIT"

# ─── Reload + start ework-web ──────────────────────────────────────────────
ctl daemon-reload
if [[ "$NO_START" == "0" ]]; then
  log "Starting ework-web..."
  ctl enable ework-web.service
  ctl restart ework-web.service
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
      ok "ework-web listening on :$WORK_PORT (after ${i} half-seconds)"
      break
    fi
    sleep 0.5
    [[ $i -eq 60 ]] && die "ework-web did not come up in 30s. Check: journalctl $SCOPENAME -u ework-web.service -n 50"
  done
else
  warn "--no-start: unit enabled but not started"
  ctl enable ework-web.service
fi

# ─── Bootstrap bot user + PAT (idempotent) ─────────────────────────────────
WORK_TOKEN_VAL=$(awk -F= '/^WORK_TOKEN=/{print $2}' "$WEB_ENV")
WORK_COOKIE_SECRET_VAL=$(awk -F= '/^WORK_COOKIE_SECRET=/{print $2}' "$WEB_ENV")
# ework-web's checkAuth accepts legacy "<token>.<hmac>" cookie form
COOKIE_SIG=$(printf '%s' "$WORK_TOKEN_VAL" \
  | openssl dgst -sha256 -hmac "$WORK_COOKIE_SECRET_VAL" -binary \
  | base64 | tr '+/' '-_' | tr -d '=')
AUTH_COOKIE="ework_auth=${WORK_TOKEN_VAL}.${COOKIE_SIG}"

BOT_TOKEN=""
if [[ -f "$BOT_TOKEN_FILE" ]]; then
  BOT_TOKEN=$(cat "$BOT_TOKEN_FILE")
  ok "Reusing saved bot token from $BOT_TOKEN_FILE"
else
  log "Bootstrapping bot user '$BOT_NAME'..."
  BOT_PW=$(openssl rand -hex 24)
  CREATE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:$WORK_PORT/admin/users/create" \
    -H "Cookie: $AUTH_COOKIE" \
    --data-urlencode "login=$BOT_NAME" \
    --data-urlencode "password=$BOT_PW" \
    --data-urlencode "kind=bot" \
    --data-urlencode "is_admin=0") || CREATE_CODE=000
  case "$CREATE_CODE" in
    303) ok "Bot user '$BOT_NAME' created" ;;
    400|409) warn "Bot user '$BOT_NAME' already exists (continuing)" ;;
    *) die "Failed to create bot user: HTTP $CREATE_CODE" ;;
  esac

  log "Logging in as bot to mint PAT..."
  COOKIE_JAR=$(mktemp)
  LOGIN_CODE=$(curl -sS -c "$COOKIE_JAR" -X POST "http://127.0.0.1:$WORK_PORT/login" \
    --data-urlencode "login=$BOT_NAME" \
    --data-urlencode "password=$BOT_PW" \
    -o /dev/null -w '%{http_code}') || LOGIN_CODE=000
  BOT_COOKIE=$(awk '/ework_auth/ {print $7}' "$COOKIE_JAR")
  rm -f "$COOKIE_JAR"
  [[ "$LOGIN_CODE" == "302" && -n "$BOT_COOKIE" ]] \
    || die "Bot login failed: HTTP $LOGIN_CODE"

  log "Minting PAT..."
  PAT_RES=$(curl -sS -X POST "http://127.0.0.1:$WORK_PORT/me/tokens/create" \
    -H "Cookie: ework_auth=$BOT_COOKIE" \
    --data-urlencode "name=aio-$(date +%s)")
  BOT_TOKEN=$(printf '%s' "$PAT_RES" | grep -oE 'id="t">[a-f0-9]{40}<' | grep -oE '[a-f0-9]{40}' | head -1 || true)
  [[ -n "$BOT_TOKEN" ]] || die "Could not extract PAT from token-create response"
  printf '%s' "$BOT_TOKEN" > "$BOT_TOKEN_FILE"
  chmod 600 "$BOT_TOKEN_FILE"
  ok "Bot PAT saved to $BOT_TOKEN_FILE"
fi

# ─── Write ework-daemon .env ───────────────────────────────────────────────
write_daemon_env "$BOT_TOKEN"

# ─── Write ework-daemon systemd unit ───────────────────────────────────────
DAEMON_UNIT="$UNIT_DIR/ework-daemon.service"
write_unit_file \
  "ework-daemon" \
  "ework-daemon — issue-driven AI dev daemon" \
  "$EWORK_DAEMON_BIN" \
  "$DAEMON_DATA_DIR" \
  "$DAEMON_ENV" \
  "$DAEMON_UNIT" \
  " \"\""
# (trailing " \"\"" is a no-op separator; kept for future extra env injection)
ok "Wrote $DAEMON_UNIT"

ctl daemon-reload
if [[ "$NO_START" == "0" ]]; then
  log "Starting ework-daemon..."
  ctl enable ework-daemon.service
  ctl restart ework-daemon.service
  sleep 1
  if ctl is-active --quiet ework-daemon.service; then
    ok "ework-daemon active"
  else
    warn "ework-daemon did not report active; check: journalctl $SCOPENAME -u ework-daemon.service -n 50"
  fi
else
  ctl enable ework-daemon.service
fi

# ─── Register opencode-ework plugin ────────────────────────────────────────
mkdir -p "$(dirname "$OPENCODE_CFG")"
if [[ ! -f "$OPENCODE_CFG" ]]; then
  log "Writing $OPENCODE_CFG (registering opencode-ework plugin)"
  cat > "$OPENCODE_CFG" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ework"]
}
EOF
elif grep -q '"opencode-ework"' "$OPENCODE_CFG"; then
  ok "opencode-ework already in $OPENCODE_CFG"
else
  log "Merging opencode-ework into existing $OPENCODE_CFG"
  cp "$OPENCODE_CFG" "$OPENCODE_CFG.bak.$(date +%s)"
  # Use jq to append to plugin array (creates array if missing)
  tmp=$(mktemp)
  jq 'if .plugin then .plugin += ["opencode-ework"] else . + {plugin:["opencode-ework"]} end' \
     "$OPENCODE_CFG" > "$tmp" && mv "$tmp" "$OPENCODE_CFG"
  ok "Plugin registered (backup at $OPENCODE_CFG.bak.*)"
fi

# ─── Done ──────────────────────────────────────────────────────────────────
hr
ok "Install complete."
hr
printf '\n%s→%s Open %shttp://127.0.0.1:%s/login%s\n' \
  "$c_bold" "$c_reset" "$c_dim" "$WORK_PORT" "$c_reset"
printf '  Login token: %s%s%s\n' "$c_bold" "$WORK_TOKEN_VAL" "$c_reset"
printf '  Logs:        ework-aio logs web | ework-aio logs daemon\n'
printf '  Status:      ework-aio status\n'
printf '  Uninstall:   ework-aio uninstall\n'
hr
