# Security Policy

## Supported Versions

Only the latest `master` is supported. There are no versioned releases yet.

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Instead, email the maintainer directly or open a **private** issue on Gitea (if you have access to restricted-issue creation). If neither option is available, open a regular issue with the title `Security: <high-level description>` and **no exploit details in the body** — maintainers will follow up privately.

Please include:

- ework version (`git rev-parse HEAD` if from source).
- Bun version.
- The route or endpoint affected.
- A minimal description of the issue.
- Steps to reproduce or proof-of-concept (privately, not in the public issue body).

You will receive an acknowledgement within 7 days. We will coordinate a fix and disclosure timeline with you.

## Scope

**In scope:**

- Authentication bypass (e.g., accessing routes without a valid cookie).
- Authorization bypass (e.g., non-admin reaching `/admin/*` or `/settings`).
- Path traversal in the file viewer.
- XSS via issue body / comment body / attachment metadata.
- SSRF via the translate / TTS / upstream-mirror endpoints.
- SQL injection in `store.ts` queries.
- Token leakage in logs, error messages, or webhook payloads.

**Out of scope:**

- Vulnerabilities in dependencies (marked, DOMPurify, etc.) — report upstream.
- DoS requiring authenticated access and ≥10 concurrent connections (we are a single-user / small-team tool).
- Bugs that require the attacker to already have admin access.
- Self-XSS (an admin pasting malicious content that only renders for themselves).

## Threat Model

ework is designed for a trusted small team (1-10 users). It runs on `127.0.0.1` by default and is exposed to a network only when the operator sets `WORK_HOST=::` or similar.

Trusted components:

- The operator (sets env vars, manages tokens).
- The filesystem (under configured `WORK_FILE_ROOTS`).
- The OpenCode DB (read-only access via `bun:sqlite`).

Untrusted inputs:

- **Issue and comment bodies** — markdown. Sanitized via `renderMarkdown` (DOMPurify).
- **File paths in the file viewer** — gated by `validatePath` (4-stage check: absolute, deny-regex, realpath, whitelist containment).
- **Webhook receiver URLs** — only reachable if an admin configures them; admin is trusted.
- **Upstream Gitea mirror URLs** — only configured by admin; admin is trusted.

The app does **not**:

- Run as a dedicated `ework` user (the systemd unit uses `User=ework`).
- Open sockets beyond the configured `WORK_PORT`.
- Make outbound requests except to: translate/TTS endpoints (admin-configured), upstream Gitea mirrors (admin-configured), webhook receivers (admin-configured).
- Persist tokens in logs (token-cookie is HMAC'd, never stored verbatim).

## Hardening Commitments

- No hardcoded internal URLs in source (e.g. loopback or RFC1918 private addresses).
- `console.*` calls do not log tokens, cookies, or attachment contents.
- File gate (`validatePath`) is the single chokepoint for all file reads.
- Markdown render (`renderMarkdown`) is the single chokepoint for all external markdown.

## Disclosure

We follow coordinated disclosure. Once a fix is available, we will publish an advisory on Gitea and credit the reporter (unless they prefer to remain anonymous).
