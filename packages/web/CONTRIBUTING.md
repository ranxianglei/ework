# Contributing to ework

Thanks for your interest in contributing! This is a short guide; the full development spec lives in [AGENTS.md](./AGENTS.md) and is the **highest-priority** document for this project. Read it first.

## Quick Start

```bash
git clone <your-fork-url>
cd ework
cp .env.example .env       # fill in WORK_TOKEN + WORK_COOKIE_SECRET
bun install
bun run check              # must pass before commit
bun run dev                # :3002 watch
```

Requires [Bun](https://bun.sh). Node.js is not supported — ework uses `Bun.serve`, `Bun.spawn`, and `bun:sqlite`.

## Workflow

1. Branch from `master` (`feat/`, `fix/`, or `docs/` prefix).
2. Make your changes. Run `bun run check` — must pass.
3. Smoke-test the affected route via curl. For UI changes, eyeball the page.
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
- **No hardcoded internal URLs** (loopback or RFC1918 private ranges). All external endpoints sourced from env or the `config` table.
- **No empty `catch` blocks.** Always log, rethrow, or degrade gracefully.
- **No backticks in commit messages.** They break deploy scripts that consume git log.
- **All external markdown through `renderMarkdown`.** It is the XSS boundary. No `innerHTML = userInput`.
- **All file reads through `validatePath`.** No exceptions, even for "trusted" internal endpoints.
- **Always commit before deploy.** `deploy.sh` rsyncs the working tree; uncommitted = drift.

## Deploying

See AGENTS.md §3.2. TL;DR:

```bash
# In dev dir
bun run check && git add -A && git commit -m "..."
./scripts/deploy.sh
# Inspect runtime impact (no running OpenCode processes etc), then:
sudo systemctl restart ework.service
```

## Testing

There is currently no automated test suite. P1 roadmap item: add `bun:test` tests for `store.ts`, `giteaApi.ts`, and `fileview.ts` (especially the security gate). Until then, smoke-test via curl per AGENTS.md §3.3.

For webhook-related changes, `scripts/webhook-receiver.ts` is a small Bun server that listens on a port and logs received payloads. Configure a webhook pointing at it, trigger the event, and verify the payload shape.

## Reporting Bugs

Open an issue on your Gitea instance (or whatever tracker your fork uses).

Include:

- ework version (`git rev-parse HEAD` if from source).
- Bun version (`bun --version`).
- The route or endpoint affected.
- The expected vs actual behavior.
- For UI bugs: a screenshot and the route URL.
- For shim bugs: the exact request (`curl -v …`) and response.

Do NOT include tokens, full env dumps, or attachment contents.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## License

By contributing, you agree your contributions are licensed MIT — see [LICENSE](./LICENSE).
