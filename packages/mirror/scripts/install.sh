#!/usr/bin/env bash
set -euo pipefail

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_red=$'\033[31m';   c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_blu=$'\033[34m'
log()  { printf '%s•%s %s\n' "$c_blu" "$c_reset" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_ylw" "$c_reset" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }
hr()   { printf '%s──%s\n' "$c_dim" "$c_reset"; }

MODE="install"
SCOPENAME="--user"
DATA_DIR=""
PORT="1197"
HOST="127.0.0.1"
GITEA_URL=""
GITEA_TOKEN=""
NO_START=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
ework-mirror <command> [options]

Commands:
  install [options]   Install or upgrade (default)
  uninstall           Stop service and remove unit (data preserved)
  status              Show service status
  logs                Tail logs

Install options:
  --user | --system   systemd scope (default: --user, or --system if root)
  --data-dir <path>   Override data dir (default: ~/.local/share/ework-mirror)
  --port <n>          Listen port (default: 1197)
  --host <s>          Bind address (default: 127.0.0.1)
  --gitea-url <url>   Target Gitea base URL (required on first install)
  --gitea-token <s>   Gitea API token (required on first install; user 'awork')
  --no-start          Install unit but don't start service
  --yes               Skip prompts (use provided defaults)
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    install|uninstall|status|logs) MODE="$1"; shift ;;
    --user)   SCOPENAME="--user"; shift ;;
    --system) SCOPENAME="--system"; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    --host)   HOST="$2"; shift 2 ;;
    --gitea-url)  GITEA_URL="$2"; shift 2 ;;
    --gitea-token) GITEA_TOKEN="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

if [[ "$SCOPENAME" == "--user" && "${EUID:-$(id -u)}" == "0" ]]; then
  SCOPENAME="--system"
fi

# Mirrors ework-aio/bin/install.sh:ensure_user_session — keep in sync.
ensure_user_session() {
  [[ "$SCOPENAME" == "--user" ]] || return 0
  local uid; uid="$(id -u)"
  local rundir="/run/user/$uid"
  if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "$rundir" ]]; then
    export XDG_RUNTIME_DIR="$rundir"
  fi
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
  if ! systemctl --user is-system-running >/dev/null 2>&1 \
     && ! systemctl --user list-units >/dev/null 2>&1; then
    warn "systemctl --user cannot reach the user session bus."
    warn "  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<empty>}"
    warn "  DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-<empty>}"
    warn "Fix: 'sudo loginctl enable-linger $USER' then relogin; or reinstall with --system."
    return 1
  fi
  return 0
}
ensure_user_session || true

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1. $2"
}
need_cmd systemctl "Requires systemd."
need_cmd bun       "Install from https://bun.sh"
need_cmd openssl   "Install the openssl package."
need_cmd curl      "Install curl."

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_DIR="${DATA_DIR:-$XDG_DATA_HOME/ework-mirror}"
ENV_FILE="$DATA_DIR/.env"
DB_PATH="$DATA_DIR/mirror.db"

UNIT_DIR="$([[ "$SCOPENAME" == "--user" ]] && echo "$XDG_CONFIG_HOME/systemd/user" || echo "/etc/systemd/system")"
mkdir -p "$UNIT_DIR"

gen_token() { openssl rand -hex "${1:-20}"; }

# Mirrors ework-aio/bin/install.sh:ctl — keep hardening in sync.
ctl() {
  local out rc
  out="$(systemctl "$SCOPENAME" "$@" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$out" == *"Failed to connect to bus"* || "$out" == *"No medium found"* ]]; then
      cat >&2 <<EOF
${c_red}systemctl $SCOPENAME failed to reach the user bus.${c_reset}
  $out
Hint: run from a logged-in session, or:
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
or reinstall with: sudo ework-mirror install --system
EOF
      return $rc
    fi
    if [[ "$out" == *"not found"* ]]; then
      systemctl "$SCOPENAME" daemon-reload >/dev/null 2>&1 || true
      out="$(systemctl "$SCOPENAME" "$@" 2>&1)"
      rc=$?
    fi
  fi
  printf '%s\n' "$out"
  return $rc
}

case "$MODE" in
  status)
    hr; log "ework-mirror status ($SCOPENAME)"; hr
    ctl is-active ework-mirror.service || true
    ctl status --no-pager --lines=0 ework-mirror.service 2>/dev/null || true
    exit 0
    ;;

  logs)
    exec journalctl "$SCOPENAME" -u ework-mirror.service -f
    ;;

  uninstall)
    hr; log "Uninstalling ework-mirror (keeping data)"; hr
    ctl stop ework-mirror.service 2>/dev/null || true
    ctl disable ework-mirror.service 2>/dev/null || true
    rm -f "$UNIT_DIR/ework-mirror.service"
    ctl daemon-reload
    ok "Service removed. Data preserved at $DATA_DIR"
    exit 0
    ;;
esac

hr
log "ework-mirror install"
log "  scope      : $SCOPENAME"
log "  data dir   : $DATA_DIR"
log "  port       : $PORT"
log "  host       : $HOST"
log "  gitea url  : ${GITEA_URL:-<from existing .env>}"
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

mkdir -p "$DATA_DIR"

write_env() {
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -f "$ENV_FILE" ]]; then
    log "Preserving existing $ENV_FILE (refreshing PORT/HOST)"
    if [[ -n "$GITEA_URL" ]]; then
      sed -i "s|^GITEA_URL=.*|GITEA_URL=$GITEA_URL|" "$ENV_FILE"
    fi
    if [[ -n "$GITEA_TOKEN" ]]; then
      sed -i "s|^GITEA_TOKEN=.*|GITEA_TOKEN=$GITEA_TOKEN|" "$ENV_FILE"
    fi
    sed -i "s|^PORT=.*|PORT=$PORT|" "$ENV_FILE"
    sed -i "s|^HOST=.*|HOST=$HOST|" "$ENV_FILE"
    ok "$ENV_FILE updated"
    return
  fi

  if [[ -z "$GITEA_URL" || -z "$GITEA_TOKEN" ]]; then
    die "First-time install requires --gitea-url and --gitea-token (token for user 'awork')."
  fi

  local secret; secret=$(gen_token 20)
  cat > "$ENV_FILE" <<EOF
# Generated by ework-mirror install at $(date -u +%Y-%m-%dT%H:%M:%SZ)
PORT=$PORT
HOST=$HOST
EWORK_WEBHOOK_SECRET=$secret
GITEA_URL=$GITEA_URL
GITEA_TOKEN=$GITEA_TOKEN
GITEA_ACT_AS=awork
DB_PATH=$DB_PATH
VERBOSE=false
EOF
  chmod 600 "$ENV_FILE"
  ok "Wrote $ENV_FILE"
  cat >&2 <<EOF

${c_bold}Configure ework-web to deliver webhooks here:${c_reset}
  URL:    http://127.0.0.1:$PORT/ingest/ework
  Secret: $secret
  Events: issues, issue_comment
  Add per-project at: /<owner>/<repo>/webhooks

EOF
}

write_env

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_FILE="$UNIT_DIR/ework-mirror.service"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ework-mirror — one-way webhook mirror ework → Gitea
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SRC_DIR
ExecStart=$(command -v bun) $SRC_DIR/src/index.ts
Restart=on-failure
RestartSec=5
KillMode=process
EnvironmentFile=$ENV_FILE
Environment="PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.bun/bin"
Environment="XDG_DATA_HOME=$XDG_DATA_HOME"
Environment="XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
Environment="HOME=$HOME"
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ework-mirror

[Install]
WantedBy=default.target
EOF

if [[ "$SCOPENAME" == "--system" ]]; then
  sed -i 's/^WantedBy=default.target/WantedBy=multi-user.target/' "$UNIT_FILE"
fi
ok "Wrote $UNIT_FILE"

ctl daemon-reload

if [[ "$NO_START" == "0" ]]; then
  log "Starting ework-mirror..."
  ctl enable ework-mirror.service
  ctl restart ework-mirror.service
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
      ok "ework-mirror listening on :$PORT (after ${i} half-seconds)"
      break
    fi
    sleep 0.5
    [[ $i -eq 60 ]] && die "ework-mirror did not come up in 30s. Check: journalctl $SCOPENAME -u ework-mirror.service -n 50"
  done
else
  warn "--no-start: unit enabled but not started"
  ctl enable ework-mirror.service
fi

hr
ok "Install complete."
hr
printf '\n%s→%s Ingest URL: %shttp://%s:%s/ingest/ework%s\n' \
  "$c_bold" "$c_reset" "$c_dim" "$HOST" "$PORT" "$c_reset"
printf '  Data dir: %s%s%s\n' "$c_dim" "$DATA_DIR" "$c_reset"
printf '  Logs:     ework-mirror logs\n'
printf '  Status:   ework-mirror status\n'
printf '  Uninstall: ework-mirror uninstall\n'
hr
