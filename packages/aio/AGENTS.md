# ework-aio Development Specification

> Highest-priority spec for this repo. Where docs and code disagree, code wins — then update this doc.

## What this is
Installer + version pinner + E2E harness for the ework fleet. `ework-aio install` deploys web/router/daemon as systemd services from npm pins; the lockfile IS the deployment contract.

## Commands
- `bun run check` — tsc, must be clean
- `bun test` — unit tests
- `bun run test:e2e` — full install E2E (needs Docker; ~20 min)
- `bun run test:regression` — regression container suite

## Layout map
- `bin/ework-aio` — CLI entry (install/upgrade/status)
- `src/` — installer logic, env templating, systemd unit generation
- `scripts/e2e-install.sh` — the real E2E (8+ phases, hardened against vacuous passes — never soften an assertion to `|| true`)
- `scripts/e2e-router.sh` — router-focused E2E (9 phases)
- `templates/` — extractable patterns (AGENTS.md seeds, ufw rules, credhelper, systemd units)

## Conventions
- **Lockfile discipline**: after any fleet package publish, `npm pkg set dependencies.<pkg>=^X.Y.Z` + `npm install --package-lock-only --prefer-online`, then VERIFY the lock pins the exact version BEFORE version+publish. npm cache and registry lag have shipped stale locks repeatedly.
- Publish ONLY from this checkout on master (never from stale worktrees).
- Version bumps: patch for pin updates, minor for new installer features.

## Danger zones
- The installer writes systemd units + env files as root; never widen file modes on secrets.
- E2E scripts are the fleet's regression net — deleting/weakening a phase to make CI pass is forbidden.

## Publish flow
`npm version patch --no-git-tag-version` → check+test → `NPM_ALLOW_DANGEROUS=1 npm publish` → commit `chore: bump` → push `github master`.
