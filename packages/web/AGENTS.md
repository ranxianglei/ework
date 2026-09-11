# ework-web Development Specification

> Highest-priority spec for this repo. Where docs and code disagree, code wins — then update this doc.

## What this is
The web platform of the ework fleet: issue tracking + webhook fan-out + config center.
**Architecture law: the web is a pure message bus + config center.** It fans out ALL events to hooks and reports state; it never filters on behalf of consumers (daemons judge wake policy themselves via payload fields). Daemon-visible state goes through `GET /api/v1/dispatch-state`.

## Commands
- `bun run check` — tsc, must be clean (strict, exactOptionalPropertyTypes)
- `bun test` — 180 tests, must be 0 fail
- `bun run dev` — local dev server (needs `.env`)

## Layout map
- `src/index.ts` — ALL HTTP routes (route regexes at top, then handlers; admin routes need session auth, `/api/v1/*` serves daemons with PAT/token auth)
- `src/store.ts` — every SQL query (table prefix via `{{table}}` interpolation; schema in `src/db.ts` migrations + `schema-mysql.sql`)
- `src/webhooks.ts` — payload builders + `emitIssueEvent`/`emitCommentEvent` fan-out (payload carries dispatch_off, ai_status, author_kind, upstream_comment_id, model)
- `src/giteaApi.ts` — REST shim to Gitea (supports Sudo headers, PAT auth)
- `src/render/` — server-rendered HTML (layout.ts = issue page + LayoutProps; CSP forbids inline JS → all behavior in `/static/*.js` with `data-*` attributes)
- `src/views/` — page builders (issueNew, issueThread, settings, projectAi, projectLabels…)
- `src/coordination.ts` — cross-DB daemon queries + `tryAllDaemons` session-link fallback
- `src/upstream-sync.ts` — one-way GitHub→local poller (provenance marker `<!-- upstream-sync -->`, anti-twin via `linkIssueToUpstream`)

## Conventions
- SQLite (default) and MySQL (split-DB, prefix + table name) both supported — never assume raw table names in app code, always `{{prefix}}` via store.
- Status writes to `issues.ai_status`: "" = idle (cleared on completion), "processing" set on every exec, "completed" only on issue close or capped run, "halted"/"dispatch_off" are user controls.
- Per-project config lives in `config` KV table: `wakeLogins:<o>/<r>`, `concurrency:<o>/<r>`, `sessionReset:<o>/<r>#<n>`.
- Comments may carry machine markers (upstream-sync, upstream-comment anchors). Never strip them in transforms.

## Danger zones
- `webhooks.ts` emit paths: every new event field must flow to BOTH issue and comment payloads or daemons desync.
- Cookie names are deployment-specific (`WORK_COOKIE_NAME`) — host and VM webs coexist; never hardcode `ework_auth`.
- Test DBs are file-backed under `tests/` tmp dirs; never point tests at prod DBs.

## Publish flow
`npm version patch --no-git-tag-version` → check+test → `NPM_ALLOW_DANGEROUS=1 npm publish` → commit `chore: bump` → push `github echo-fix:master` (worktree branch, NOT `release`).
