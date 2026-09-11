# ework-daemon REST API Reference

Base URL: `http://localhost:3101` (configurable via `DAEMON_PORT`)

No authentication required (localhost only).

## Endpoints

### GET /api/status

Daemon overview.

Response:
```json
{
  "daemon": { "host": "0.0.0.0", "port": 3101 },
  "gitea": "https://gitea.example.com",
  "running": 2,
  "pending": 1,
  "processes": 2,
  "totalOps": 8
}
```

### GET /api/ops

List all ops with runtime details.

Response: array of op objects with fields:
- `id`, `name`, `owner`, `repo`, `issueNumber`
- `status` — `"starting"` | `"active"` | `"idle"` | `"closed"`
- `workdir` — workspace path (null = default)
- `opencodeSessionId`, `pid`, `lastOutputAt`
- `isRunning`, `queueDepth`

### GET /api/ops/:id

Single op details.

### PATCH /api/ops/:id

Update an op. Allowed fields: `workdir`, `status`.

```bash
curl -X PATCH http://localhost:3101/api/ops/<id> \
  -H "Content-Type: application/json" \
  -d '{"workdir": "/home/<user>/projects/my-project"}'
```

### DELETE /api/ops/:id

Kill process and close op.

### GET /api/repos/:owner/:repo/issues/:number/ops

List ops for a specific issue.

### GET /api/queue

Pending prompt queues: `{ "owner/repo#issue@name": depth }`

### GET /api/processes

Running processes: `[{ key, pid, lastOutputAt }]`
