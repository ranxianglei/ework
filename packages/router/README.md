# ework-router

Standalone webhook router for ework — receives events, routes to daemons by strategy, proxies replies.

## Architecture

```
Webhook Source ──POST──▸ ework-router ──route──▸ selected daemon
                                ▲                      │
                                │                      │
                          DB (MySQL)              daemon processes
                          coordination
```

The router is a **passive bidirectional proxy**:
- **Inbound**: receives webhooks (from web, Gitea, or third parties), queries coordination DB for active daemons, applies routing strategy, forwards to selected daemon.
- **Outbound**: receives replies from daemons (via `/reply`), proxies back to the original source.

## Deployment

- **Integrated mode** (default): deployed alongside ework-web via ework-aio. Router shares the same MySQL.
- **Standalone mode**: `npm install -g ework-router`, connect to the shared MySQL independently.

## Configuration (env vars)

| Env | Default | Description |
|-----|---------|-------------|
| `ROUTER_PORT` | 3102 | HTTP listen port |
| `ROUTER_HOST` | 0.0.0.0 | HTTP listen host |
| `ROUTER_ENV` | test | `test` or `production` |
| `WORK_DB_DRIVER` | sqlite | `sqlite` or `mysql` |
| `WORK_DB_HOST` | 127.0.0.1 | MySQL host |
| `WORK_DB_PORT` | 3306 | MySQL port |
| `WORK_DB_USER` | | MySQL user |
| `WORK_DB_PASSWORD` | | MySQL password |
| `WORK_DB_NAME` | ework | MySQL database |
| `WORK_DB_PREFIX` | | Table prefix (must match web's prefix) |
| `DAEMON_TABLE_PREFIX` | d_ | Daemon table prefix (convention: `${webPrefix}d_`) |
| `ROUTER_STRATEGY` | least-loaded | Default routing strategy |
| `ROUTER_STALE_THRESHOLD_MS` | 120000 | Daemon heartbeat stale threshold |
| `ROUTER_FORWARD_TIMEOUT_MS` | 30000 | Forward request timeout |

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/gitea` | Receive webhook, route to daemon |
| POST | `/reply` | Daemon reply proxy |
| GET | `/api/strategy` | Get current strategy config |
| POST | `/api/strategy` | Update strategy config (JSON body) |
| GET | `/api/health` | Health check |

## Routing Strategies

Configurable via `POST /api/strategy` with JSON:

```json
{
  "strategy": "least-loaded",
  "groupBindings": { "dog/repo": "group-a" },
  "daemonGroups": { "1": ["group-a"], "2": ["group-b"] },
  "weights": { "1": 3, "2": 1 }
}
```

| Strategy | Description |
|----------|-------------|
| `least-loaded` | Pick daemon with lowest `activeSessions/capacity` ratio (default) |
| `round-robin` | Cycle through daemons |
| `first-available` | Always pick first daemon |
| `group` | Project→group binding, then least-loaded within group |
