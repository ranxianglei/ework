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

# ERR trap: when `set -e` kills the script, print the line + last command so
# the user sees why instead of an empty prompt. Tricky failure modes (root
# scope + polkit redirect, missing systemd PID 1, journalctl-as-root) all
# manifest as silent exit at a systemctl call — without this trace, the user
# just sees the prompt return and assumes install succeeded.
trap 'rc=$?; if [[ $rc -ne 0 ]]; then echo "${c_red}✗${c_reset} install.sh exited with code $rc at line $LINENO (most recent command: ${BASH_COMMAND})" >&2; echo "  If running in PID-file mode (default), this is a real bug — please report." >&2; echo "  If running with '\''systemd'\'' subcommand and systemd is unavailable, retry without it." >&2; fi' ERR

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
AS_USER=""
ALLOW_ROOT=0
CFG_ARGS=()
MODE_ARGS=()
# USE_SYSTEMD=1 only when user runs `install systemd`. Default install is
# pure PID-file mode (no systemctl calls, no unit files, no linger prompt).
# This is the inverse of v0.1.x behavior where install always tried systemd
# first. PID-file mode is simpler, works on hosts without systemd, and
# matches the dominant failure mode we've seen in the wild.
USE_SYSTEMD=0

usage() {
  cat <<'EOF'
ework-aio <command> [options]

Commands:
  install [systemd] [options]     Install or upgrade the ework stack (default)
                                 Add 'systemd' to also write+enable systemd
                                 units. Without 'systemd', runs in pure
                                 PID-file mode (no systemctl calls).
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
  systemd                        Also install systemd units + enable them.
                                 Without this flag, install is PID-file only.
  --user                         (with systemd) user-level units (default)
  --system                       (with systemd) system-level units (needs sudo)
  --data-dir <path>              Override data directory (default: ~/.local/share/ework-aio)
  --port <n>                     ework-web port (default: 3002)
  --daemon-port <n>              ework-daemon port (default: 3101)
  --bot-name <login>             Bot username (default: ework-daemon)
  --no-start                     Install but don't start services
  --yes                          Skip all prompts (use generated defaults)
  --as-user <login>              (sudo only) drop priv: re-exec install as <login>
                                 after enabling linger. Data + opencode + npm
                                 resolved under that user's HOME.
  --allow-root                   (sudo only) override default refuse-on-root

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
      # Global flags (--data-dir, --user, --system, etc.) are still
      # respected here so `config set K V --data-dir X` works as expected.
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --no-restart) NO_RESTART=1; shift ;;
          -h|--help) CFG_ARGS=("help"); shift ;;
          --user)   SCOPENAME="--user"; shift ;;
          --system) SCOPENAME="--system"; shift ;;
          --data-dir) DATA_DIR="$2"; shift 2 ;;
          --port)   WORK_PORT="$2"; shift 2 ;;
          --daemon-port) DAEMON_PORT="$2"; shift 2 ;;
          --bot-name) BOT_NAME="$2"; shift 2 ;;
          --yes|-y) ASSUME_YES=1; shift ;;
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
    --as-user) AS_USER="$2"; shift 2 ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "Unknown option: $1 (try --help)" ;;
    *) MODE_ARGS+=("$1"); shift ;;
  esac
done

# ─── Root guard: refuse install as root by default ──────────────────────────
# Running install as root puts data under /root/.local/share/ework-aio, bakes
# root-only paths into systemd units, and looks for opencode in root's PATH
# (usually missing). The right answer is almost always: don't use sudo.
# --as-user re-execs the script as the named user after enabling linger.
# --allow-root is an explicit acknowledgement that you've set up root's
# environment (opencode installed, npm prefix configured, etc.).
if [[ "$MODE" == "install" && "${EUID:-$(id -u)}" == "0" ]]; then
  if [[ -n "$AS_USER" ]]; then
    AS_USER_HOME="$(getent passwd "$AS_USER" 2>/dev/null | cut -d: -f6 || true)"
    AS_USER_UID="$(getent passwd "$AS_USER" 2>/dev/null | cut -d: -f3 || true)"
    if [[ -z "$AS_USER_HOME" || -z "$AS_USER_UID" ]]; then
      die "--as-user: user '$AS_USER' not found in passwd database"
    fi
    if [[ "$AS_USER_UID" == "0" ]]; then
      die "--as-user: target user is root — just use --allow-root instead"
    fi
    log "Enable linger for '$AS_USER' so --user services survive logout..."
    loginctl enable-linger "$AS_USER" \
      || die "Failed to enable linger for '$AS_USER'. Try: sudo loginctl enable-linger $AS_USER"
    ok "Linger enabled for '$AS_USER'"
    log "Re-execing as '$AS_USER' (HOME=$AS_USER_HOME)..."
    # Strip --as-user <name> from argv, preserve everything else.
    new_args=()
    skip=0
    for a in "$@"; do
      if [[ "$skip" == "1" ]]; then skip=0; continue; fi
      if [[ "$a" == "--as-user" ]]; then skip=1; continue; fi
      new_args+=("$a")
    done
    # Resolve our own path (can't rely on $0 after sudo changes PATH).
    SELF="$(command -v ework-aio 2>/dev/null || true)"
    [[ -n "$SELF" ]] || SELF="${BASH_SOURCE[0]:-$0}"
    exec sudo -u "$AS_USER" --login -- "$SELF" "${new_args[@]}"
  fi
  if [[ "$ALLOW_ROOT" != "1" ]]; then
    cat >&2 <<EOF
${c_red}ework-aio install refuses to run as root by default.${c_reset}

Why this matters:
  - Data goes under /root/.local/share/ework-aio (unreadable by other users)
  - opencode is searched in root's PATH (usually not installed there)
  - npm packages install to system-wide prefix owned by root
  - systemd units bake root-only paths that other users can't run

${c_bold}Option A (recommended):${c_reset} run as a regular user.
  npm config set prefix '~/.local'        # one-time, makes -g user-writable
  npm install -g ework-aio                # no sudo needed
  ework-aio install                       # uses --user systemd scope

${c_bold}Option B:${c_reset} install with sudo but target a regular user.
  sudo ework-aio install --as-user $(logname 2>/dev/null || echo '<your-user>')
  # All data + opencode + npm resolved under that user's HOME.
  # systemd --user scope (linger auto-enabled for the target user).

${c_bold}Option C:${c_reset} really install as root (you've set up root's env).
  sudo ework-aio install --allow-root
EOF
    exit 1
  fi
  warn "Running install as root with --allow-root — data will live under /root."
fi

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
  [[ "$USE_SYSTEMD" == "1" ]] || return 0
  [[ "$SCOPENAME" == "--user" ]] || return 0
  local uid
  uid="$(id -u)"
  local rundir="/run/user/$uid"

  if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "$rundir" ]]; then
    export XDG_RUNTIME_DIR="$rundir"
  fi
  # ${XDG_RUNTIME_DIR:-} not bare ${XDG_RUNTIME_DIR}: the first if above only
  # exports when /run/user/$uid exists. On hosts without linger / without any
  # login session, /run/user/$uid is absent, XDG_RUNTIME_DIR stays unset, and
  # `set -u` would kill install here before the systemd_reachable() fallback
  # can route to PID-file mode.
  if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "${XDG_RUNTIME_DIR:-}/bus" ]]; then
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

# ─── Post-parse: detect `install systemd` sub-variant ──────────────────────
# `install systemd` (or `systemd install`, or `install ... systemd`) opts in
# to writing+enabling systemd units. Without this token, install is pure
# PID-file mode (no systemctl calls, no unit files, no linger prompt).
if [[ "$MODE" == "install" ]]; then
  new_mode_args=()
  for a in "${MODE_ARGS[@]:-}"; do
    [[ -z "$a" ]] && continue
    if [[ "$a" == "systemd" ]]; then
      USE_SYSTEMD=1
    else
      new_mode_args+=("$a")
    fi
  done
  MODE_ARGS=("${new_mode_args[@]:-}")
fi

# ─── Pre-flight: command dependencies ───────────────────────────────────────
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1. $2"
}
need_cmd awk        "Should be present on any Linux."

# systemctl only required when user opts into systemd variant. Default
# install path is PID-file only and works on hosts without systemd.
if [[ "$MODE" == "install" ]]; then
  [[ "$USE_SYSTEMD" == "1" ]] && need_cmd systemctl  "Install with 'systemd' subcommand requires systemctl. Drop 'systemd' to install in PID-file mode."
  need_cmd bun        "Install from https://bun.sh"
  need_cmd npm        "Install Node.js or Bun (ships npm)"
  need_cmd opencode   "Install from https://opencode.ai"
  need_cmd openssl    "Install the openssl package."
  need_cmd curl       "Install curl."
  need_cmd jq         "Install jq (for opencode.json merge)."
fi

# EWORK_AIO_BIN: always resolvable (used by status/logs/config/uninstall
# to delegate to PID-file mode operations when systemd is unreachable).
EWORK_AIO_BIN="$(command -v ework-aio 2>/dev/null || true)"
[[ -n "$EWORK_AIO_BIN" ]] || EWORK_AIO_BIN="$(npm root -g 2>/dev/null)/ework-aio/bin/ework-aio"

# systemd_reachable: 0 if `systemctl $SCOPENAME` can talk to systemd, 1 if not.
# Used by status/logs/config/uninstall to decide whether to use systemd
# (preferred) or fall back to PID-file mode via the ework-aio dispatcher.
# Hosts where this returns 1: containers without systemd PID 1, polkit
# redirects under sudo that drop the bus, hosts where the user isn't
# permissioned for the system bus.
systemd_reachable() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl "$SCOPENAME" is-system-running >/dev/null 2>&1 \
    || systemctl "$SCOPENAME" list-units --no-pager >/dev/null 2>&1
}

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
    # Pre-clean stale npm rename temp-dirs from any previous failed install.
    # npm's atomic-install pattern renames the existing package dir to a
    # `.<pkg>-<rand>` sibling before extracting the new tarball; if a prior
    # install crashed mid-flight, that temp dir stays behind and the NEXT
    # install fails with ENOTEMPTY on the rename. Symptoms:
    #   npm error code ENOTEMPTY
    #   npm error syscall rename
    #   npm error path .../node_modules/ework-web
    #   npm error dest  .../node_modules/.ework-web-Cx2Tkt83
    clean_npm_stale_dirs() {
      local npm_root
      npm_root="$(npm root -g 2>/dev/null)" || return 0
      [[ -d "$npm_root" ]] || return 0
      # Stale temp patterns: .ework-web-XXXX, .ework-daemon-XXXX, .opencode-ework-XXXX,
      # .ework-aio-XXXX, plus the .Trash suffix some npm versions use.
      local found=()
      while IFS= read -r p; do
        [[ -n "$p" ]] && found+=("$p")
      done < <(find "$npm_root" -maxdepth 1 \( \
        -name '.ework-web-*'      -o \
        -name '.ework-daemon-*'   -o \
        -name '.ework-aio-*'      -o \
        -name '.opencode-ework-*' -o \
        -name 'ework-*.Trash*'    -o \
        -name 'opencode-ework.Trash*' \) 2>/dev/null || true)
      if [[ ${#found[@]} -gt 0 ]]; then
        log "Found ${#found[@]} stale npm temp dir(s) under $npm_root from a previous failed install:"
        printf '  %s\n' "${found[@]}"
        log "Removing..."
        local d
        for d in "${found[@]}"; do
          rm -rf "$d" 2>/dev/null || warn "could not remove $d (try: sudo rm -rf $d)"
        done
      fi
    }

    npm_install_global() {
      # One retry after a cleanup pass — covers the ENOTEMPTY case where npm
      # itself produced a fresh temp dir during this same failed run.
      if ! npm install -g "$1@latest"; then
        warn "npm install -g $1@latest failed; cleaning stale temp dirs and retrying once..."
        clean_npm_stale_dirs
        npm install -g "$1@latest"
      fi
    }

    clean_npm_stale_dirs
    log "Installing/updating npm packages globally..."
    # Install each as a top-level global so bins are linked to PATH.
    # (npm v9 doesn't hoist nested deps' bins from `npm i -g ework-aio`.)
    # Always run `npm install -g` (not gated on presence) so re-runs pick up new versions.
    for pkg in ework-web ework-daemon opencode-ework ework-aio; do
      npm_install_global "$pkg" || die "npm install -g $pkg@latest failed (even after cleanup retry; manual fix: sudo rm -rf $(npm root -g)/.$pkg-* $(npm root -g)/$pkg.Trash*)"
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
    # Older installs (pre-0.1.16) may have a .env that predates some keys
    # ework-web's Zod schema now requires (WORK_COOKIE_SECRET in particular).
    # Fill any missing required keys with fresh defaults so the preserved
    # .env doesn't crash the next start. User-set keys are never overwritten.
    ensure_web_env_keys
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

# ensure_env_key: append KEY=value to $file iff KEY is not already present.
# Used to forward-fill schema-required keys on preserved .env files without
# clobbering any user-set values.
ensure_env_key() {
  local file="$1" key="$2" val="$3"
  if ! grep -qE "^${key}=" "$file" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$val" >> "$file"
    log "  + added missing key: $key"
  fi
}

ensure_web_env_keys() {
  # Only fills keys that are missing; never overwrites existing values.
  # Tokens / secrets get fresh random values (safe because if they were
  # missing, web couldn't have started, so nothing depends on them yet).
  local tok secret webhook
  tok=$(gen_token 20)
  secret=$(gen_token 24)
  webhook=$(gen_token 20)
  ensure_env_key "$WEB_ENV" WORK_PORT             "$WORK_PORT"
  ensure_env_key "$WEB_ENV" WORK_HOST             "127.0.0.1"
  ensure_env_key "$WEB_ENV" WORK_TOKEN            "$tok"
  ensure_env_key "$WEB_ENV" WORK_COOKIE_SECRET    "$secret"
  ensure_env_key "$WEB_ENV" WORK_OPERATOR_LOGIN   "$USER"
  ensure_env_key "$WEB_ENV" WORK_WRITES_ENABLED   "true"
  ensure_env_key "$WEB_ENV" WORK_DB_PATH          "$WEB_DATA_DIR/ework.db"
  ensure_env_key "$WEB_ENV" WORK_ATTACHMENT_ROOT  "$WEB_DATA_DIR/attachments"
  ensure_env_key "$WEB_ENV" WORK_FILE_ROOTS       "/tmp,$DATA_DIR"
  ensure_env_key "$WEB_ENV" WORK_DAEMON_BOT_LOGIN "$BOT_NAME"
  ensure_env_key "$WEB_ENV" WORK_DAEMON_WEBHOOK_URL    "http://127.0.0.1:$DAEMON_PORT"
  ensure_env_key "$WEB_ENV" WORK_DAEMON_WEBHOOK_SECRET "$webhook"
}

write_daemon_env() {
  mkdir -p "$(dirname "$DAEMON_ENV")"
  local bot_token="$1"
  local webhook
  # Reuse webhook secret from web env so daemon's signature matches web's verify
  webhook=$(awk -F= '/^WORK_DAEMON_WEBHOOK_SECRET=/{print $2}' "$WEB_ENV" 2>/dev/null || true)
  [[ -n "$webhook" ]] || webhook=$(gen_token 20)
  if [[ -f "$DAEMON_ENV" ]]; then
    log "Preserving existing $DAEMON_ENV"
    # Same forward-fill pattern as web: required keys get filled if missing.
    ensure_env_key "$DAEMON_ENV" DAEMON_ENV          "production"
    ensure_env_key "$DAEMON_ENV" DAEMON_PORT         "$DAEMON_PORT"
    ensure_env_key "$DAEMON_ENV" DAEMON_HOST         "127.0.0.1"
    ensure_env_key "$DAEMON_ENV" DAEMON_DB_PATH      "$DAEMON_DATA_DIR/ework-daemon.db"
    ensure_env_key "$DAEMON_ENV" GITEA_URL           "http://127.0.0.1:$WORK_PORT"
    ensure_env_key "$DAEMON_ENV" GITEA_TOKEN         "$bot_token"
    ensure_env_key "$DAEMON_ENV" GITEA_WEBHOOK_SECRET "$webhook"
    ensure_env_key "$DAEMON_ENV" BOT_USERNAME        "$BOT_NAME"
    ensure_env_key "$DAEMON_ENV" BOT_TOKEN           "$bot_token"
    ensure_env_key "$DAEMON_ENV" OPENCODE_BINARY      "$(command -v opencode)"
    ensure_env_key "$DAEMON_ENV" OPENCODE_BASE_WORKDIR "$DATA_DIR/opencode-workdir"
    return
  fi
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

# ctl wraps `systemctl $SCOPENAME` with three hardenings over the bare command:
#   1. If output contains "Unit ... not found", retry once after daemon-reload
#      — fresh user sessions (no linger, post-ssh-reconnect) often have a stale
#      unit cache and this is the standard fix.
#   2. If output mentions any D-Bus / user-bus connection failure, print an
#      actionable hint. The user-bus daemon emits several variants across
#      hosts and bash versions ("Failed to connect to bus", "No medium found",
#      "Failed to get D-Bus connection: Operation not permitted",
#      "Call to org.freedesktop.DBus ... failed"); we match the common stem
#      "bus" / "D-Bus" so a new variant can't slip past.
#   3. ALWAYS return systemctl's real exit code. Previously the trailing
#      `printf` masked the failure (returning 0) when no pattern matched,
#      which made every caller's `|| fallback` silently not fire.
ctl() {
  local out rc
  out="$(systemctl "$SCOPENAME" "$@" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$out" == *([Bb]us|D-Bus|No medium found)* ]]; then
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
  return "$rc"
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
  if ! systemd_reachable; then
    log "systemd not reachable — using PID-file mode restart"
    if [[ "$svc" == "both" ]]; then
      "$EWORK_AIO_BIN" restart both && ok "Restarted ework-web + ework-daemon (PID-file mode)" || rc=$?
    else
      "$EWORK_AIO_BIN" restart "$svc" && ok "Restarted ework-$svc (PID-file mode)" || rc=$?
    fi
    if [[ $rc -ne 0 ]]; then
      warn "PID-file restart of '$svc' failed (exit $rc)."
      warn "The .env changes are saved; run 'ework-aio restart $svc' manually."
    fi
    return $rc
  fi
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
  hr; log "ework-aio status"; hr
  if ! systemd_reachable; then
    log "(systemd unreachable — showing PID-file mode status)"
    "$EWORK_AIO_BIN" ps 2>/dev/null || warn "ework-aio ps failed"
    hr
    log "Port listeners:"
    p=""
    for p in $(grep -hE '^(WORK_PORT|DAEMON_PORT)=' "$WEB_ENV" "$DAEMON_ENV" 2>/dev/null | cut -d= -f2 | sort -u); do
      if curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:$p/login" 2>/dev/null; then
        printf '  :%s  ✓ listening\n' "$p"
      else
        printf '  :%s  ✗ not responding\n' "$p"
      fi
    done
    exit 0
  fi
  ctl is-active ework-web.service    || true
  ctl is-active ework-daemon.service || true
  ctl status --no-pager --lines=0 ework-web.service    2>/dev/null || true
  hr
  ctl status --no-pager --lines=0 ework-daemon.service 2>/dev/null || true
  exit 0
  ;;

logs)
  svc="${MODE_ARGS[0]:-ework-web.service}"
  [[ "$svc" == "daemon" || "$svc" == "ework-daemon" ]] && svc="ework-daemon.service"
  [[ "$svc" == "web"     || "$svc" == "ework-web" ]]    && svc="ework-web.service"
  if ! systemd_reachable; then
    svc_short="${svc%.service}"
    svc_short="${svc_short#ework-}"
    log_file="$DATA_DIR/run/${svc_short}.log"
    if [[ ! -f "$log_file" ]]; then
      die "systemd unreachable and no PID-file log at $log_file. Start services with: ework-aio start $svc_short"
    fi
    log "(systemd unreachable — tailing PID-file log $log_file)"
    exec tail -n 200 -f "$log_file"
  fi
  exec journalctl "$SCOPENAME" -u "$svc" -f
  ;;

uninstall)
  hr; log "Uninstalling ework-aio services (keeping data)"; hr
  "$EWORK_AIO_BIN" stop both 2>/dev/null || true
  if systemd_reachable; then
    ctl stop    ework-web.service ework-daemon.service 2>/dev/null || true
    ctl disable ework-web.service ework-daemon.service 2>/dev/null || true
    rm -f "$UNIT_DIR/ework-web.service" "$UNIT_DIR/ework-daemon.service"
    ctl daemon-reload 2>/dev/null || true
  else
    log "(systemd unreachable — skipped unit cleanup; PID-file mode services stopped above)"
    rm -f "$UNIT_DIR/ework-web.service" "$UNIT_DIR/ework-daemon.service" 2>/dev/null || true
  fi
  ok "Services removed. Data preserved at $DATA_DIR"
  warn "To fully remove: rm -rf $DATA_DIR && npm uninstall -g ework-aio ework-web ework-daemon opencode-ework"
  exit 0
  ;;
esac

# ─── Install mode ───────────────────────────────────────────────────────────
hr
log "ework-aio install"
log "  mode       : $([[ "$USE_SYSTEMD" == "1" ]] && echo "systemd" || echo "PID-file (no systemd)")"
log "  data dir   : $DATA_DIR"
log "  web bin    : $EWORK_WEB_BIN"
log "  daemon bin : $EWORK_DAEMON_BIN"
log "  opencode   : $(command -v opencode) ($($(command -v opencode) --version 2>&1 | head -1))"
hr

if [[ "$USE_SYSTEMD" == "1" && "$SCOPENAME" == "--user" ]] && ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
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

# ─── Write ework-web systemd unit (only with `install systemd`) ────────────
SYSTEMD_OK=0
if [[ "$USE_SYSTEMD" == "1" ]]; then
  WEB_UNIT="$UNIT_DIR/ework-web.service"
  write_unit_file \
    "ework-web" \
    "ework — multi-project issue tracker" \
    "$EWORK_WEB_BIN" \
    "$WEB_DATA_DIR" \
    "$WEB_ENV" \
    "$WEB_UNIT"
  ok "Wrote $WEB_UNIT"

  # systemd calls here are best-effort. If systemd isn't functional on this host
  # (containers without systemd PID 1, polkit redirects under sudo, missing
  # /etc/systemd/system) we still want install to complete so the user can run
  # `ework-aio start` (PID-file mode) against the scaffolded .env.
  SYSTEMD_OK=1
  if ! ctl daemon-reload; then
    warn "systemctl daemon-reload failed — systemd may be unavailable on this host."
    SYSTEMD_OK=0
  fi

  if [[ "$NO_START" == "0" && "$SYSTEMD_OK" == "1" ]]; then
    log "Starting ework-web (systemd)..."
    ctl enable ework-web.service || { warn "systemctl enable failed"; SYSTEMD_OK=0; }
    if [[ "$SYSTEMD_OK" == "1" ]]; then
      ctl restart ework-web.service || { warn "systemctl restart failed"; SYSTEMD_OK=0; }
    fi
    if [[ "$SYSTEMD_OK" == "1" ]]; then
      for i in $(seq 1 60); do
        if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
          ok "ework-web listening on :$WORK_PORT (after ${i} half-seconds)"
          break
        fi
        sleep 0.5
        [[ $i -eq 60 ]] && { warn "ework-web did not come up via systemd in 30s. Falling back to PID-file mode."; SYSTEMD_OK=0; }
      done
    fi
  else
    warn "--no-start: unit enabled but not started"
    ctl enable ework-web.service 2>/dev/null || true
  fi
fi

# ─── Start ework-web in PID-file mode ──────────────────────────────────────
# Default path (no `systemd` arg) OR systemd fallback. We bring web up via
# setsid+nohup so the bot bootstrap below can HTTP-probe it. Web stays
# running in PID-file mode after install — use `ework-aio stop` to kill it.
if [[ "$NO_START" == "0" && "$SYSTEMD_OK" == "0" ]]; then
  log "Starting ework-web (PID-file mode)..."
  WEB_LOG_FILE="$DATA_DIR/run/web.log"
  mkdir -p "$(dirname "$WEB_LOG_FILE")"
  setsid nohup "$EWORK_WEB_BIN" >>"$WEB_LOG_FILE" 2>&1 </dev/null &
  WEB_PID=$!
  disown "$WEB_PID" 2>/dev/null || true
  printf '%s\n' "$WEB_PID" > "$DATA_DIR/run/web.pid"
  ok "ework-web started in PID-file mode (pid $WEB_PID, log $WEB_LOG_FILE)"
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
      ok "ework-web listening on :$WORK_PORT (after ${i} half-seconds, PID-file mode)"
      break
    fi
    sleep 0.5
    [[ $i -eq 60 ]] && die "ework-web did not come up in 30s. Tail of $WEB_LOG_FILE: $(tail -n 20 "$WEB_LOG_FILE" 2>/dev/null)"
  done
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
BOT_BOOTSTRAP_OK=1
if [[ -f "$BOT_TOKEN_FILE" ]]; then
  BOT_TOKEN=$(cat "$BOT_TOKEN_FILE")
  ok "Reusing saved bot token from $BOT_TOKEN_FILE"
else
  # Pre-flight: web must be reachable for the bot bootstrap HTTP calls below.
  # In --no-start mode OR on hosts where systemd couldn't bring web up, skip
  # the bootstrap entirely — daemon .env still gets written (with empty token)
  # so the user can `ework-aio start` and re-run install later.
  if ! curl -sf -o /dev/null "http://127.0.0.1:$WORK_PORT/login"; then
    warn "ework-web not reachable at :$WORK_PORT — skipping bot bootstrap."
    warn "Daemon will not be able to talk to web until you re-run install with web running."
    BOT_BOOTSTRAP_OK=0
  fi
fi

if [[ "$BOT_BOOTSTRAP_OK" == "1" && ! -f "$BOT_TOKEN_FILE" ]]; then
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
    *) warn "Failed to create bot user: HTTP $CREATE_CODE — skipping PAT mint; daemon will not be able to talk to web until re-run"; BOT_BOOTSTRAP_OK=0 ;;
  esac
fi

if [[ "$BOT_BOOTSTRAP_OK" == "1" && ! -f "$BOT_TOKEN_FILE" ]]; then
  log "Logging in as bot to mint PAT..."
  COOKIE_JAR=$(mktemp)
  LOGIN_CODE=$(curl -sS -c "$COOKIE_JAR" -X POST "http://127.0.0.1:$WORK_PORT/login" \
    --data-urlencode "login=$BOT_NAME" \
    --data-urlencode "password=$BOT_PW" \
    -o /dev/null -w '%{http_code}') || LOGIN_CODE=000
  BOT_COOKIE=$(awk '/ework_auth/ {print $7}' "$COOKIE_JAR")
  rm -f "$COOKIE_JAR"
  if [[ "$LOGIN_CODE" != "302" || -z "$BOT_COOKIE" ]]; then
    warn "Bot login failed: HTTP $LOGIN_CODE — skipping PAT mint"
    BOT_BOOTSTRAP_OK=0
  fi
fi

if [[ "$BOT_BOOTSTRAP_OK" == "1" && ! -f "$BOT_TOKEN_FILE" ]]; then
  log "Minting PAT..."
  PAT_RES=$(curl -sS -X POST "http://127.0.0.1:$WORK_PORT/me/tokens/create" \
    -H "Cookie: ework_auth=$BOT_COOKIE" \
    --data-urlencode "name=aio-$(date +%s)")
  BOT_TOKEN=$(printf '%s' "$PAT_RES" | grep -oE 'id="t">[a-f0-9]{40}<' | grep -oE '[a-f0-9]{40}' | head -1 || true)
  if [[ -z "$BOT_TOKEN" ]]; then
    warn "Could not extract PAT from token-create response — daemon .env will have empty token"
  else
    printf '%s' "$BOT_TOKEN" > "$BOT_TOKEN_FILE"
    chmod 600 "$BOT_TOKEN_FILE"
    ok "Bot PAT saved to $BOT_TOKEN_FILE"
  fi
fi

# ─── Write ework-daemon .env ───────────────────────────────────────────────
write_daemon_env "$BOT_TOKEN"

# ─── Write + start ework-daemon (systemd path, only with `install systemd`) ─
if [[ "$USE_SYSTEMD" == "1" ]]; then
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

  ctl daemon-reload 2>/dev/null || true
  if [[ "$NO_START" == "0" && "$SYSTEMD_OK" == "1" ]]; then
    log "Starting ework-daemon (systemd)..."
    ctl enable ework-daemon.service 2>/dev/null || true
    ctl restart ework-daemon.service 2>/dev/null || warn "ework-daemon restart via systemd failed; falling back to PID-file mode"
    sleep 1
    if ctl is-active --quiet ework-daemon.service 2>/dev/null; then
      ok "ework-daemon active (systemd)"
    else
      warn "ework-daemon not active via systemd — falling back to PID-file mode"
      SYSTEMD_OK=0
    fi
  else
    ctl enable ework-daemon.service 2>/dev/null || true
  fi
fi

# ─── Start ework-daemon in PID-file mode (default path) ────────────────────
# Mirrors the web PID-file start. Skipped if systemd already brought it up.
if [[ "$NO_START" == "0" && "$SYSTEMD_OK" == "0" ]]; then
  log "Starting ework-daemon (PID-file mode)..."
  DAEMON_LOG_FILE="$DATA_DIR/run/daemon.log"
  mkdir -p "$(dirname "$DAEMON_LOG_FILE")"
  setsid nohup "$EWORK_DAEMON_BIN" >>"$DAEMON_LOG_FILE" 2>&1 </dev/null &
  DAEMON_PID=$!
  disown "$DAEMON_PID" 2>/dev/null || true
  printf '%s\n' "$DAEMON_PID" > "$DATA_DIR/run/daemon.pid"
  ok "ework-daemon started in PID-file mode (pid $DAEMON_PID, log $DAEMON_LOG_FILE)"
fi

if [[ "$USE_SYSTEMD" == "1" && "$SYSTEMD_OK" == "0" ]]; then
  hr
  warn "systemd mode did not come up cleanly on this host."
  warn "Services started in PID-file mode instead. systemd unit files were"
  warn "written but are not active. To clean them up: ework-aio uninstall"
  hr
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
ok "Install complete ($([[ "$USE_SYSTEMD" == "1" ]] && echo "systemd mode" || echo "PID-file mode"))."
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
printf '  Stop:           ework-aio stop\n'
printf '  Uninstall:      ework-aio uninstall\n'
if [[ "$USE_SYSTEMD" != "1" ]]; then
  hr
  printf '\n%sPID-file mode note%s (services run via nohup, not systemd)\n' "$c_bold" "$c_reset"
  printf '  • To enable auto-restart on boot, re-run with: ework-aio install systemd\n'
  printf '  • Services stop when you kill them (no supervisor). Use ework-aio stop to stop cleanly.\n'
fi
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
