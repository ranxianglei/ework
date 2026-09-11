# ework-daemon

Issue-Driven AI Development Bridge. Connects an issue tracker (the [ework-web](../ework) SQLite shim, or real Gitea) to [OpenCode](https://github.com/sst/opencode) AI agents.

> Issue-driven AI development daemon. Listens on `:3101` by default; SQLite at `~/.local/share/ework-daemon/ework-daemon.db`; systemd unit `ework-daemon.service`.

## What it does

You file an issue → the daemon spawns an OpenCode subprocess to handle it → the AI autonomously reads, replies, and closes via the `opencode-ework` plugin's tools (`issue`, `comments`, `floor`, `reply`, `search`). New user comments are forwarded to the running session. Stuck sessions (30 min no output) get a nudge.

**The daemon only does 4 things:**

1. **New issue** → auto-spawn OpenCode.
2. **`@<bot>` mention** on existing issue → trigger a new or existing session.
3. **Existing session + new user comment** → forward to OpenCode (wrapped as a system message).
4. **Stuck detection** → 30 min no stdout → stuck alert.

It does **not** post AI replies, auto-commit, or auto-merge. The AI does all issue interaction itself via the plugin.

## Architecture

```
ework-web (:3002)             ework-daemon (:3101)              OpenCode (subprocess)
   │                                │                               │
   │ ── issue webhook ────────────▸ │                               │
   │                                │ ── Bun.spawn ──────────────▸ │
   │                                │                               │
   │ ◂── plugin GET /issues/n ──────┼───────────────────────────────┤
   │ ◂── plugin POST /comments ─────┼───────────────────────────────┤
   │                                │ ◂── stdout streaming ─────────┤
   │ ── new-comment webhook ─────▸ │                               │
   │                                │ ── stdin (wrapped) ────────▸ │
   │                                │ ◂── completion signal ───────┤
   │ ◂── plugin POST /close ────────┼───────────────────────────────┤
```

The OpenCode subprocess loads the [`opencode-ework`](../opencode-ework) plugin, which speaks Gitea REST. The daemon injects `GITEA_URL`, `GITEA_TOKEN`, `BOT_TOKEN`, `BOT_USERNAME` env vars at spawn, so the plugin picks them up automatically. The plugin is backend-agnostic — same plugin works against real Gitea or any Gitea-compatible shim.

## Prerequisites

- [Bun](https://bun.sh/) runtime (uses `Bun.serve`, `Bun.spawn`, `bun:sqlite` — **Node.js not supported**)
- [OpenCode](https://github.com/sst/opencode) binary
- A running [ework-web](../ework) instance (or real Gitea)
- A bot user PAT on that instance with comment/write permissions

The `tea` CLI is **no longer required** — the OpenCode subprocess uses the `opencode-ework` plugin's `reply` tool (HTTP `POST` with `BOT_TOKEN`), not `tea comment`. The `scripts/setup.ts` wizard still configures tea as a convenience for ad-hoc admin tasks; this will be removed in a future cleanup.

## Quick start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Clone + setup

```bash
git clone https://github.com/ranxianglei/ework-daemon.git
cd ework-daemon
bun install
bun run setup        # interactive wizard: checks deps, creates data dir, writes .env
```

### 3. Configure

Edit `.env` (created from `.env.example` by the wizard):

```bash
$EDITOR .env
```

Required values:

- `GITEA_URL` — your ework-web (e.g. `http://localhost:3002`) or real Gitea URL
- `GITEA_TOKEN` — admin-scope read token
- `BOT_USERNAME` — bot user login (must match the user `BOT_TOKEN` belongs to)
- `BOT_TOKEN` — bot user PAT (used by the plugin to post replies)
- `GITEA_WEBHOOK_SECRET` — HMAC secret shared with the issue tracker's webhook config
- `DAEMON_ENV=production` — must be set to enable production mode (else falls back to test)
- `OPENCODE_BASE_WORKDIR` — parent directory for opencode work dirs (e.g. `/home/<user>/projects`)

### 4. Run

```bash
# Test mode (.env.test)
bun start

# Production (.env)
bun start:prod
```

### 5. Configure the webhook

On ework-web (or Gitea), go to the repository's **Settings → Webhooks → Add Webhook → Gitea**:

| Field | Value |
| --- | --- |
| Target URL | `http://<daemon-ip>:3101/webhook` |
| Content type | `application/json` |
| Secret | (the `GITEA_WEBHOOK_SECRET` from `.env`) |
| Trigger events | Issues, Issue Comment |

## Usage

### New issue → auto pickup

Create an issue. The daemon replies "🔄 picked up" and spawns an OpenCode session. The AI reads the issue via the plugin's `issue` tool and works autonomously.

### Existing issue → trigger via mention

Comment with `@<bot>` (where `<bot>` is your configured `BOT_USERNAME`, e.g. `ework-daemon`):

```
@ework-daemon this issue still needs work
```

### Ongoing session → add instructions

Once a session is running, just comment (no mention needed):

```
Also add a "remember me" checkbox
```

The daemon wraps the comment as a system message and pipes it to the running opencode session's stdin. The AI replies via the plugin's `reply` tool.

### Close → stop

Closing the issue terminates the OpenCode subprocess and cleans up the session.

## Development

### Watch mode

```bash
bun dev          # test mode (.env.test) — auto-restart on file changes
bun dev:prod     # production config (.env)
```

### Type check

```bash
bun run check    # tsc --noEmit
```

### Compile standalone binary

```bash
bun run build            # → ./ework-daemon
bun run install-global   # build + cp to ~/.local/bin/
```

The standalone binary can run without source: `ework-daemon status`, `ework-daemon issues`, etc. (see `src/cli.ts` for the CLI surface).

### Smoke tests

```bash
bun run test:gitea       # ework-web / Gitea connectivity check
```

End-to-end tests live at `scripts/test-e2e.ts` — run manually (not yet in `bun test` format).

## Production deployment (systemd)

A systemd unit template is provided at `scripts/ework-daemon.service`. After running `./scripts/deploy.sh`:

```bash
sudo cp scripts/ework-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ework-daemon
```

Management commands:

```bash
sudo systemctl status ework-daemon
sudo journalctl -u ework-daemon -f
```

**Restart safety**: restarting kills all running OpenCode subprocesses. Always check first:

```bash
curl -s http://localhost:3101/api/processes
# non-empty → wait; empty → safe to restart
```

### Deploy workflow

```bash
cd /path/to/ework-daemon
bun run check && git add -A && git commit -m "..."
./scripts/deploy.sh
# (verify no processes running) then:
sudo systemctl restart ework-daemon
```

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DAEMON_ENV` | ✅ | `test` | `production` to use `.env` values |
| `GITEA_URL` | ✅ | — | ework-web or real Gitea base URL |
| `GITEA_TOKEN` | ✅ | — | Admin-scope read token |
| `GITEA_WEBHOOK_SECRET` | ✅ | — | HMAC secret for webhook verification |
| `BOT_USERNAME` | ✅ | — | Bot user login (anti-recursion check) |
| `BOT_TOKEN` | ✅ | — | Bot user PAT (passed to opencode subprocess) |
| `DAEMON_PORT` | — | `3101` | Listen port |
| `DAEMON_HOST` | — | `0.0.0.0` | Bind host (use `127.0.0.1` for local-only) |
| `OPENCODE_BINARY` | — | `opencode` | OpenCode binary path |
| `OPENCODE_BASE_WORKDIR` | ✅ | — | Parent dir for opencode work dirs |
| `COMPLETION_CHECK_API_KEY` | — | — | Optional: model API key for completion judgment |
| `COMPLETION_CHECK_BASE_URL` | — | — | Optional: model API base URL |
| `COMPLETION_CHECK_MODEL` | — | — | Optional: model name |
| `DAEMON_STUCK_THRESHOLD_MS` | — | `1800000` | Stuck threshold (30 min) |
| `DAEMON_MAX_STUCK_NUDGES` | — | `1` | Max stuck nudges before giving up |

Full list in `.env.example` and `src/config.ts`.

## Data storage

| Data | Path |
| --- | --- |
| Production DB | `~/.local/share/ework-daemon/ework-daemon.db` |
| Test DB | `test/ework-daemon-test.db` (gitignored) |
| Large-message archive | `<workdir>/.ework-daemon/comment-NNN.txt` |
| Code repo work dirs | `$OPENCODE_BASE_WORKDIR/<repo>/` |

Honors `XDG_DATA_HOME`.

## Anti-recursion

- The OpenCode subprocess posts comments via the `opencode-ework` plugin's `reply` tool, using `BOT_TOKEN` (which posts as user `BOT_USERNAME`).
- The daemon's webhook handler drops any webhook whose `comment.user.login === BOT_USERNAME`. **Critical**: `BOT_USERNAME` must exactly match the user that `BOT_TOKEN` belongs to, or this check fails and the daemon recurses into itself.
- Same-issue concurrent requests are serialized through an in-memory queue.

## Project structure

```
src/
├── config.ts             # Zod env validation (test/production dual mode)
├── gitea.ts              # Gitea-compatible REST client (admin read + bot write)
├── server.ts             # Webhook HTTP service (HMAC-SHA256)
├── opencode.ts           # OpenCode process management (queue, streaming, stuck detection)
├── op.ts                 # SQLite persistence (Issue / OpSession / Message)
├── cli.ts                # CLI client
├── index.ts              # Entry
└── trackers/
    ├── types.ts          # IssueTracker interface + 3-entity model
    └── gitea-tracker.ts  # Gitea implementation (ework-web or real Gitea)
```

See [AGENTS.md](./AGENTS.md) for the full development spec — it is the highest-priority doc for contributors.

## Related projects

- [`ework`](../ework) — Standalone SQLite-backed issue tracker with Gitea-compatible REST shim. The default backend for ework-daemon.
- [`opencode-ework`](../opencode-ework) — Plugin loaded by the OpenCode subprocess. Provides `issue`, `comments`, `floor`, `reply`, `search` tools.

## License

MIT — see [LICENSE](./LICENSE).
