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
npm install -g ework-aio && ework-aio install
```

That's the whole install. When it finishes it prints your login URL, operator login, and token.

### Prerequisites

The install command checks for these and aborts with a hint if any are missing:

| Tool        | Min ver | Install from                         |
| ----------- | ------- | ------------------------------------ |
| `bun`       | 1.1.0   | https://bun.sh                       |
| `opencode`  | 1.14    | https://opencode.ai                  |
| `npm`       | any     | ships with bun or node               |
| `systemctl` | any     | systemd-based Linux                  |
| `openssl`/`curl`/`jq`/`awk` | any | your distro package manager |

### One-liner alternatives

```bash
# Run without installing globally (downloads + runs once)
npx ework-aio install

# If npm registry is slow on your machine, route through an HTTP proxy
HTTPS_PROXY=http://127.0.0.1:7890 npm install -g ework-aio && ework-aio install

# User-level install (no sudo) — uses ~/.local as npm prefix
npm install -g ework-aio --prefix ~/.local && ework-aio install
```

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
