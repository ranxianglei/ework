# ework ecosystem — TODO & gap log

Scope: **ework** (tracker) + **ework-daemon** (daemon). Frozen snapshot of the project audit. Not a sprint plan — items are deferred until they bite or until pre-prod hardening.

The bar for "complete issue system": *a human can fully triage and discuss issues from the web UI alone, AND the daemon sees every state mutation*. Two `yes` = complete.

---

## P0 — survival / correctness (do before more features)

### 1. Daemon concurrent session limit + per-issue cost ceiling
- **Where**: `ework-daemon/src/opencode.ts` (engine schedules one opencode process per open issue)
- **Effort**: Medium, 1–2d
- **Why**: every open issue spawns an independent opencode process; a burst of filings = OOM + LLM rate-limit ban + bill shock. The only item on this list that can take the whole system down.
- **Fix sketch**: global semaphore (e.g. `p-limit` or hand-rolled `Promise` queue) capping concurrent sessions (start with N=2); per-issue turn/token ceiling enforced in the prompt loop; queue overflow returns "busy, retry later" instead of crashing.

### 2. Webhook parity for `comment.edit`, `comment.delete`, `issue.edit`, `reaction.added/removed`
- **Where**: `ework/src/webhooks.ts` emit sites; `ework/src/giteaApi.ts` PATCH/DELETE routes
- **Effort**: Short, 2–4h
- **Why**: concrete failure mode — user files issue → daemon picks it up → user EDITS the issue body to add "actually don't touch X" → daemon never sees the edit → opencode keeps working against stale context. Currently `PATCH /repos/{o}/{r}/issues/{n}` only emits on state flip (close/reopen), and PATCH/DELETE on `/issues/comments/{id}` emit nothing.
- **Fix sketch**: emit `issues.edited` on any title/body change; emit `issue_comment.edited` / `issue_comment.deleted` from the comment PATCH/DELETE handlers; emit `issue_comment.reaction_added` / `reaction_removed` from the reactions POST/DELETE. All five are ~10-line additions around existing `emitWebhook` calls.

### 3. Transactional webhook emission (outbox pattern)
- **Where**: `ework/src/webhooks.ts`, new `webhook_outbox` table + dispatcher loop
- **Effort**: Medium, 1–2d (verify first; only build if verify fails)
- **Why**: if `emitWebhook()` runs post-DB-commit and the process dies between commit and HTTP dispatch, the daemon will never see the mutation. Silent unrecoverable divergence.
- **Verify first**: check whether webhooks already dispatch through an outbox table or fire inline. If inline (current best guess), this is top-3.
- **Fix sketch**: on every mutation, INSERT row into `webhook_outbox(event_type, payload, created_at, attempts)` in the SAME transaction as the data change. A background loop (setInterval or systemd-timed) drains the outbox with retry/backoff. Daemon reconciles via delivery ID idempotency.

### 4. DOM cap on long issue threads
- **Where**: `ework/src/static/app.js` (renderer grows unbounded with "load more" + live-poll)
- **Effort**: Short, 2–4h
- **Why**: This project exists *because* Gitea's web UI chokes on 10k-comment threads. Daemon-driven trackers grow faster than human-driven ones — each user turn produces a multi-paragraph bot reply + a `[system]` status line. Without a cap we will re-create the original sin within weeks.
- **Fix sketch**: keep only the most recent N (≈500) rendered comments in the DOM; on scroll-up, lazy-load older batches the same way "load more" does today. NOT full virtual scrolling (the 90/10 fix).

### 5. Bot PAT leakage audit in opencode error paths
- **Where**: `ework-daemon/src/opencode.ts` → tracker.createComment on error
- **Effort**: Quick, <1h
- **Why**: when opencode fails, daemon convention is to post the error/stack as a `[system]` comment for transparency. If that stack contains env vars (incl. `BOT_TOKEN` / `Authorization` headers from a failed HTTP tool call), the token leaks into the visible thread.
- **Fix sketch**: add a redaction filter applied to every daemon→shim POST body. Patterns: `/[A-Z0-9]{40,}/g` (covers Gitea PAT format), `/(?:Authorization|Bearer):\s*\S+/gi`, plus a final `replace(process.env[key], "***")` sweep. Cheap; missing it is catastrophic.

---

## P1 — feature completeness (closes the bar)

### 6. Comment edit / delete UI
- **Where**: `ework/src/views/issueThread.ts` + new route in `ework/src/index.ts`
- **Effort**: Medium, 1d
- **Why**: API supports PATCH/DELETE `/repos/{o}/{r}/issues/comments/{id}` but the web UI has no affordance. Closing this + webhook parity (#2) reaches the "complete issue system" bar.

### 7. Labels UI
- **Where**: `ework/src/views/issueList.ts` + `ework/src/views/issueThread.ts`
- **Effort**: Short, 2–4h
- **Why**: store has `listLabels` / `createLabel` / `setIssueLabel` ready; no HTTP shim route, no UI. Label CRUD is parity with Gitea-issues.

### 8. Assignees schema + UI
- **Where**: `ework/src/schema.sql` + store + view
- **Effort**: Medium, 1d
- **Why**: Gitea issues have assignees; ework schema does not. Not flagged in the original audit. Parity gap.

---

## P2 — pre-production hardening (before multi-user)

### 9. Webhook delivery ordering
- **Failure**: user comments then edits within 100ms; parallel dispatcher may deliver edit-before-create; daemon can't apply edit to a not-yet-created comment.
- **Fix**: serialize per-issue-key dispatch (single dispatcher reading from outbox ordered by `created_at`, per `scopeKey+issueId`).

### 10. Daemon-side idempotency on comment POST
- **Failure**: daemon crashes mid-reply → recovery re-runs → double post.
- **Fix**: shim accepts `X-Idempotency-Key` header on POST comment; dedupe within a 5-min window.

### 11. opencode "stuck-but-running" wall-clock timeout
- **Failure**: SIGTERM handles crashed processes, not 6h-hung-on-tool-call processes.
- **Fix**: per-session wall-clock limit (e.g. 30min hard, configurable); force-kill + emit `[system] timeout` comment on breach.

### 12. Backpressure on webhook POST
- **Failure**: daemon's webhook receiver is slow/down → shim's POST blocks the user HTTP request.
- **Verify**: check whether shim's webhook dispatcher is already fire-and-forget (verify non-blocking dispatch is in place).
- **Fix**: outbox dispatcher already solves this (#3).

### 13. Attachment orphan cleanup
- **Failure**: issue/comment delete doesn't remove attachment rows or filesystem blobs → disk grows silently.
- **Fix**: on issue/comment DELETE, soft-mark attachments `orphaned=true`; nightly cron deletes files + rows after grace period.

### 14. Comment soft-delete vs hard-delete
- **Failure**: hard delete today; daemon transcript references ghost comment IDs.
- **Fix**: tombstone rows (`deleted_at`, body replaced with `[deleted]`) OR document the race + accept it.

### 15. SQLite WAL + busy_timeout
- **Failure**: concurrent writes from daemon POST + user edit + reaction → `SQLITE_BUSY` leaks to users as 500s.
- **Fix**: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` on every connection.

### 16. Webhook URL SSRF guard
- **Failure**: admin can configure webhook target pointing at `http://169.254.169.254/` (cloud metadata) or `http://localhost:5432` (internal services).
- **Fix**: denylist link-local, loopback, private ranges on webhook URL validation (allow override via `WORK_WEBHOOK_ALLOW_PRIVATE` for local-only dev).

### 17. HMAC constant-time compare
- **Where**: `ework-daemon/src/server.ts` webhook signature verification (if present)
- **Fix**: replace `===` with `crypto.timingSafeEqual`. 30-second grep-check.

### 18. Attachment content-type XSS hardening
- **Failure**: HTML/SVG uploaded + served inline = stored XSS.
- **Verify**: current code already forces `Content-Disposition: attachment` for non-image types — verify SVG is in the "non-image" set (it often isn't).
- **Fix**: explicit denylist `image/svg+xml` from inline serving; add `Content-Security-Policy: default-src 'none'` to `/attachments/*` responses.

### 19. `/healthz` endpoint + systemd watchdog
- **Where**: `ework/src/index.ts`, both systemd unit files
- **Fix**: add `GET /healthz` returning `{ok:true, db:open|closed}`; set `WatchdogSec=` in unit + notify via `sd_notify`.

### 20. Metrics endpoint
- **Where**: new `ework/src/metrics.ts`
- **Fix**: Prometheus text format at `GET /metrics` — counters for `webhooks_dispatched_total`, `webhooks_failed_total`, `opencode_sessions_active`, histogram for `db_query_seconds`. Without this "is it slow?" is unanswerable.

### 21. SQLite backup strategy
- **Failure**: single file, single host, one `rm` from total loss.
- **Fix**: either `cron` job running `.backup` to a second drive nightly, or litestream replication to S3-compatible storage.

---

## Explicitly deferred (do not gold-plate)

These appear in a Gitea parity matrix but are out of scope for ework's use case:

- **Milestones** — no planning workflow exists yet
- **Releases** — ework is not a git host
- **Subscriptions / watchers** — daemon is the only subscriber; hardcoded `watchers_count:1` is correct
- **Issue-level reactions** — comment reactions cover 95%; the `[]` stub is honest
- **Audit log table** — small user base makes it theatre for now
- **Cross-project dashboard** — UX sugar; the global `/issues` feed suffices
- **PAT scopes enforcement** — single bot user; column exists, not enforced, OK for now
- **POST reaction returning 200 vs 201** — cosmetic, Gitea itself is inconsistent here
- **Full virtual scrolling** — DOM cap (#4) gets 90% of the benefit at 10% of the complexity
- **Migration tool from Gitea** — fresh start is fine; can be added when needed

---

## Suggested sequencing

- **P0 (≈1 week)**: #1 (concurrency) → #2 (webhook parity) → verify #3 (outbox, free verify) → #5 (PAT redaction, cheapest)
- **P1 (next iteration)**: #4 (DOM cap) + #6 (comment edit/delete UI) + #7 (labels UI) → reaches "complete issue system" bar
- **P2 (pre-prod)**: security audit (#16–18) + observability (#19–20) + backup (#21) + remaining races (#9–12, #14, #15)
