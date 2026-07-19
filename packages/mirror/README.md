# ework-mirror

One-way webhook mirror: **ework → Gitea**.

Receives [ework-web](https://github.com/your-org/ework-web) issue/comment events on `POST /ingest/ework` and creates corresponding issues/comments in a target Gitea instance using a token that authenticates as user `awork`.

## Why

During the transition period off Gitea, ework-web remains the source of truth but Gitea stays in sync as a hot backup. Real-user actions mirror to Gitea so:

- Awork daemon (still pointed at Gitea) keeps working unchanged.
- Gitea is a verification / rollback target.
- Downstream Gitea consumers (webhooks, OAuth clients) work without modification.

## Loop suppression

The mirror authenticates to Gitea as user `awork`. Because awork daemon's
`isBotUser()` check (`awork/src/trackers/gitea-tracker.ts:178`) ignores any
comment authored by its own bot username, every mirrored POST to Gitea emits a
Gitea webhook carrying `sender.login = "awork"` — which awork silently drops.
No code change to awork required.

The receiver also skips events where `sender.login == "awork"` (echoes from
Gitea-side awork actions would otherwise bounce back).

## Install

```bash
./scripts/install.sh \
  --gitea-url http://gitea.local:3000 \
  --gitea-token <awork-user-token> \
  # optional: --port 1197 --host 127.0.0.1
```

Idempotent. Generates `~/.local/share/ework-mirror/.env` with a random
`EWORK_WEBHOOK_SECRET`. Installs a `--user` systemd unit by default.

## Wire ework-web to deliver events

In ework-web UI (`/<owner>/<repo>/webhooks`), add a webhook:

| Field | Value |
|-------|-------|
| URL | `http://127.0.0.1:1197/ingest/ework` |
| Secret | (the `EWORK_WEBHOOK_SECRET` from `.env`) |
| Events | `issues`, `issue_comment` |
| Active | ✓ |

## Operate

```bash
./scripts/install.sh status         # service status
./scripts/install.sh logs           # tail logs
./scripts/install.sh uninstall      # stop + remove unit (data preserved)
```

Event log is queryable in `~/.local/share/ework-mirror/mirror.db`:

```sql
SELECT received_at, event, action, ework_project, ework_issue, gitea_target, outcome
FROM event_log ORDER BY id DESC LIMIT 20;
```

## Scope (v0.1)

- ✅ Mirror `issues` (opened/closed/reopened) — first-seen creates Gitea issue, subsequent events patch state
- ✅ Mirror `issue_comment` (created) — creates Gitea comment; idempotent on `ework_comment_id`
- ✅ HMAC-SHA256 signature verification (Gitea / Gogs / GitHub-compat headers)
- ✅ Duplicate suppression via SQLite `issue_map` + `comment_map`
- ✅ Retroactive mirror (if comment arrives before issue create, issue is auto-created)
- ⏸️ Edits / deletes not mirrored (rare; out of scope)
- ⏸️ Attachments not mirrored (separate concern)
- ⏸️ Gitea → ework mirror (not implemented; single-direction by design)

## Config keys

| Env | Required | Default | Purpose |
|-----|----------|---------|---------|
| `PORT` | no | `1197` | Listen port |
| `HOST` | no | `127.0.0.1` | Bind address |
| `EWORK_WEBHOOK_SECRET` | yes (auto-gen) | — | HMAC secret shared with ework-web |
| `GITEA_URL` | yes | — | Target Gitea base URL |
| `GITEA_TOKEN` | yes | — | Token for user `awork` (scopes: `write:issue`, `write:repository`) |
| `GITEA_ACT_AS` | no | `awork` | Identity for POSTs — must be `awork` for loop suppression |
| `DB_PATH` | no | `~/.local/share/ework-mirror/mirror.db` | SQLite path |
| `VERBOSE` | no | `false` | Log every event at info level |
