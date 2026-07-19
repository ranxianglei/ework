# Security Policy

## Supported Versions

Only the latest `master` is supported. There are no versioned releases yet.

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Instead, email the maintainer directly or open a **private** issue on Gitea (if you have access to restricted-issue creation). If neither option is available, open a regular issue with the title `Security: <high-level description>` and **no exploit details in the body** — maintainers will follow up privately.

Please include:

- ework-daemon version (`git rev-parse HEAD` if from source).
- Bun version.
- OpenCode version.
- Whether using ework-web or real Gitea as the backend.
- A minimal description of the issue.
- Steps to reproduce or proof-of-concept (privately, not in the public issue body).

You will receive an acknowledgement within 7 days. We will coordinate a fix and disclosure timeline with you.

## Scope

**In scope:**

- Webhook signature verification bypass (accepting a webhook without a valid HMAC).
- Webhook replay attacks (the daemon should be idempotent on `(issueId, commentId, createdAt)`).
- Anti-recursion bypass (the daemon replying to its own bot comments, creating an infinite loop).
- Token leakage via `console.*` logging.
- Token leakage via the opencode subprocess's `ps` visibility (env vars vs argv).
- SSRF via `GITEA_URL` or `OPENCODE_BASE_WORKDIR`.
- Path traversal in large-content handler (`handleLargeContent` writing outside workdir).
- SQL injection in `op.ts` queries.

**Out of scope:**

- Vulnerabilities in the OpenCode subprocess itself — report to [opencode](https://github.com/sst/opencode).
- Vulnerabilities in the backend (ework-web / real Gitea) — report to those projects.
- DoS via the daemon spawning many opencode processes (the queue + WAL DB mitigate this; it's a single-operator tool).
- Attacks requiring the attacker to already have `DAEMON_ENV=production` env access (the operator is trusted).
- Opencode subprocess misbehavior (file writes, network) — opencode sandboxing is out of scope for this daemon.

## Threat Model

ework-daemon is designed to run on a trusted single-operator machine (`127.0.0.1` or LAN). It listens on `0.0.0.0:3101` by default, so the operator is responsible for firewalling if exposed.

Trusted components:

- The operator (sets env vars, manages tokens).
- The backend (ework-web or real Gitea — admin-configured).
- The filesystem under `OPENCODE_BASE_WORKDIR`.

Untrusted inputs:

- **Webhook payloads** — verified via HMAC-SHA256 with `GITEA_WEBHOOK_SECRET`. Constant-time compare.
- **Opencode stdout/stderr** — captured to DB. Treated as opaque text; not interpreted as code.
- **Issue/comment bodies** — read from the backend; passed verbatim to opencode via stdin (large ones stored in `workdir/.ework-daemon/comment-NNN.txt`).

The daemon does **not**:

- Run as root (systemd unit uses `User=dog`).
- Make outbound requests except to: the configured `GITEA_URL` (REST reads/writes) and the OpenCode subprocess (stdin/stdout pipes).
- Persist webhook secrets or tokens in the DB — only in `.env` (env vars).
- Render HTML or markdown itself.

## Hardening Commitments

- No hardcoded internal URLs in source (e.g. `192.168.x.x`) — all from env.
- Webhook signature verification is mandatory; missing or mismatched signature = drop.
- `BOT_USERNAME` must match `BOT_TOKEN`'s user — anti-recursion check is on this exact match.
- Tokens injected into opencode's env (not argv) — hidden from `ps -ef`.
- ~112 `console.*` calls exist (known gap, P1 to replace with `pino`). Until then: contributors MUST NOT add new `console.*` calls that log tokens, secrets, webhook payloads, or attachment contents.

## Disclosure

We follow coordinated disclosure. Once a fix is available, we will publish an advisory on Gitea and credit the reporter (unless they prefer to remain anonymous).
