# ework-router Development Specification

> Highest-priority spec for this repo. Where docs and code disagree, code wins — then update this doc.

## What this is
Single-binary webhook fan-out service: receives Gitea-format webhooks from ework-web, forwards to a chosen daemon per routing strategy (least-loaded / round-robin / group). Also exposes `GET /api/daemons` (live registry read) and admin config via `x-ework-token` header.

## Commands
- `bun run check` — tsc, must be clean
- `bun test` — unit tests for strategy selection
- `bun run start` — listens on `PORT` (default 3104)

## Layout map
- `src/index.ts` — HTTP server: `/webhook/gitea` (verify secret → pick target → forward, attaches `x-ework-group-config` header), `/api/daemons` registry, admin routes
- `src/strategy.ts` — routing strategies + `GroupConfig` (baseWorkdir templates, init/destroy scripts); selection is pure and unit-tested
- `src/db.ts` — READ-ONLY access to the daemon DB for load stats. The router has NO database of its own.

## Conventions
- Router is stateless besides the registry read; all durable state lives in web/daemon DBs.
- Heartbeat freshness: daemons write ISO timestamps; stale threshold 120s. Format mismatches here have silently broken failover before — never parse dates loosely.
- Never add write paths to daemon DB from the router.

## Danger zones
- The group-config header carries scripts to daemons — treat as sensitive; never log full contents.
- Webhook forwarding must preserve original payload bytes + add headers only.

## Publish flow
`npm version patch --no-git-tag-version` → check+test → `NPM_ALLOW_DANGEROUS=1 npm publish` → commit `chore: bump` → push `github master`.
