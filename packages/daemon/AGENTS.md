# ework-daemon Development Specification

> **This document is the highest-priority specification for this project. All developers (including AI Agents) MUST comply unconditionally.**

> Project overview and development spec. Where docs and code disagree, code wins — and we update this doc.

---

## 1. Project Overview

### 1.1 What Is ework-daemon

**ework-daemon** is an Issue-Driven AI Development Bridge. It connects an issue tracker (the [ework-web](../ework) SQLite-backed Gitea-compatible shim, or real Gitea) to [OpenCode](https://github.com/sst/opencode) AI agents. When a human files an issue, the daemon spawns an opencode subprocess to handle it; the agent then autonomously reads the issue, posts comments, and closes it via the `opencode-ework` plugin's tools.

**Issue-driven AI development daemon.** Listens on `:3101` by default; SQLite at `~/.local/share/ework-daemon/ework-daemon.db`; systemd unit `ework-daemon.service`.

**Core loop**: human files issue → daemon receives webhook → spawns opencode → AI reads issue + posts comments via plugin tools → user追加评论 → daemon forwards to running opencode session.

**The daemon only does 4 things**:

1. **New issue** → auto-spawn OpenCode to handle it.
2. **`@<bot>` mention** on existing issue → trigger new or existing session.
3. **Existing session + new user comment** → forward to running OpenCode (wrapped as a system message).
4. **Stuck detection** → 30 minutes with no output → emit stuck alert.

It does **not**: post AI replies, auto-commit, auto-merge. The AI does all issue interaction itself via the plugin.

### 1.2 Tech Stack

| Category | Technology |
| --- | --- |
| Language | TypeScript (strict, ESM) |
| Runtime | Bun (`Bun.serve`, `Bun.spawn`, `bun:sqlite`) — **Node.js not supported** |
| Database | SQLite (WAL mode, via `bun:sqlite`) |
| AI | OpenCode (separate subprocess, stdin/stdout streaming) |
| Issue tracker | ework-web REST shim (default) or real Gitea (configurable via `GITEA_URL`) |
| Validation | `zod` |
| Package Manager | bun |

### 1.3 Repository Info

| Field | Value |
| --- | --- |
| Package name | `ework-daemon` (currently `private: true`, not published) |
| Current version | 0.1.0 |
| Gitea | https://github.com/ranxianglei/ework-daemon |
| License | MIT |
| Author | dog |
| Binary | `ework-daemon` (CLI; via `bun build --compile`) |

---

## 2. Architecture

### 2.1 Module Map

```
src/
├── index.ts              # Entry: wires config + server + signal handlers
├── config.ts             # Zod env validation, test/production dual mode
├── server.ts             # Webhook HTTP service (HMAC-SHA256 verification)
├── gitea.ts              # Gitea-compatible REST client (admin read + bot write)
├── opencode.ts           # OpenCode process management: queue, streaming,
│                         # stuck detection, preemption, large-content handling
├── op.ts                 # SQLite persistence: Issue / OpSession / Message
├── cli.ts                # CLI client (drives the daemon's HTTP API)
└── trackers/
    ├── types.ts          # IssueTracker interface + Issue/OpSession/Message model
    └── gitea-tracker.ts  # Gitea-shaped backend (ework-web or real Gitea)

scripts/
├── deploy.sh             # rsync src/ → runtime dir + restart hook
├── install.sh            # bun build --compile + cp to ~/.local/bin
├── setup.ts              # first-run interactive setup wizard
├── ework-daemon.service  # systemd unit template
├── test-gitea.ts         # ad-hoc Gitea connectivity test
└── test-e2e.ts           # end-to-end spawn test

plugin/                   # Legacy in-tree plugin copy — DO NOT USE.
                          # Canonical plugin lives at ../opencode-ework/.
                          # This directory is scheduled for removal (P1 cleanup).
```

### 2.2 System Diagram

```
ework-web (:3002)            ework-daemon (:3101)              OpenCode (subprocess)
   │                                │                               │
   │ ── issue webhook ────────────▸ │                               │
   │                                │ ── Bun.spawn ──────────────▸ │
   │                                │                               │
   │ ◂── plugin GET /issues/n ──────┼───────────────────────────────┤
   │ ◂── plugin POST /comments ─────┼───────────────────────────────┤
   │                                │ ◂── stdout streaming ─────────┤
   │                                │                               │
   │ ── new-comment webhook ─────▸ │                               │
   │                                │ ── stdin (wrapped) ────────▸ │
   │                                │                               │
   │                                │ ◂── completion signal ───────┤
   │                                │                               │
   │ ◂── plugin POST /close ────────┼───────────────────────────────┤
```

### 2.3 Three-Entity Model

`trackers/types.ts` defines the daemon's domain model:

- **Issue** — `(owner, repo, issueId)` triple. Tracker-agnostic reference.
- **OpSession** — one issue ↔ one opencode session. Holds workdir / pid / state.
- **Message** — one user/AI message belonging to an OpSession.

The `IssueTracker` interface abstracts tracker operations: `createComment`, `closeIssue`, `listComments`, signature verification, webhook parsing. Currently only `GiteaTracker` is implemented; `references/issue-systems.md` has research notes on Plane.so / Linear / GitHub.

### 2.4 Process Lifecycle

```
webhook arrives
   │
   ▼
server.ts verify signature (HMAC-SHA256)
   │
   ▼
opencode.ts enqueue (per-issue serial)
   │
   ▼
spawn opencode subprocess in workdir
   │
   ▼
stream stdout/stderr (consumed to avoid buffer-blocked hangs)
   │
   ├─→ user adds comment → daemon injects as system message to stdin
   ├─→ 30 min no output → stuck alert posted as comment
   └─→ process exit → mark session complete, write transcript to DB
```

**Preemption**: a new user message arriving on an in-flight session kills the current opencode process and restarts (`preemptSession`, `src/opencode.ts:362-388`). Direct `SIGKILL(9)` via `forceStop` (`src/opencode.ts:1063-1068`) — no SIGTERM escalation. Future improvement: graceful shutdown.

### 2.5 Key Code Locations

| Function | File:Line | Notes |
| --- | --- | --- |
| Env mode detection | `src/config.ts:7-11` | `DAEMON_ENV` defaults to `test`, must be `production` for prod |
| Mention extraction | `src/opencode.ts:95-103` | Strips code blocks before matching `@username` (avoids `host@hostname` false positives) |
| Large content handler | `src/opencode.ts:772-786` | >4000 chars → save to `workdir/.ework-daemon/comment-NNN.txt`, return abs path |
| Session queue | `src/opencode.ts` | Same issue = serial; different issues = parallel |
| Preemption | `src/opencode.ts:362-388` | New message kills + restarts |
| Stuck detection | `src/opencode.ts` | 30 min no stdout → stuck nudge |
| Force stop | `src/opencode.ts:1063-1068` | `SIGKILL(9)` directly; no SIGTERM escalation |
| Webhook verification | `src/server.ts` | HMAC-SHA256, constant-time compare |
| Bot self-filter | `src/gitea.ts` | Webhooks from our own bot user ignored (anti-recursion) |
| SIGTERM handler | `src/index.ts:42-43` | Clean shutdown on systemd stop |

### 2.6 Configuration

Two-file env model (red line):

| File | Used when | Default DB |
| --- | --- | --- |
| `.env.test` | `DAEMON_ENV=test` (or unset) | `test/ework-daemon-test.db` |
| `.env` | `DAEMON_ENV=production` | `~/.local/share/ework-daemon/ework-daemon.db` |

Zod-validated in `src/config.ts`. Key vars (see `.env.example` for the full list):

| Var | Required | Purpose |
| --- | --- | --- |
| `DAEMON_ENV` | yes | `production` to enable prod mode (else falls to test) |
| `GITEA_URL` | yes | Base URL of ework-web (or real Gitea) |
| `GITEA_TOKEN` | yes | Admin-scope read token |
| `GITEA_WEBHOOK_SECRET` | yes | HMAC secret for webhook verification |
| `BOT_USERNAME` | yes | Bot user login (anti-recursion check) |
| `BOT_TOKEN` | yes | Bot user PAT (writes) |
| `DAEMON_PORT` | no | Default 3101 |
| `DAEMON_HOST` | no | Default `0.0.0.0` |
| `OPENCODE_BINARY` | no | Default `opencode` |
| `OPENCODE_BASE_WORKDIR` | yes | Parent dir for opencode work dirs (e.g. `/home/<user>/projects`) |

### 2.7 Storage Paths

| What | Path |
| --- | --- |
| Production DB | `~/.local/share/ework-daemon/ework-daemon.db` |
| Test DB | `test/ework-daemon-test.db` (gitignored) |
| Large-message archive | `<workdir>/.ework-daemon/comment-NNN.txt` |
| Code repo work dirs | `$OPENCODE_BASE_WORKDIR/<repo>/` |
| Webhook secret | `~/.local/share/ework-daemon/.webhook-secret` (or inline in `.env`) |
| Runtime (systemd) | `~/.local/share/ework-daemon/` (deploy target) |

### 2.8 Internal vs External Naming

| Scope | Convention |
| --- | --- |
| User-visible (issues, sessions) | via ework-web UI; daemon is invisible to humans |
| API | none — daemon only listens for webhooks and exposes a small CLI HTTP API |
| Internal DB tables | `issue`, `op_session`, `message` |
| Config env vars | `DAEMON_*`, `GITEA_*`, `BOT_*`, `OPENCODE_*` |
| Bot identity | Configurable via `BOT_USERNAME` (default `ework-daemon`) |
| Systemd unit | `ework-daemon.service` |
| Binary name | `ework-daemon` |

---

## 3. Development Standards

### 3.1 Build Commands

```bash
bun install              # install deps
bun run check            # tsc --noEmit — MUST pass before commit
bun run test             # bun test (no formal tests yet)
bun run test:gitea       # Gitea-connectivity smoke test (needs .env)
bun run build            # bun build --compile → standalone binary `ework-daemon`
bun run install-global   # build + cp to ~/.local/bin/
bun run dev              # watch mode with .env.test
bun run dev:prod         # watch mode with .env
```

### 3.2 Testing

There is no formal `bun test` suite. Current test scripts in `scripts/`:

| Script | Purpose |
| --- | --- |
| `test-gitea.ts` | Verifies ework-web (or Gitea) is reachable, token works, and webhook secret is configured |
| `test-e2e.ts` | End-to-end: creates a sandbox issue, verifies the daemon picks it up, spawns opencode, and the bot replies |

These are ad-hoc and not yet in `bun test` format. P1 roadmap item: convert to `bun:test` with stubs.

**Manual smoke-test workflow**:

```bash
# 1. .env.test set up (point at sandbox project)
bun run dev

# 2. In another shell: create a sandbox issue via curl or ework-web UI

# 3. Verify daemon picks it up
curl http://localhost:3101/api/processes

# 4. Verify bot replies on the issue (via ework-web UI)
```

### 3.3 Deployment

**Dev/runtime separation** (red line):

| Role | Path |
| --- | --- |
| Development (git repo) | `/home/<user>/ework-daemon` |
| Runtime (systemd) | `~/.local/share/ework-daemon/` |

`scripts/deploy.sh` rsyncs `src/` + `package.json` + `tsconfig.json` + `bun.lock` to the runtime directory. Does **not** touch `.env` or `ework-daemon.db`. Restart is manual (see §3.5).

```bash
./scripts/deploy.sh              # sync only (no restart)
# then manually restart when safe:
sudo systemctl restart ework-daemon.service
```

For CLI binary install (separate from systemd daemon):

```bash
bun run install-global           # builds + cp ework-daemon → ~/.local/bin/
```

### 3.4 Hard Constraints (Red Lines)

- **Never modify the production DB by hand** — all writes via the daemon's `op.ts` layer.
- **Always commit before deploy.** `deploy.sh` rsyncs the working tree; uncommitted = drift.
- **Never disable WAL mode.**
- **Never spawn opencode without going through the queue.** Concurrent sessions on the same issue corrupt state.
- **`DAEMON_ENV=production` must be set in prod `.env`** — otherwise it falls back to test mode silently.
- **`Bun.serve` / `Bun.spawn` / `bun:sqlite` only.** No Node.js polyfills.

### 3.5 Restart Safety

`systemctl restart ework-daemon.service` kills all running opencode subprocesses (`destroy()` calls `process.kill(-pid)`). **Always check first**:

```bash
curl -s http://localhost:3101/api/processes
# non-empty array → wait; empty array → safe to restart
```

### 3.6 First-Run Setup

```bash
bun run setup             # interactive wizard
# or manually:
cp .env.example .env      # fill in tokens + URLs
bun run check
bun run dev               # test mode first
```

The setup wizard (`scripts/setup.ts`) checks deps (bun, git, opencode, [tea](https://gitea.com/gitea/tea)), creates the data dir, prompts for the Gitea URL and tokens, and writes `.env`.

---

## 4. Code Change Guidelines

### 4.1 Module Dependencies

```
config.ts (leaf — Zod schemas)
   │
   ├── op.ts (SQLite — depended on by everything stateful)
   │
   ├── trackers/types.ts (interface — depended on by gitea-tracker)
   │       │
   │       └── trackers/gitea-tracker.ts (Gitea impl)
   │
   ├── gitea.ts (REST client — depended on by opencode.ts, server.ts)
   │
   ├── server.ts (HTTP server — depended on by index.ts)
   │
   ├── opencode.ts (process manager — depended on by server.ts, index.ts)
   │
   ├── cli.ts (CLI client — talks to server.ts HTTP API)
   │
   └── index.ts (entry — wires it all together + signal handlers)
```

**Rule**: `trackers/types.ts` is the interface boundary. Adding a new tracker (Plane.so, Linear, GitHub) = implement `IssueTracker` + add a branch in `trackers/index.ts` (when it exists) or wherever the tracker is selected.

### 4.2 Common Patterns

- **Per-issue serialization**: the queue in `opencode.ts` ensures only one opencode process per issue at a time. Don't bypass.
- **Webhook idempotency**: ework-web may redeliver a webhook on timeout. The daemon's `op.ts` layer detects duplicate deliveries by `(issueId, commentId, createdAt)` and ignores them.
- **Anti-recursion**: webhooks whose `comment.user.login === BOT_USERNAME` are silently dropped. Critical: `BOT_USERNAME` must exactly match the bot user the `BOT_TOKEN` posts as.
- **Streaming consumption**: opencode's stdout/stderr are consumed in real-time. Failing to drain causes buffer-full hangs.
- **Env-var injection**: when spawning opencode, the daemon injects `GITEA_URL`, `GITEA_TOKEN`, `BOT_TOKEN`, `BOT_USERNAME` so the plugin (loaded by opencode) picks them up.

### 4.3 Type Safety (Red Line)

- **Forbidden**: `as any`, `@ts-ignore`, `@ts-expect-error`.
- All external data validated via Zod (`configSchema` for env, per-endpoint schemas for webhook payloads).
- Process handles typed as `unknown` and narrowed.
- `noUncheckedIndexedAccess` is on.

### 4.4 Error Handling

- **Empty `catch` blocks forbidden.** Always: log + degrade, or rethrow, or fail the session gracefully.
- External calls (`fetch`, opencode spawn) have timeouts + try/catch.
- Opencode subprocess crashes are caught — the session is marked `errored` and the user gets a comment with the error.

### 4.5 Security

- **Webhook secret**: never logged, never in URLs. Constant-time HMAC compare.
- **Tokens**: never logged. `GITEA_TOKEN`/`BOT_TOKEN` are injected into opencode's env at spawn and never appear in `ps` (they are sibling-process env vars, not argv).
- **Workdirs**: opencode runs in `$OPENCODE_BASE_WORKDIR/<repo>/` which must be a trusted path. The daemon does not sandbox opencode.
- **Listening interface**: default `0.0.0.0` — bind `127.0.0.1` if you don't want LAN exposure.

### 4.6 Process Management

- **`forceStop`** uses `SIGKILL(9)` via `process.kill(-pid)` (negative pid = process group). This is intentional: opencode can spawn child processes that must also die.
- **No SIGTERM escalation yet.** If graceful shutdown is needed (e.g. for cleanup hooks), it must be added — current behavior is hard-kill.
- **SIGTERM/SIGINT handlers** in `src/index.ts:42-43` call `destroy()` on all sessions. systemd sends SIGTERM on `stop`.

### 4.7 Logging (Known Gap)

The daemon currently has **~112 `console.*` calls** scattered across the source. This is the biggest single OSS-readiness blocker for this project. P1 roadmap item: replace with a structured logger (`pino` likely) that emits JSON, supports log levels, and avoids leaking tokens or attachment contents.

Until then: be careful what you log. Never log `GITEA_TOKEN`, `BOT_TOKEN`, `GITEA_WEBHOOK_SECRET`, request bodies, or full env dumps.

---

## 5. Contributing

### 5.1 Before Making Changes

1. `bun run check` passes on `master`.
2. Read this document in full, especially §2.5 (Key Code Locations) and §4 (Code Change Guidelines).
3. For changes >1 file or architecture-affecting: write a design proposal in the issue first.

### 5.2 Development Workflow

1. Branch from `master`: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`.
2. Implement.
3. `bun run check` passes.
4. Smoke-test in test mode (`bun run dev` against `.env.test` + sandbox project).
5. Commit with Conventional Commits.
6. Push and open a PR against `master`. `master` is protected.
7. PR merge requires explicit human authorization.

### 5.3 Git Safety Rules (Mandatory)

| Rule | Enforcement |
| --- | --- |
| **NEVER force-push to `master`** | Create a PR instead. |
| **NEVER merge PRs without explicit human authorization** | "merge" must come from a human comment. |
| **NEVER delete branches or tags without human confirmation** | Preserve work for review. |
| **NEVER deploy without committing first** | `deploy.sh` rsyncs working tree; uncommitted = drift. |
| **NEVER restart while opencode processes are running** | Check `curl /api/processes` first. |

### 5.4 Commit Convention

Conventional Commits:

```
<type>(<scope>): <subject>

<body — explain why, not what>
```

`type` ∈ {`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`}.

**Do NOT use backticks in commit messages** — shells interpret them as command substitution.

### 5.5 Code Review

All source changes (`src/**`) require review before merge:

| Category | Check |
| --- | --- |
| Correctness | Queue invariants hold; off-by-ones in floor numbering; serialization per-issue. |
| Type safety | No `as any`, no `@ts-ignore`. Zod validation on inputs. |
| Process safety | No orphan processes; SIGKILL scope correct; stdin/stdout drained. |
| Anti-recursion | Bot-username check still triggers on `comment.user.login === BOT_USERNAME`. |
| Logging | No tokens, no attachment contents, no full env dumps. |
| Error handling | No empty catches; subprocess crashes mark session `errored`. |

---

## 6. Roadmap

| Priority | Item |
| --- | --- |
| P0 | Initial OSS baseline (LICENSE, AGENTS.md rewrite, CONTRIBUTING, SECURITY, CI, package.json metadata, URL scrub). **Done.** |
| P1 | Replace 112 `console.*` calls with structured logger (`pino`). |
| P1 | Remove legacy `plugin/` in-tree copy (canonical lives at `../opencode-ework/`). |
| P1 | Convert `scripts/test-{gitea,e2e}.ts` to `bun:test` format. |
| P1 | `/healthz` endpoint. |
| P1 | SIGTERM escalation for graceful opencode shutdown. |
| P2 | npm publish (deferred until ework-stack unified installer). |
| P2 | Second `IssueTracker` implementation (Plane.so / Linear) to validate abstraction. |

See `BUGS.md` for known issues and `references/issue-systems.md` for tracker-abstraction research.

---

## 7. Related Documentation

- `README.md` — User-facing install + usage.
- `DESIGN.md` — Architecture deep-dive.
- `BUGS.md` — Known bugs.
- `SKILL.md` — Legacy skill definition (may be removed).
- `references/issue-systems.md` — Multi-tracker research.
- `../ework/AGENTS.md` — ework-web (the Gitea-compatible shim this daemon targets).
- `../opencode-ework/AGENTS.md` — Plugin loaded by the opencode subprocess.

---

## 8. License

MIT — see [LICENSE](./LICENSE).
