# ework-web Development Specification

> **This document is the highest-priority specification for this project. All developers (including AI Agents) MUST comply unconditionally.**

---

## 1. Project Overview

### 1.1 What Is ework-web

**ework-web** is a standalone, multi-project issue tracker. It runs as a single Bun process that stores issues / comments / labels / reactions / attachments in a **local SQLite DB**. The web shell — SSR HTML + vanilla JS + markdown rendering + OpenCode session viewer / file viewer / translate / TTS — is bundled alongside the tracker.

**Three roles in one process**:

1. **Human-facing issue tracker** — full read/write UI at `/<owner>/<repo>/issues/<n>`.
2. **Gitea-compatible REST shim** — `/api/v1/*` endpoints so opencode-ework plugin (or any Gitea client) works without modification.
3. **Sidecar to OpenCode** — read-only OpenCode session viewer (`/sessions`), file viewer (`/file`), inline translate + TTS.

### 1.2 Tech Stack

| Category | Technology |
| --- | --- |
| Language | TypeScript (strict, ESM) |
| Runtime | Bun (`Bun.serve`, `Bun.spawn`, `bun:sqlite`) — **Node.js not supported** |
| Database | SQLite (WAL mode, via `bun:sqlite`) |
| Rendering | SSR HTML + minimal vanilla JS (no React/Vue) |
| Markdown | `marked` + `marked-highlight` + `highlight.js` + `dompurify` |
| Validation | `zod` |
| Auth | Token + HMAC-signed cookie |
| LLM/Translation | OpenAI-compatible `/v1/chat/completions` + `/v1/audio/speech` |
| Package Manager | bun |

### 1.3 Repository Info

| Field | Value |
| --- | --- |
| Package name | `ework-web` (currently `private: true`, not published) |
| Current version | 0.1.0 |
| Gitea | (set to your own Gitea instance, or remove if unused) |
| License | MIT |
| Author | contributors |

---

## 2. Architecture

### 2.1 Module Map

```
src/
├── index.ts             # Bun.serve :3002 + route dispatch + security headers
├── config.ts            # Zod env validation + SETTINGS_GROUPS (admin UI metadata)
├── auth.ts              # token + HMAC cookie auth + login route
├── store.ts             # SQLite data layer: projects/issues/comments/labels/reactions/attachments
├── schema.sql           # DDL applied on boot
├── db.ts                # raw DB handle + config table CRUD + typed `getConfigAll`
├── attachments.ts       # filesystem blob storage + Bun.file streaming
├── giteaApi.ts          # Gitea REST shim: implements /api/v1/repos/* from the SQLite store
├── webhooks.ts          # outbound webhook emitter (Gitea-compatible payload)
├── ratelimit.ts         # token bucket on /api/* /login /translate /tts /settings
├── opencode.ts          # OpenCode CLI client (read-only; session list/export)
├── translate.ts         # OpenAI-compatible translate (stream + chunk)
├── fileview.ts          # file/dir viewer + security gate + media/download + tail -f
├── reactions.ts         # hydrate reactions onto CommentView[]
├── build.ts             # small build-time helpers
├── render/
│   ├── layout.ts        # SSR layout + THEME_CSS + escapeHtml/renderMarkdown utils
│   ├── markdown.ts      # marked + DOMPurify + linkify (XSS boundary)
│   └── components.ts    # CommentView + renderCommentCard
├── views/
│   ├── home.ts          # /projects list + new-project form
│   ├── issues.ts        # /issues — global cross-project feed
│   ├── issueList.ts     # /<o>/<r>/issues — per-project list + tabs + search
│   ├── issueNew.ts      # /<o>/<r>/issues/new — create form
│   ├── issueThread.ts   # /<o>/<r>/issues/<n> — SSR thread + composer + reactions UI
│   ├── sessionLog.ts    # /sessions + /sessions/:id — OpenCode viewer
│   ├── settings.ts      # /settings form (translate/TTS/etc config UI)
│   ├── adminTokens.ts   # /admin/tokens — admin token management
│   ├── tokens.ts        # per-user token management
│   ├── users.ts         # user management
│   ├── projectMembers.ts # per-project member management
│   ├── projectUpstreams.ts # per-project upstream URL settings (Gitea mirror mode)
│   └── webhooks.ts      # per-project webhook management
└── static/
    ├── app.js           # issue-thread client: virtual scroll, poll, composer, reactions
    ├── session.js       # session-viewer client: follow/translate/copy/fold/floor
    ├── file.js          # file tail -f
    ├── tts.js           # TTS playback
    └── favicon.svg
```

### 2.2 Request Flow

```
Browser ──http──▸ ework-web (:3002)
                    │
                    ├─ auth.ts checkAuth (every route)
                    │     ├─ HMAC cookie verify
                    │     └─ /login (POST token → set cookie)
                    │
                    ├─ Human UI (SSR)
                    │     ├─ /projects, /issues (home.ts, issues.ts)
                    │     ├─ /<o>/<r>/issues/<n> (issueThread.ts)
                    │     ├─ /sessions/:id (sessionLog.ts)
                    │     └─ /file?path=… (fileview.ts)
                    │
                    ├─ Gitea shim (/api/v1/*)
                    │     └─ giteaApi.ts → store.ts (SQLite)
                    │
                    ├─ Webhooks outbound (/api/.../comment etc)
                    │     └─ write → store.ts → webhooks.ts emit
                    │
                    ├─ Sidecar
                    │     ├─ opencode.ts (CLI: list/export)
                    │     ├─ translate.ts (OpenAI-compatible)
                    │     └─ attachments.ts (Bun.file stream)
                    │
                    └─ ratelimit.ts (token bucket per IP+route)
```

### 2.3 Key Concepts

#### Gitea-Compatible Shim

`src/giteaApi.ts` implements Gitea REST endpoints byte-for-byte. The plugin `opencode-ework` (or `tea` CLI, or any Gitea client) talks to ework-web exactly like real Gitea. Supported endpoints:

| Method | Path | Implementation |
| --- | --- | --- |
| GET | `/api/v1/repos/{o}/{r}/issues/{n}` | store.getIssue |
| GET | `/api/v1/repos/{o}/{r}/issues/{n}/comments` | store.listComments (not paginated) |
| GET | `/api/v1/repos/{o}/{r}/issues/{n}/timeline` | store.listComments (timeline shape) |
| POST | `/api/v1/repos/{o}/{r}/issues/{n}/comments` | store.addComment + webhook emit |
| POST | `/api/v1/repos/{o}/{r}/issues` | store.createIssue + webhook emit |
| GET | `/api/v1/repos/issues/search` | store.searchIssues |
| POST | `/api/v1/repos/{o}/{r}/issues/{n}/reactions` | store.addReaction |

Bot users (configured via `WORK_BOT_USERNAMES`) bypass `/api/` rate limit — see `giteaApi.ts:52-58`.

#### Data Model

Three entities in `schema.sql`:

- **Project** — `(owner, repo)` pair. Optional `upstream_url` for Gitea-mirror mode.
- **Issue** — has number (per-project, 1-indexed autoincrement), state, title, body, author.
- **Comment** — floor number (1-indexed chronological), body, author.

Plus: `label`, `reaction`, `attachment`, `user`, `token`, `webhook`, `project_member`.

#### Webhook Emission

When writes happen through the Gitea shim or UI, `webhooks.ts` emits Gitea-shaped payloads (`issues` / `issue_comment` events) to configured webhook URLs. The payload shape, headers, and HMAC-SHA256 signature are byte-compatible with Gitea so downstream Actions or external listeners don't need to change.

Events emitted:
- `issues` (opened / closed / reopened)
- `issue_comment` (created)

Webhook deliveries are stored in `webhook_deliveries` table for retry and audit.

#### Markdown Rendering (XSS Boundary)

All external markdown (issue bodies, comments) goes through `render/markdown.ts`:

```
raw markdown
   │
   ▼
marked (parse)
   │
   ▼
DOMPurify (sanitize)
   │
   ▼
rewriteMedia (replace media URLs with /file proxies where appropriate)
   │
   ▼
linkify (inject <a> for ses_ IDs and absolute paths)
   │
   ▼
return safe HTML
```

Linkify runs **after** sanitize so injected anchors are controlled (href is fixed, not user-supplied).

#### File View Security Gate

`fileview.ts:validatePath` enforces:

1. `path.isAbsolute(p)` — reject relative.
2. DENY regex — reject `/etc/passwd`, `.env`, etc.
3. `fs.realpath(p)` — resolve symlinks.
4. Whitelist containment — must be under one of `fileRoots` (each root also realpath'd).
5. DENY realpath — last check before read.

**Any new endpoint that reads files MUST go through `validatePath`.** No exceptions.

### 2.4 Configuration

Zod-validated env vars in `src/config.ts`. Prefix `WORK_*`.

Key vars:

| Var | Default | Purpose |
| --- | --- | --- |
| `WORK_PORT` | 3002 | Listen port |
| `WORK_HOST` | `127.0.0.1` | Bind host |
| `WORK_TOKEN` | — | Admin/operator access token |
| `WORK_COOKIE_SECRET` | — | HMAC secret for cookies |
| `WORK_OPERATOR_LOGIN` | `dog` | Default operator login |
| `WORK_SYSTEM_LOGIN` | `ework-actions` | System/bot user login |
| `WORK_DB_PATH` | `$XDG_DATA_HOME/ework/ework.db` | SQLite location |
| `WORK_ATTACHMENT_ROOT` | `$XDG_DATA_HOME/ework/attachments` | Attachment root |
| `WORK_FILE_ROOTS` | `/tmp` (or your own whitelist) | File-viewer whitelist |
| `WORK_TRANSLATE_URL` | (must override in .env) | OpenAI-compatible translate endpoint |
| `WORK_TTS_BACKENDS` | Kokoro / CosyVoice3 | TTS backend config |

All of these are editable live via `/settings` (admin only) — writes to the `config` table in SQLite, overrides env at boot.

### 2.5 Storage Paths

| What | Path |
| --- | --- |
| SQLite DB | `$WORK_DB_PATH` (default `$XDG_DATA_HOME/ework/ework.db`) |
| SQLite WAL | `<db>-wal`, `<db>-shm` (WAL mode) |
| Attachments | `$WORK_ATTACHMENT_ROOT/<project>/<issue>/<comment>/<filename>` |
| Access log | `/tmp/ework-access.log` (configurable) |
| Opencode DB (read-only) | `$HOME/.local/share/opencode/opencode.db` |
| Runtime (systemd) | `~/.local/share/ework/` (deploy target, see §6) |

### 2.6 Internal vs External Naming

| Scope | Convention |
| --- | --- |
| User-visible URLs | `/<owner>/<repo>/issues/<n>` (Gitea-compatible) |
| API shim | `/api/v1/*` (Gitea-compatible) |
| Internal DB tables | `project`, `issue`, `comment`, etc. (no `ework_` prefix; SQLite is single-tenant) |
| Config env vars | `WORK_*` |
| Package name | `ework-web` |

---

## 3. Development Standards

### 3.1 Build Commands

```bash
bun install              # install deps
bun run check            # tsc --noEmit — MUST pass before commit
bun run dev              # :3002 watch mode
bun run start            # one-shot (no watch)
bun run test             # bun test (currently minimal)
```

### 3.2 Deployment

**Dev/prod separation** (red line):

| Role | Path |
| --- | --- |
| Development (git repo) | `~/projects/ework` (or wherever you cloned) |
| Runtime (systemd) | `~/.local/share/ework/` |

`scripts/deploy.sh` rsyncs `src/` + `package.json` + `tsconfig.json` + `bun.lock` to the runtime directory, then optionally `systemctl restart ework.service`. Does **not** touch `.env` or `ework.db`.

```bash
./scripts/deploy.sh              # sync only (no restart)
./scripts/deploy.sh --restart    # sync + restart (will fail if processes running)
```

Standard release flow (always commit before deploy — see §3.4 red line):

```bash
# 1. Dev: typecheck + test
cd ~/projects/ework       # or wherever you cloned
bun run check && bun test

# 2. Commit
git add -A && git commit -m "..."

# 3. Deploy (sync only, non-disruptive)
./scripts/deploy.sh

# 4. Restart when safe (manual confirmation)
sudo systemctl restart ework.service
systemctl is-active ework.service
```

### 3.3 Testing

Currently no automated test suite. Smoke-test via curl:

| What | How |
| --- | --- |
| Type-check | `bun run check` (mandatory pre-commit) |
| Auth | `curl -c cookie -X POST http://127.0.0.1:3002/login -d "token=..."` |
| Gitea shim | `curl -b cookie http://127.0.0.1:3002/api/v1/repos/<o>/<r>/issues/1` |
| SSR HTML | `curl -b cookie http://127.0.0.1:3002/<o>/<r>/issues/1 \| grep <marker>` |
| File gate | `curl -b cookie 'http://127.0.0.1:3002/file?path=/etc/shadow'` → 403 |
| Webhook | Configure receiver (e.g. `scripts/webhook-receiver.ts`), trigger event, verify payload |

### 3.4 Hard Constraints (Red Lines)

- **Never modify the production DB by hand** — all writes go through the app's store layer. Manual `sqlite3` edits break schema invariants.
- **Always commit before deploy.** `deploy.sh` rsyncs the working tree — uncommitted changes go to runtime but not git = silent drift.
- **Never disable WAL mode.** Performance collapses under concurrent reads.
- **`Bun.serve` only.** No Node.js `http` / `express` polyfill.
- **`renderMarkdown` is the XSS boundary.** All external markdown MUST go through it. No `innerHTML = userInput`.

---

## 4. Code Change Guidelines

### 4.1 Module Dependencies

```
config.ts (leaf — Zod schemas, no internal deps)
   │
   ├── db.ts (raw handle)
   │      │
   │      └── store.ts (CRUD layer — depended on by views, giteaApi, webhooks)
   │
   ├── auth.ts (cookie + token)
   │
   ├── render/markdown.ts (XSS boundary — depended on by all views)
   │
   ├── views/* (each independent; route + fetch + render self-contained)
   │
   ├── giteaApi.ts (depends on store.ts)
   │
   ├── webhooks.ts (depends on store.ts; called by views + giteaApi on writes)
   │
   └── index.ts (entry — dispatches routes to all of the above)
```

**Rule**: views/ modules are independent. A new view = new file + new route in `index.ts`. Do not modify other views unless the change is shared.

### 4.2 Common Patterns

- **SSR + minimal client JS**: render HTML server-side, hydrate with tiny vanilla JS. Do not introduce frameworks.
- **Per-route fetch + render**: each view fetches its own data, renders, returns HTML. No middleware chains.
- **`store.ts` is the data boundary**: all DB access goes through it. Views never run raw SQL.
- **Zod validation on all external input**: request bodies, query params, env. Validate at the edge.
- **Error pages over 500s**: invalid input → 400 with HTML error page. Catch external API failures and render a clean error.

### 4.3 Type Safety (Red Line)

- **Forbidden**: `as any`, `@ts-ignore`, `@ts-expect-error`.
- All external data validated via Zod (`configSchema` for env, request-body schemas per route).
- DB rows typed as `unknown` and narrowed.
- `noUncheckedIndexedAccess` is on — array access returns `T | undefined`, handle it.

### 4.4 Error Handling

- **Empty `catch` blocks forbidden.** Always: log + degrade, or rethrow, or render an error page.
- External calls (`fetch`, OpenCode CLI, translate) have timeouts + try/catch.
- Custom Error classes carry HTTP status (`FileViewError`, etc.).

### 4.5 Security

- **HTML escaping**: `escapeHtml` for text interpolation; `renderMarkdown` for markdown.
- **File view gate**: `fileview.ts:validatePath` is mandatory for all file reads.
- **Tokens**: never logged, never in URLs.
- **Cookies**: `HttpOnly` + `SameSite=Lax` + `Secure` (if `WORK_SECURE_COOKIE=true`).
- **CSRF**: token-cookie SameSite=Lax + custom header check on writes.

### 4.6 Performance

- Pagination on issue lists and comments (don't pull 10K comments).
- OpenCode sessions: default 30 messages, `?all=1` opt-in for full.
- Client DOM caps (virtual scroll, drop old nodes).
- File download/media via `Bun.file` streaming (don't read into memory).
- Incremental polling uses time keys / byte offsets, not full re-fetches.

---

## 5. Contributing

### 5.1 Before Making Changes

1. `bun run check` passes on `master`.
2. Read this document in full, especially §2.3 (Key Concepts) and §4 (Code Change Guidelines).
3. For changes >1 file or architecture-affecting: write a design proposal in the issue first.

### 5.2 Development Workflow

1. Branch from `master`: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`.
2. Implement.
3. `bun run check` passes.
4. Smoke-test the affected route via curl (see §3.3).
5. Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
6. Push and open a PR against `master`. `master` is protected.
7. PR merge requires explicit human authorization.

### 5.3 Git Safety Rules (Mandatory)

| Rule | Enforcement |
| --- | --- |
| **NEVER force-push to `master`** | Create a PR instead. |
| **NEVER merge PRs without explicit human authorization** | "merge" must come from a human comment. |
| **NEVER delete branches or tags without human confirmation** | Preserve work for review. |
| **NEVER deploy without committing first** | `deploy.sh` rsyncs working tree; uncommitted = drift. |

### 5.4 Commit Convention

Conventional Commits:

```
<type>(<scope>): <subject>

<body — explain why, not what>
```

`type` ∈ {`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`}. Write body in plain text.

**Do NOT use backticks in commit messages** — shells interpret them as command substitution and break deploy scripts that consume git log.

### 5.5 Code Review

All source changes (`src/**`) require review before merge:

| Category | Check |
| --- | --- |
| Correctness | Logic matches intent; off-by-ones handled; pagination correct. |
| Type safety | No `as any`, no `@ts-ignore`. Zod validation on inputs. |
| XSS | External markdown through `renderMarkdown`; text through `escapeHtml`. |
| File gate | Any new file-read endpoint goes through `validatePath`. |
| Performance | No full-table scans; pagination; streaming for large blobs. |
| Error handling | No empty catches; errors render user-readable pages. |

---

## 6. Roadmap

| Priority | Item |
| --- | --- |
| P0 | Initial OSS baseline (LICENSE, AGENTS.md, CONTRIBUTING, SECURITY, CI, package.json metadata, URL scrub). **Done.** |
| P1 | `/healthz` endpoint + structured logger (replace `console.*`). |
| P1 | `bun:test` test suite for `store.ts`, `giteaApi.ts`, `fileview.ts` gate. |
| P1 | SQLite backup docs + `scripts/backup.sh`. |
| P2 | npm publish (deferred until ework-stack unified installer). |
| P2 | Prometheus `/metrics` endpoint. |
| P2 | Full-text search via SQLite FTS5. |

See `docs/TODO.md` for the live list.

---

## 7. Related Documentation

- `README.md` — User-facing install + usage.
- `docs/TODO.md` — Live TODO / known gaps.
- `../opencode-ework/AGENTS.md` — Plugin that consumes the `/api/v1/*` shim.
- `../ework-daemon/AGENTS.md` — Daemon that spawns opencode and pairs with ework.

---

## 8. License

MIT — see [LICENSE](./LICENSE).
