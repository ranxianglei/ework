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
NO_RESTART=0
CFG_ARGS=()

usage() {
  cat <<'EOF'
ework-aio <command> [options]

Commands:
  install [options]              Install or upgrade the ework stack (default)
  uninstall                      Stop services and remove units (data preserved)
  status                         Show service status
  logs [web|daemon]              Tail logs
  env                            Print key paths (no secrets)
  config <subcommand>            Read / change runtime config (.env keys)
    config list                  List all settable keys + current values
    config get <KEY>             Print current value of one key
    config set <KEY> <VALUE>     Set a key, then restart affected service
                                 (unless --no-restart is given)
    config restart <web|daemon>  Restart one or both services

Install options:
  --user                         Use user-level systemd units (default if non-root)
  --system                       Use system-level systemd units (default if root)
  --data-dir <path>              Override data directory (default: ~/.local/share/ework-aio)
  --port <n>                     ework-web port (default: 3002)
  --daemon-port <n>              ework-daemon port (default: 3101)
  --bot-name <login>             Bot username (default: ework-daemon)
  --no-start                     Install units but don't start services
  --yes                          Skip all prompts (use generated defaults)

Global options:
  --no-restart                   With `config set`: edit .env but skip the restart
  -h, --help                     Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    install|uninstall|status|logs|env) MODE="$1"; shift ;;
    config)
      MODE="config"
      shift
      # Consume remaining args as config subcommand + its positionals.
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --no-restart) NO_RESTART=1; shift ;;
          -h|--help) CFG_ARGS=("help"); shift ;;
          *) CFG_ARGS+=("$1"); shift ;;
        esac
      done
      ;;
    --user)   SCOPENAME="--user"; shift ;;
    --system) SCOPENAME="--system"; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --port)   WORK_PORT="$2"; shift 2 ;;
    --daemon-port) DAEMON_PORT="$2"; shift 2 ;;
    --bot-name) BOT_NAME="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --no-restart) NO_RESTART=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

# Resolve scope: default by uid
if [[ "$SCOPENAME" == "--user" && "${EUID:-$(id -u)}" == "0" ]]; then
  SCOPENAME="--system"
fi

# ─── Ensure --user mode can actually talk to systemd ─────────────────────────
# When invoked from ssh/cron/non-PAM-login shells, XDG_RUNTIME_DIR is often
# empty and systemctl --user fails with "Failed to connect to bus" or — worse —
# "Unit not found" (when a stale bus from another session responds but doesn't
# know about installed units). Auto-export the runtime dir + bus socket if we
# can find them. No-op for --system scope.
ensure_user_session() {
  [[ "$SCOPENAME" == "--user" ]] || return 0
  local uid
  uid="$(id -u)"
  local rundir="/run/user/$uid"

  if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "$rundir" ]]; then
    export XDG_RUNTIME_DIR="$rundir"
  fi
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi

  # Final sanity: can we reach systemd --user at all?
  if ! systemctl --user is-system-running >/dev/null 2>&1 \
     && ! systemctl --user list-units >/dev/null 2>&1; then
    warn "systemctl --user cannot reach the user session bus."
    warn "  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<empty>}"
    warn "  DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-<empty>}"
    warn "Likely causes: ssh without PAM, no linger, or session never started."
    warn "Fix: 'sudo loginctl enable-linger \$USER' then relogin; or reinstall with --system."
    return 1
  fi
  return 0
}
ensure_user_session || true   # warn but don't hard-fail — let later steps report specifics

# ─── Pre-flight: command dependencies ───────────────────────────────────────
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1. $2"
}
# Commands every mode needs (status/logs/env/config/uninstall all use systemctl).
need_cmd systemctl  "This installer requires systemd."
need_cmd awk        "Should be present on any Linux."

# Install-only deps. Other modes work even if these are missing.
if [[ "$MODE" == "install" ]]; then
  need_cmd bun        "Install from https://bun.sh"
  need_cmd npm        "Install Node.js or Bun (ships npm)"
  need_cmd opencode   "Install from https://opencode.ai"
  need_cmd openssl    "Install the openssl package."
  need_cmd curl       "Install curl."
  need_cmd jq         "Install jq (for opencode.json merge)."
fi

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
    log "Installing/updating npm packages globally..."
    # Install each as a top-level global so bins are linked to PATH.
    # (npm v9 doesn't hoist nested deps' bins from `npm i -g ework-aio`.)
    # Always run `npm install -g` (not gated on presence) so re-runs pick up new versions.
    for pkg in ework-web ework-daemon opencode-ework ework-aio; do
      npm install -g "$pkg@latest" || die "npm install -g $pkg@latest failed"
    done
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

# ctl wraps `systemctl $SCOPENAME` with two hardenings over the bare command:
#   1. If output contains "Unit ... not found", retry once after daemon-reload
#      — fresh user sessions (no linger, post-ssh-reconnect) often have a stale
#      unit cache and this is the standard fix.
#   2. If output mentions bus connection failure, print an actionable hint
#      instead of letting the raw "No medium found" / "Failed to connect to
#      bus" message through unchanged.
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
or reinstall with: sudo ework-aio install --system
EOF
      return $rc
    fi
    if [[ "$out" == *"not found"* ]]; then
      systemctl "$SCOPENAME" daemon-reload >/dev/null 2>&1 || true
      out="$(systemctl "$SCOPENAME" "$@" 2>&1)"
      rc=$?
      if [[ $rc -ne 0 ]]; then
        cat >&2 <<EOF
${c_red}systemctl $SCOPENAME $*: unit not found after daemon-reload.${c_reset}
The unit file may be missing from $UNIT_DIR. Re-run:
  ework-aio install --no-start    # rewrites units, preserves .env/data
EOF
        return $rc
      fi
    fi
  fi
  printf '%s\n' "$out"
}

# ─── Config mode: read/change runtime .env keys ─────────────────────────────
# Each entry: KEY|SERVICE|DESCRIPTION. Only keys in this list are settable via
# `config set`. Secrets (WORK_TOKEN, *_WEBHOOK_SECRET, BOT_TOKEN), DB paths,
# and the web<->daemon contract (GITEA_URL/TOKEN, WORK_DAEMON_WEBHOOK_*) are
# deliberately excluded — changing them by hand breaks the install.
SETTABLE_KEYS=(
  "WORK_PORT|web|ework-web listen port (default 3002)"
  "WORK_HOST|web|ework-web bind address (default 127.0.0.1; use 0.0.0.0 for LAN)"
  "WORK_OPERATOR_LOGIN|web|login auto-promoted to admin"
  "WORK_OPENCODE_BIN|web|opencode binary path used by ework-web"
  "WORK_TRANSLATE_URL|web|OpenAI-compat /v1/chat/completions endpoint for translate"
  "WORK_TRANSLATE_MODEL|web|translate model name"
  "WORK_TTS_SPEED|web|TTS playback rate (default 1.0)"
  "WORK_FILE_ROOTS|web|comma-separated file-viewer roots"
  "WORK_COMMENT_SORT|web|comment sort order: desc|asc"
  "DAEMON_PORT|daemon|ework-daemon listen port (default 3101)"
  "DAEMON_HOST|daemon|ework-daemon bind address (default 127.0.0.1)"
  "OPENCODE_BINARY|daemon|opencode binary path"
  "OPENCODE_BASE_WORKDIR|daemon|opencode working directory base"
  "COMPLETION_CHECK_API_KEY|daemon|completion-check API key"
  "COMPLETION_CHECK_BASE_URL|daemon|completion-check API base URL"
  "COMPLETION_CHECK_MODEL|daemon|completion-check model name"
)

key_service() {
  local k="$1" e
  for e in "${SETTABLE_KEYS[@]}"; do
    [[ "$e" == "$k|"* ]] || continue
    local rest="${e#*|}"
    echo "${rest%%|*}"
    return
  done
}
key_default() {
  local k="$1" e
  for e in "${SETTABLE_KEYS[@]}"; do
    [[ "$e" == "$k|"* ]] || continue
    local rest="${e#*|}"
    echo "${rest#*|}"
    return
  done
}
key_settable()  { local k="$1"; local e; for e in "${SETTABLE_KEYS[@]}"; do [[ "$e" == "$k|"* ]] && return 0; done; return 1; }

env_file_for() {
  case "$1" in
    web)    echo "$WEB_ENV" ;;
    daemon) echo "$DAEMON_ENV" ;;
    *)      return 1 ;;
  esac
}

env_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/,""); print; found=1} END{exit !found}' "$file"
}

env_set() {
  local file="$1" key="$2" val="$3"
  [[ -f "$file" ]] || { mkdir -p "$(dirname "$file")"; touch "$file"; chmod 600 "$file"; }
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

service_for_key() {
  case "$1" in
    WORK_PORT)
      echo "both" ;;
    DAEMON_PORT)
      echo "both" ;;
    *)
      echo "$(key_service "$1")" ;;
  esac
}

restart_service() {
  local svc="$1"
  local rc=0
  case "$svc" in
    web)    ctl restart ework-web.service    && ok "Restarted ework-web"    || rc=$? ;;
    daemon) ctl restart ework-daemon.service && ok "Restarted ework-daemon" || rc=$? ;;
    both)
      ctl restart ework-web.service ework-daemon.service \
        && ok "Restarted ework-web + ework-daemon" || rc=$?
      ;;
    *) return 1 ;;
  esac
  if [[ $rc -ne 0 ]]; then
    warn "restart of '$svc' failed (exit $rc)."
    warn "The .env changes are saved; services still need to be reloaded."
    warn "Recovery: 'ework-aio config restart $svc' from a logged-in shell,"
    warn "or 'sudo ework-aio install --system' to escape user-bus limitations."
    return $rc
  fi
  return 0
}

config_help() {
  cat <<'EOF'
ework-aio config <subcommand>

Subcommands:
  list                          List all settable keys + current values
  get <KEY>                     Print current value of one key
  set <KEY> <VALUE>             Set a key in .env, then restart the affected
                                service (unless --no-restart is given)
  restart <web|daemon|both>     Restart one or both services

Examples:
  ework-aio config list
  ework-aio config get WORK_PORT
  ework-aio config set WORK_PORT 8080
  ework-aio config set WORK_TRANSLATE_URL http://127.0.0.1:8000/v1 --no-restart
  ework-aio config restart both

Note: changing WORK_PORT or DAEMON_PORT also rewrites the cross-link the other
service uses (GITEA_URL on daemon side, WORK_DAEMON_WEBHOOK_URL on web side),
and restarts both. Secrets and DB paths are not settable here — rerun
`ework-aio install` (with `rm .env` first if you need new tokens).
EOF
}

config_list() {
  hr; log "Settable config keys"; hr
  printf '  %-28s %-8s %s\n' "KEY" "SERVICE" "VALUE"
  local e k svc val env_file
  for e in "${SETTABLE_KEYS[@]}"; do
    k="${e%%|*}"
    svc="$(key_service "$k")"
    env_file="$(env_file_for "$svc")"
    val="$(env_get "$env_file" "$k" 2>/dev/null || echo '')"
    [[ -z "$val" ]] && val="(unset)"
    printf '  %-28s %-8s %s\n' "$k" "$svc" "$val"
  done
  hr
  printf 'Use %sconfig set <KEY> <VALUE>%s to change a key.\n' "$c_bold" "$c_reset"
}

config_get() {
  local k="$1"
  [[ -n "$k" ]] || die "Usage: ework-aio config get <KEY>"
  key_settable "$k" || die "Key '$k' is not settable. Run 'ework-aio config list' for the allow-list."
  local svc env_file val
  svc="$(key_service "$k")"
  env_file="$(env_file_for "$svc")"
  val="$(env_get "$env_file" "$k" 2>/dev/null)" || { warn "$k is not currently set in $env_file"; exit 0; }
  printf '%s\n' "$val"
}

config_set() {
  local k="$1" v="$2"
  [[ -n "$k" && -n "$v" ]] || die "Usage: ework-aio config set <KEY> <VALUE>"
  key_settable "$k" || die "Key '$k' is not settable. Run 'ework-aio config list' for the allow-list."

  local svc env_file
  svc="$(key_service "$k")"
  env_file="$(env_file_for "$svc")"

  log "Setting $k=$v in $env_file"
  cp "$env_file" "$env_file.bak.$(date +%s)" 2>/dev/null || true
  env_set "$env_file" "$k" "$v"
  ok "$k updated"

  case "$k" in
    WORK_PORT)
      log "Propagating to daemon (GITEA_URL)"
      cp "$DAEMON_ENV" "$DAEMON_ENV.bak.$(date +%s)" 2>/dev/null || true
      env_set "$DAEMON_ENV" "GITEA_URL" "http://127.0.0.1:$v"
      ok "DAEMON_ENV GITEA_URL updated"
      ;;
    DAEMON_PORT)
      log "Propagating to web (WORK_DAEMON_WEBHOOK_URL)"
      cp "$WEB_ENV" "$WEB_ENV.bak.$(date +%s)" 2>/dev/null || true
      env_set "$WEB_ENV" "WORK_DAEMON_WEBHOOK_URL" "http://127.0.0.1:$v"
      ok "WEB_ENV WORK_DAEMON_WEBHOOK_URL updated"
      ;;
  esac

  if [[ "$NO_RESTART" == "1" ]]; then
    local to_restart
    to_restart="$(service_for_key "$k")"
    warn "--no-restart: changes saved but service not reloaded. Run 'ework-aio config restart $to_restart' to apply."
    return
  fi

  local target
  target="$(service_for_key "$k")"
  log "Restarting $target..."
  restart_service "$target" || warn "restart failed — services may need manual reload"
}

config_restart() {
  local svc="${1:-both}"
  case "$svc" in
    web|daemon|both) restart_service "$svc" ;;
    *) die "Usage: ework-aio config restart <web|daemon|both>" ;;
  esac
}

run_config() {
  local sub="${CFG_ARGS[0]:-list}"
  case "$sub" in
    list)    config_list ;;
    get)     config_get "${CFG_ARGS[1]:-}" ;;
    set)     config_set "${CFG_ARGS[1]:-}" "${CFG_ARGS[2]:-}" ;;
    restart) config_restart "${CFG_ARGS[1]:-both}" ;;
    help|-h|--help) config_help ;;
    *) die "Unknown config subcommand: $sub (try: ework-aio config help)" ;;
  esac
}

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

config)
  run_config
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
# Safety: every edit writes to a temp file, validates with `jq -e .`, only
# then atomically replaces the original. A timestamped .bak is always kept.
mkdir -p "$(dirname "$OPENCODE_CFG")"

json_edit() {
  # $1 = file, $2 = jq program, $3 = expected JSON type (optional, e.g. "object").
  # Writes to temp, validates (parses + optional type check), only then swaps.
  # Backup at $file.bak.<epoch>.
  local file="$1" prog="$2" expected="${3:-}" tmp
  tmp=$(mktemp)
  if ! jq "$prog" "$file" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    die "jq edit failed on $file (program: $prog)"
  fi
  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    die "jq edit produced invalid JSON on $file — aborted, original untouched"
  fi
  if [[ -n "$expected" ]] && ! jq -e "type == \"$expected\"" "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    die "jq edit produced wrong type on $file (expected $expected) — aborted, original untouched"
  fi
  cp "$file" "$file.bak.$(date +%s)"
  mv "$tmp" "$file"
}

if [[ ! -f "$OPENCODE_CFG" ]]; then
  log "Writing $OPENCODE_CFG (registering opencode-ework plugin)"
  cat > "$OPENCODE_CFG" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-ework@latest"]
}
EOF
elif grep -q '"opencode-ework@latest"' "$OPENCODE_CFG"; then
  ok "opencode-ework@latest already in $OPENCODE_CFG"
elif grep -q '"opencode-ework"' "$OPENCODE_CFG"; then
  log "Upgrading opencode-ework → opencode-ework@latest in $OPENCODE_CFG"
  json_edit "$OPENCODE_CFG" \
    '.plugin = ((.plugin // []) | map(if . == "opencode-ework" then "opencode-ework@latest" else . end))' \
    object
  ok "Plugin upgraded (backup at $OPENCODE_CFG.bak.*)"
else
  log "Merging opencode-ework@latest into existing $OPENCODE_CFG"
  json_edit "$OPENCODE_CFG" \
    'if .plugin then .plugin += ["opencode-ework@latest"] else . + {plugin:["opencode-ework@latest"]} end' \
    object
  ok "Plugin registered (backup at $OPENCODE_CFG.bak.*)"
fi

if ! jq -e 'type == "object"' "$OPENCODE_CFG" >/dev/null 2>&1; then
  warn "$OPENCODE_CFG is not a JSON object — check $OPENCODE_CFG.bak.* for restore"
fi

# ─── Done ──────────────────────────────────────────────────────────────────
hr
ok "Install complete."
hr
printf '\n%s→%s Open %shttp://127.0.0.1:%s/login%s\n' \
  "$c_bold" "$c_reset" "$c_dim" "$WORK_PORT" "$c_reset"
printf '  Operator login: %s%s%s (auto-promoted admin; derived from $USER at install time)\n' \
  "$c_bold" "$USER" "$c_reset"
printf '  Login token:    %s%s%s\n' "$c_bold" "$WORK_TOKEN_VAL" "$c_reset"
printf '  Bot user:       %s%s%s (auto-created, used by ework-daemon)\n' \
  "$c_bold" "$BOT_NAME" "$c_reset"
printf '  Data dir:       %s%s%s\n' "$c_dim" "$DATA_DIR" "$c_reset"
printf '  Logs:           ework-aio logs web | ework-aio logs daemon\n'
printf '  Status:         ework-aio status\n'
printf '  Uninstall:      ework-aio uninstall\n'
hr
printf '\n%sNext steps (optional config)%s\n' "$c_bold" "$c_reset"
printf '  • 朗读 (TTS):     %shttp://127.0.0.1:%s/admin/tts%s — needs an OpenAI-compat /audio/speech endpoint\n' \
  "$c_dim" "$WORK_PORT" "$c_reset"
printf '  • 翻译:           edit %s%s/.env%s, set WORK_TRANSLATE_URL + WORK_TRANSLATE_MODEL\n' \
  "$c_dim" "$WEB_DATA_DIR" "$c_reset"
printf '                    (OpenAI-compat /v1/chat/completions endpoint), then: ework-aio install\n'
printf '  • Per-project webhook: open %s/<owner>/<repo>/webhooks%s to wire downstream\n' \
  "$c_dim" "$c_reset"
printf '                    consumers (GitHub Actions, etc.). Gitea-compat payload + HMAC-SHA256 sig.\n'
hr
