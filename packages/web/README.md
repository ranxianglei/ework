# ework-web

Standalone multi-project issue tracker. Local SQLite-backed, no external API dependency. Bun + TypeScript + SSR HTML + vanilla JS.

Issues, comments, labels, reactions, and attachments live in a local SQLite database, served under `/<owner>/<repo>/issues/<n>` URLs. The same process also hosts an OpenCode session viewer, a file viewer, inline translate, and TTS sidecars.

## Features

- **Multi-project issues** — `/<owner>/<repo>/issues/<n>` URLs, one DB holds all projects
- **Comments** with markdown (marked + highlight.js + DOMPurify), code highlighting, linkify
- **Attachments** — image/pdf/etc upload, stored on local filesystem, streamed via `Bun.file`
- **Labels & reactions** — per-project labels, 9-emoji reactions on comments
- **OpenCode session viewer** — read-only `/sessions`, hot bars, translate, TTS
- **File viewer** — `/file?path=…` with security gate (path validation + denylist + realpath)
- **Inline translation + TTS** — OpenAI-compatible `/v1/chat/completions` + `/v1/audio/speech`
- **Token-cookie auth** — single shared token + HMAC-signed cookie (30d)
- **Rate limiting** — token bucket on `/api/*`, `/login`, translate, TTS, settings

## Installation

### Prerequisites

- **Bun** runtime (v1.x) — required for all install paths
- **Gitea instance** — optional; only needed if you want an upstream mirror per project. Standalone mode (local SQLite) needs no external service.
- **LLM endpoint** (OpenAI-compatible `/v1/chat/completions`, optionally `/v1/audio/speech`) — optional; only needed for inline translation and TTS.

### Option 1 — AIO Docker (recommended)

The all-in-one image bundles ework-web, the daemon, and opencode. Requires Docker.

```bash
cp docker/.env.docker.example docker/.env.docker   # fill WORK_TOKEN + WORK_COOKIE_SECRET
./docker/build.sh                                   # builds ework-aio:latest
HOST_PORT_WEB=13002 HOST_PORT_DAEMON=13101 ./docker/run.sh ework-aio:latest
```

Default published ports are `3002` (web) and `3101` (daemon). Override `HOST_PORT_WEB` / `HOST_PORT_DAEMON` if those are taken on the host. See [`docker/run.sh`](./docker/run.sh) and [`docker/README.md`](./docker/) (if present) for full options (`HOST_BIND_ADDR`, volume names, env passthrough).

### Option 2 — From source (development)

```bash
git clone <this-repo> ework-web && cd ework-web
cp .env.example .env       # fill WORK_TOKEN (≥8 chars) + WORK_COOKIE_SECRET (≥8 chars)
bun install
bun run check              # tsc --noEmit — must pass
bun run dev                # :3002 watch (or bun run start for one-shot)
```

### Option 3 — Systemd (production)

For a persistent single-host deploy, use the deploy script which rsyncs to `~/.local/share/ework/` and installs a systemd unit:

```bash
./scripts/deploy.sh --restart   # type-check → rsync src/ → bun install → install unit → restart
```

The unit runs under `User=ework` and reads `/var/lib/ework/.env`. Inspect or customize [`scripts/ework.service`](./scripts/ework.service) before first deploy; subsequent deploys leave the installed unit alone. See the **Deploy** section below for the full flow.

### First-run setup

1. Visit `http://127.0.0.1:3002/login` (or whichever `WORK_PORT` you set).
2. Log in with the `WORK_TOKEN` you configured.
3. Land on `/projects` — create a project inline, or just POST an issue to `/<owner>/<repo>/issues` and the project will be auto-created.

## Configuration

All env vars prefixed `WORK_*`. Zod-validated in `src/config.ts`.

| Var | Default | Purpose |
|---|---|---|
| `WORK_PORT` | `3002` | Listen port |
| `WORK_HOST` | `127.0.0.1` | Bind host (use `::` for IPv6 remote) |
| `WORK_TOKEN` | — | Required access token (≥8 chars) |
| `WORK_COOKIE_SECRET` | — | HMAC secret for auth cookie (≥8 chars) |
| `WORK_OPERATOR_LOGIN` | `op` | Author attribution for writes |
| `WORK_WRITES_ENABLED` | `true` | Gate all write ops |
| `WORK_DB_PATH` | `$XDG_DATA_HOME/ework/ework.db` | SQLite DB location |
| `WORK_ATTACHMENT_ROOT` | `$XDG_DATA_HOME/ework/attachments` | Attachment files root |

Plus OpenCode / translate / TTS / file-viewer vars — see `.env.example` and `src/config.ts`.

### Defaults worth knowing

- **Port `3002`** — chosen to avoid the 119x range used by VPN/tunnels.
- **Writes default `true`** — ework-web is intended for direct human use; flip `WORK_WRITES_ENABLED=false` for a read-only mirror.
- **Auth scope** — single operator (`WORK_OPERATOR_LOGIN`) writing as one user. The schema reserves a `users` table for multi-user; not yet surfaced in the UI.

## Project layout

```
src/
├── index.ts             # Bun.serve :3002 + route dispatch + security headers
├── config.ts            # Zod env validation (no gitea block)
├── auth.ts              # token + HMAC cookie
├── store.ts             # SQLite data layer (projects/issues/comments/labels/reactions/attachments)
├── schema.sql           # DDL applied on boot
├── db.ts                # rawDB handle + config table CRUD
├── attachments.ts       # filesystem blob storage + Bun.file streaming
├── ratelimit.ts         # token bucket
├── opencode.ts          # OpenCode CLI client (read-only)
├── translate.ts         # OpenAI-compatible translation
├── fileview.ts          # file/dir viewer + security gate
├── reactions.ts         # hydrate reactions onto CommentView[]
├── render/
│   ├── layout.ts        # SSR layout + THEME_CSS + utils
│   ├── markdown.ts      # marked + DOMPurify + linkify (no Gitea rewrite)
│   └── components.ts    # CommentView + renderCommentCard
├── views/
│   ├── issueThread.ts   # SSR issue thread (SQLite-backed)
│   ├── issueList.ts     # per-project list (with search + state tabs)
│   ├── issueNew.ts      # create-issue form
│   ├── issues.ts        # global feed (cross-project)
│   ├── home.ts          # projects list + new-project form
│   ├── sessionLog.ts    # OpenCode session viewer
│   └── settings.ts      # /settings form
└── static/
    ├── app.js           # issue-thread client (virtual scroll, poll, composer, reactions UI)
    ├── session.js       # session-viewer client
    ├── file.js          # file tail -f
    ├── tts.js           # TTS playback
    └── favicon.svg

scripts/deploy.sh        # tsc → rsync → bun install → systemctl restart ework
```

## URL / API surface

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | redirect → `/projects` |
| `GET/POST` | `/projects` | projects list / create new |
| `GET` | `/issues` | global feed (cross-project), `?state=&q=` |
| `GET` | `/<o>/<r>/issues` | per-project list, `?state=&q=` |
| `GET` | `/<o>/<r>/issues/new` | create form |
| `POST` | `/<o>/<r>/issues` | create (auto-creates project if missing) |
| `GET` | `/<o>/<r>/issues/<n>` | issue thread SSR |
| `GET` | `/api/<o>/<r>/issues/<n>/page?page=K` | fetch older comments page |
| `GET` | `/api/<o>/<r>/issues/<n>/since?since=ISO` | poll for new comments |
| `POST` | `/api/<o>/<r>/issues/<n>/comment` | `{body, close?, reopen?}` |
| `POST` | `/api/<o>/<r>/issues/<n>/upload` | multipart attachment upload |
| `GET` | `/attachments/<uuid>` | stream attachment (image inline, else download) |
| `GET` | `/sessions` `/sessions/:id` | OpenCode session browser |
| `GET` | `/file` `/file/raw` `/file/dl` | file viewer (path-gated) |
| `GET` | `/api/file/since` | tail -f polling |
| `POST` | `/api/translate` `/api/translate/stream` | inline translation |
| `POST` | `/api/tts` `GET /api/tts/stream/:id` | TTS staging + streaming |
| `GET/POST` | `/settings` | runtime overrides |
| `POST` | `/login` | token → cookie |

## Deploy

```bash
git add -A && git commit -m "..."    # commit first (deploy.sh rsyncs working tree)
./scripts/deploy.sh
```

`deploy.sh` type-checks → rsyncs `src/` → `bun install` → installs the systemd unit from `scripts/ework.service` on first run → restarts `ework.service`. To customize the unit (different user, port, env path), edit `scripts/ework.service` before first deploy; subsequent deploys leave the installed unit alone.

Logs: `sudo journalctl -u ework -f`.

## Scope

- ❌ No issue edit/delete.
- ❌ No milestones / assignees / PR / multi-user login (schema-compatible; not implemented).
- ❌ No migration tool from Gitea (fresh start; can be added later).
- ✅ **Never writes** to `opencode.db` (read-only SELECT).

## License

MIT — see [LICENSE](./LICENSE).
