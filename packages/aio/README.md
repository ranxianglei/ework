# ework-aio

All-in-one installer for the **ework** self-hosted AI development stack:

| Component       | npm package      | Role                                                                 |
| --------------- | ---------------- | -------------------------------------------------------------------- |
| **ework-web**   | `ework-web`      | Multi-project issue tracker (web UI + Gitea-compat REST)             |
| **ework-daemon**| `ework-daemon`   | Issue-driven AI bridge (spawns `opencode` to resolve issues)         |
| **opencode-ework** | `opencode-ework` | OpenCode plugin (gives agents `issue`/`reply`/`floor` tools)       |

`ework-aio` wires the three together on a single host: it installs systemd units, generates tokens, bootstraps the bot user, and registers the plugin in `~/.config/opencode/opencode.json`.

## Quick start

```bash
# Recommended: user-level install (no sudo needed)
npm install -g ework-aio --prefix ~/.local && ework-aio install
```

That's the whole install. When it finishes it prints your login URL, operator login, and token.

> **PATH heads-up:** `--prefix ~/.local` puts bin shims at `~/.local/bin/`.
> Most distros already have `~/.local/bin` on PATH (via `systemd-user-sessions`
> or `~/.profile`). If `command -v ework-aio` fails after install, add this to
> your `~/.bashrc` / `~/.zshrc`:
>
> ```bash
> export PATH="$HOME/.local/bin:$PATH"
> ```

### Prerequisites

The install command checks for these and aborts with a hint if any are missing:

| Tool        | Min ver | Install from                         |
| ----------- | ------- | ------------------------------------ |
| `bun`       | 1.1.0   | https://bun.sh                       |
| `opencode`  | 1.14    | https://opencode.ai                  |
| `npm`       | any     | ships with bun or node               |
| `systemctl` | any     | systemd-based Linux                  |
| `openssl`/`curl`/`jq`/`awk` | any | your distro package manager |

### Install variants

```bash
# System-level install (needs sudo; services run as root, units in /etc/systemd/system)
sudo npm install -g ework-aio && sudo ework-aio install --system

# Run without installing globally (downloads + runs once)
npx ework-aio install

# Route through an HTTP proxy if npm registry is slow on your machine
HTTPS_PROXY=http://127.0.0.1:7890 npm install -g ework-aio --prefix ~/.local && ework-aio install
```

User-level (default in this README) keeps everything under your home directory:

- bins: `~/.local/bin/`
- npm package files: `~/.local/lib/node/`
- data: `~/.local/share/ework-aio/`
- systemd units: `~/.config/systemd/user/`

`sudo` is never required; uninstall is `rm -rf ~/.local/share/ework-aio && npm uninstall -g ework-aio --prefix ~/.local`.

### Why two steps?

`npm install -g ework-aio` **only** lays down files: the bin launcher and the bash installer. It does **not** run the installer. The second `ework-aio install` step is what actually:

- writes `.env` files with random tokens,
- creates systemd units (user-level by default, system-level if you sudo),
- starts services,
- bootstraps the bot user,
- edits `~/.config/opencode/opencode.json`.

Keeping these in a separate, explicitly-invoked step is intentional:

- **Privilege boundary.** `sudo npm install -g` runs as root; the install step runs as *you*. Folding them together would force system-level systemd units and root-owned files in `$HOME`.
- **No surprise side-effects.** `npm install -g foo` should lay down files and stop. Creating services, generating tokens, editing your opencode config — that's invasive and belongs in a step you opted into.
- **npm `--ignore-scripts`.** Many users / CI disable lifecycle scripts. Auto-installing via `postinstall` would silently no-op for them.
- **`npm uninstall` reversibility.** Files outside npm's tracking (systemd units, `.env`, DBs, bot PAT) can't be cleaned by npm. Keeping them in a separate command means `npm uninstall -g ework-aio` does what people expect (removes files) and `ework-aio uninstall` does the rest.

`bin/ework-aio` with no args defaults to `install`, so `npm install -g ework-aio && ework-aio` (no `install`) also works.

---

## What it does

1. **Verifies prerequisites** (bun, npm, opencode, systemctl, openssl, curl, jq).
2. **Installs the 3 npm packages** globally (if not already present).
3. **Generates `.env`** with random tokens at `~/.local/share/ework-aio/{ework-web,ework-daemon}/.env` (preserved across re-runs).
4. **Writes systemd units** (`ework-web.service`, `ework-daemon.service`) — user-level by default, system-level when run as root.
5. **Starts ework-web** and waits for it to listen.
6. **Bootstraps the bot user** (`ework-daemon` by default) via `ework-web`'s `/admin/users/create`, then mints a PAT via `/me/tokens/create`. Saved to `~/.local/share/ework-aio/.bot-token` (reused on re-runs).
7. **Writes ework-daemon `.env`** with the bot PAT.
8. **Starts ework-daemon**.
9. **Merges `opencode-ework`** into `~/.config/opencode/opencode.json`'s `plugin` array (idempotent; backs up the original).

## Commands

```
ework-aio install [options]    Install or upgrade the stack
ework-aio uninstall            Stop services and remove units (data preserved)
ework-aio status               Show service status
ework-aio logs [web|daemon]    Tail logs
ework-aio env                  Print key paths (no secrets)
ework-aio config <subcommand>  Read / change runtime .env keys
  config list                 List settable keys + current values
  config get <KEY>            Print one key's current value
  config set <KEY> <VALUE>    Set a key, then restart affected service
                              (use --no-restart to defer)
  config restart <web|daemon|both>  Restart one or both services
```

### Install options

| Flag                    | Default                              | Description                                |
| ----------------------- | ------------------------------------ | ------------------------------------------ |
| `--user`                | (auto: `--user` unless EUID=0)       | Use `systemctl --user`                     |
| `--system`              | (auto: `--system` if EUID=0)         | Use `systemctl` (system-level, needs root) |
| `--data-dir <path>`     | `~/.local/share/ework-aio`           | Override data root                         |
| `--port <n>`            | `3002`                               | ework-web port                             |
| `--daemon-port <n>`     | `3101`                               | ework-daemon port                          |
| `--bot-name <login>`    | `ework-daemon`                       | Bot username in ework-web                  |
| `--no-start`            | (off)                                | Install units but don't start              |
| `--yes`                 | (off)                                | Skip prompts (use generated defaults)      |

## File layout

```
~/.local/share/ework-aio/
├── ework-web/
│   ├── .env                 # ework-web config (tokens, ports, paths)
│   ├── ework.db             # SQLite database (issues, comments, users, ...)
│   └── attachments/         # Filesystem attachments
├── ework-daemon/
│   ├── .env                 # ework-daemon config (bot creds, opencode paths)
│   └── ework-daemon.db      # Daemon state (processes, runs, ...)
├── opencode-workdir/        # Where opencode checks out repos
└── .bot-token               # Bot PAT (chmod 600)

~/.config/systemd/user/
├── ework-web.service
└── ework-daemon.service

~/.config/opencode/opencode.json   # plugin: ["opencode-ework", ...]
```

## Idempotency

Re-running `ework-aio install` is safe:
- `.env` files are preserved (use `rm` to regenerate).
- Bot user creation returns 400/409 if it already exists; PAT is reused.
- Systemd units are overwritten (config drift auto-corrected).
- Plugin merge skips if `opencode-ework` already in `plugin` array.

## Runtime configuration (`ework-aio config`)

For changing settings after install, prefer `config` over editing `.env` by hand — it writes the right file, handles cross-service dependencies, and restarts the affected service for you.

```bash
ework-aio config list                          # see all settable keys + current values
ework-aio config get WORK_PORT                 # read one
ework-aio config set WORK_PORT 8080            # set + auto-restart ework-web
ework-aio config set WORK_PORT 8080 --no-restart  # stage the change, apply later
ework-aio config restart both                  # explicit restart
```

### Settable keys

| Key                          | Service | What it controls                                           |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `WORK_PORT`                  | web     | ework-web listen port (default 3002)                       |
| `WORK_HOST`                  | web     | bind address (default 127.0.0.1; use 0.0.0.0 for LAN)      |
| `WORK_OPERATOR_LOGIN`        | web     | login auto-promoted to admin                               |
| `WORK_OPENCODE_BIN`          | web     | opencode binary path used by ework-web                     |
| `WORK_TRANSLATE_URL`         | web     | OpenAI-compat `/v1/chat/completions` endpoint for translate |
| `WORK_TRANSLATE_MODEL`       | web     | translate model name                                       |
| `WORK_TTS_SPEED`             | web     | TTS playback rate (default 1.0)                            |
| `WORK_FILE_ROOTS`            | web     | comma-separated file-viewer roots                          |
| `WORK_COMMENT_SORT`          | web     | `desc` or `asc`                                            |
| `DAEMON_PORT`                | daemon  | ework-daemon listen port (default 3101)                    |
| `DAEMON_HOST`                | daemon  | bind address                                               |
| `OPENCODE_BINARY`            | daemon  | opencode binary path                                       |
| `OPENCODE_BASE_WORKDIR`      | daemon  | opencode working directory base                            |
| `COMPLETION_CHECK_API_KEY`   | daemon  | completion-check API key                                   |
| `COMPLETION_CHECK_BASE_URL`  | daemon  | completion-check API base URL                              |
| `COMPLETION_CHECK_MODEL`     | daemon  | completion-check model name                                |

### Cross-service dependencies

Changing `WORK_PORT` or `DAEMON_PORT` also rewrites the URL the *other* service uses to call it (so the daemon still finds web, and web still finds the daemon), and restarts **both**:

- `config set WORK_PORT 8080` → updates `WORK_PORT` in web env + `GITEA_URL` in daemon env, restarts both
- `config set DAEMON_PORT 3102` → updates `DAEMON_PORT` in daemon env + `WORK_DAEMON_WEBHOOK_URL` in web env, restarts both

### Not settable here (use install)

Secrets and the web↔daemon contract aren't exposed via `config` — rerun `ework-aio install` to regenerate them (delete the relevant `.env` first if you want fresh tokens):

- Random secrets: `WORK_TOKEN`, `WORK_COOKIE_SECRET`, `WORK_DAEMON_WEBHOOK_SECRET`, `BOT_TOKEN`
- DB / attachment paths: `WORK_DB_PATH`, `WORK_ATTACHMENT_ROOT`, `DAEMON_DB_PATH`
- Web↔daemon contract: `GITEA_URL`, `GITEA_TOKEN`, `WORK_DAEMON_BOT_LOGIN`, `WORK_DAEMON_WEBHOOK_URL`, `BOT_USERNAME`

To regenerate all of them: `rm -rf ~/.local/share/ework-aio && ework-aio install`.

## Uninstall

```bash
ework-aio uninstall                # stops services, removes units
rm -rf ~/.local/share/ework-aio    # also delete data
npm uninstall -g ework-aio ework-web ework-daemon opencode-ework
# Remove the plugin entry from ~/.config/opencode/opencode.json manually
```

## Alternatives

- **Docker AIO**: the `ework-web` repo ships `docker/build.sh` + `docker/run.sh` for a single-container deployment. Useful when you don't want to manage host systemd.
- **Manual**: install the 3 npm packages yourself and wire services by hand using the systemd unit templates in each package.

## License

MIT
