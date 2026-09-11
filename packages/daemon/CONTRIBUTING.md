# Contributing to ework-daemon

Thanks for your interest in contributing! This is a short guide; the full development spec lives in [AGENTS.md](./AGENTS.md) and is the **highest-priority** document for this project. Read it first.

## Quick Start

```bash
git clone https://github.com/ranxianglei/ework-daemon.git
cd ework-daemon
cp .env.example .env.test       # fill in tokens + sandbox project URLs
bun install
bun run check                   # must pass before commit
bun run dev                     # watch mode against .env.test
```

Requires [Bun](https://bun.sh). Node.js is not supported — ework-daemon uses `Bun.serve`, `Bun.spawn`, and `bun:sqlite`.

You'll also need:

- [OpenCode](https://github.com/sst/opencode) binary on `PATH` (or set `OPENCODE_BINARY`).
- A running [ework-web](../ework) instance (or real Gitea) to point the daemon at.
- A bot user PAT on that instance with comment/write permissions.

## Workflow

1. Branch from `master` (`feat/`, `fix/`, or `docs/` prefix).
2. Make your changes. Run `bun run check` — must pass.
3. Smoke-test in test mode against a sandbox project (see AGENTS.md §3.2).
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add <thing>
   fix: handle <case>
   docs: clarify <topic>
   ```
5. Push and open a PR against `master`.

## Rules

- **`master` is protected.** No direct pushes. All changes go through PR.
- **PR merge requires explicit human authorization.** Passing agent reviews is not the same as authorization to merge.
- **No `as any`, `@ts-ignore`, or `@ts-expect-error`.** See AGENTS.md §4.3.
- **No hardcoded internal URLs** (`192.168.x.x`). All endpoints sourced from env.
- **No empty `catch` blocks.** Always log, rethrow, or degrade gracefully.
- **No backticks in commit messages.** They break deploy scripts that consume git log.
- **Never spawn opencode bypassing the queue** — same-issue concurrent sessions corrupt state.
- **Never log tokens, secrets, or full env dumps.** ~112 `console.*` calls remain; do not add more.
- **Always commit before deploy.** `deploy.sh` rsyncs the working tree; uncommitted = drift.
- **Never `systemctl restart` while opencode processes are running.** Check `curl /api/processes` first.

## Deploying

See AGENTS.md §3.3. TL;DR:

```bash
# In dev dir
bun run check && git add -A && git commit -m "..."
./scripts/deploy.sh

# Inspect runtime impact first
curl -s http://localhost:3101/api/processes
# empty array → safe to restart:
sudo systemctl restart ework-daemon.service
```

## Testing

There is no formal `bun test` suite yet. P1 roadmap item: convert `scripts/test-gitea.ts` and `scripts/test-e2e.ts` to `bun:test` format with stubs.

Until then, smoke-test workflow (see AGENTS.md §3.2):

1. `.env.test` points at a sandbox project on a running ework-web (or Gitea) instance.
2. `bun run dev`.
3. Create a sandbox issue (via UI or curl).
4. Verify the daemon picks it up: `curl http://localhost:3101/api/processes`.
5. Verify the bot replies on the issue.

## Reporting Bugs

Open an issue on Gitea: https://github.com/ranxianglei/ework-daemon/issues

Include:

- ework-daemon version (`git rev-parse HEAD` if from source).
- Bun version.
- OpenCode version.
- Whether you're using ework-web or real Gitea as the backend.
- The relevant `~/.local/share/ework-daemon/` DB row or log excerpt (sanitize tokens!).
- The webhook payload (if relevant — sanitize the `X-Gitea-Signature` header).

Do NOT include tokens, full env dumps, or private attachment contents.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## License

By contributing, you agree your contributions are licensed MIT — see [LICENSE](./LICENSE).
