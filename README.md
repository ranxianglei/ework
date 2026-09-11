# ework

Self-hosted AI development fleet: issue-driven agents that work your repositories.

Monorepo (bun workspaces). npm packages are still published individually:

| Package | What it is |
|---|---|
| `packages/aio` | Installer + version pinner + E2E harness — deploys the fleet as systemd services |
| `packages/web` | Web console: projects, issues, sessions, translation, webhooks |
| `packages/daemon` | Agent engine: dispatch, wake policy, workdirs, status badges |
| `packages/router` | Multi-daemon webhook router (least-loaded / groups) |
| `packages/mirror` | Two-way GitHub ↔ self-hosted sync with scrubbing |
| `packages/qq-bridge` | QQ group ↔ issue bridge (NapCat/OneBot11) |
| `packages/chat` | Chat frontend for the model server (bili tools) |

## Development

```
bun install          # links all workspaces
cd packages/web && bun run test
```

Releases: per-package `npm version patch` + `npm publish` from this checkout on master. `ework-aio` pins exact fleet versions in its lockfile and is the deployment contract.
