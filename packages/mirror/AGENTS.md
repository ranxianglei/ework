# ework-mirror Development Specification

> Highest-priority spec for this repo. Where docs and code disagree, code wins — then update this doc.

## What this is
One-way local→GitHub write-back bridge: receives webhooks from ework-web (`/ingest/ework`), maps local issues/comments to upstream GitHub via its own sqlite id maps, posts agent replies upstream with badge footer, mirrors emojis as 🚀 reactions on trigger comments, and scrubs internal references before anything leaves.

## Commands
- `bun run check` — tsc, must be clean
- `bun test` — 17 tests (badge/scrubber/echo-guard)
- `bun run start` — listens on `PORT` (default 1198 on VM), runs standalone via `bun src/index.ts`

## Layout map
- `src/index.ts` — HTTP ingest server + webhook verification
- `src/ework.ts` — inbound payload parser (issue/comment events, `action` created|edited)
- `src/giteaClient.ts` — upstream REST client (issue/comment CRUD, `addReaction`, `editComment`); GitHub vs Gitea targets branch on base URL
- `src/mirror.ts` — orchestration: id maps, echo suppression (`OUTCOME_SKIPPED_SELF`), [system] skip + anchor-based reactions (`<!-- upstream-comment: N -->`), badge rewrite on edited events
- `src/db.ts` — sqlite id maps (`issue_map`, `comment_map`, `reacted_upstream`)
- `src/scrub.ts` — the outbound scrubber: RFC1918 IPv4 + IPv6 ULA/link-local → placeholders. **Every outbound body MUST pass through `scrubInternalRefs`.**

## Conventions
- Loop suppression is sacred: upstream-sync markers, self-author skips, reacted_upstream dedup. Any new outbound path must check all three or you create echo storms.
- Badge format: `> 🤖 ework agent · <shortModelName>` + `<!-- ework-mirror -->` footer on every agent comment.
- Anchor regex and web's `upstreamAckSuffix` must stay in sync (they are the same contract from both ends).

## Danger zones
- Scrubber patterns must match FULL addresses (4-octet IPv4, full ULA) — partial patterns leak fragments.
- Mirror has NO web API credentials; it only reacts to what arrives via hooks. Model names arrive in payloads, never fetched.

## Publish flow
`npm version patch --no-git-tag-version` → check+test → `NPM_ALLOW_DANGEROUS=1 npm publish` → commit `chore: bump` → push `github main:master`.
