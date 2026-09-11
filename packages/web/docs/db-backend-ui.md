# DB Backend UI — Design Spec

> Branch: `feat/db-backend-ui` (off master `03a6b0c`, ework-web 0.3.0).
> Status: approved 总体设计 (awork#53), this is the concrete spec before impl.
> Scope: let the admin switch the ework-web DB from sqlite to MySQL **via the web UI**, with data migration + restart. Same-machine daemon config as a follow-up section.

---

## 1. Goal

Default install stays **sqlite** (zero-config, works out of the box). The admin can then open `/settings`, configure a MySQL backend (connection params + connectivity test), migrate the existing sqlite data, and "enable" — which rewrites `.env` and restarts the web process onto MySQL.

The "second half of installation" happens in the web UI, not by hand-editing `.env`.

## 2. Hard constraints (from discussion)

1. **DB driver is process-lifetime.** `initDB()` (`src/db.ts:309`) reads `WORK_DB_DRIVER` from env at boot, opens the connection pool, holds it for the whole process. **Cannot hot-swap.** Switching = write new `.env` → **restart the web process**. The browser tab stays open; the server reboots (~seconds downtime); refresh → MySQL-backed.
2. **Driver ≠ config-table setting.** Existing `/settings` writes to the `{{config}}` DB table (`setConfig`, runtime-overridable). The driver **cannot** live there (chicken-and-egg: you need the driver to read the config table). Driver config goes to `.env`. → DB-backend section needs its **own endpoints**, separate from the `/settings` POST loop.
3. **Migration is mandatory, not optional.** Switching to an empty MySQL loses all sqlite data (users/projects/issues/comments/…). "Switch" = copy all 13 tables sqlite→mysql, verify row counts, then flip.
4. **Recovery is one-way.** If MySQL breaks after the switch, the web process won't boot → UI is down → must hand-edit `.env` to recover. Document this; keep `.env` editing as the escape hatch.

## 3. UX flow (the "migration wizard")

`/settings` gets a new **"数据库后端"** section (separate from the existing config-table sections). States:

```
[show current state]
  当前后端: SQLite  (或 MySQL)
  数据量:   13 张表, 共 N 行
  连接:     /path/to/ework.db  (或 mysql://host:port/db)

[if sqlite — show "迁移到 MySQL" 按钮]
  ↓ click
  Step 1 — 填连接参数:
    host / port(3306) / user / password / database / prefix(可选)
    [测试连接]  → POST /api/db/test  → 返回 OK / 错误明细(连不上/无建表权限/...)
  Step 2 — 测试通过后:
    [迁移数据并启用]  ← 警告: "启用后将重启服务切换到 MySQL, 几秒下线; 确保 MySQL 长期可用"
    ↓ click (二次确认)
    POST /api/db/migrate  → 后台 job: 建表 + 复制全表 + 校验行数
    POST /api/db/enable   → 写 .env + 触发重启
  Step 3 — 重启后刷新 → 显示 "当前后端: MySQL"
```

Key UX rules:
- **Configure ≠ enable.** Filling params + testing does NOT change the running system. Only "migrate + enable" commits.
- **Migrate and enable in one flow** (no long gap) — avoids losing incremental sqlite writes between migrate and enable.
- **Warning + double-confirm** before enable (irreversible-ish; recovery = hand-edit `.env`).
- **"切回 SQLite"** button appears once on MySQL (reverse migration, same wizard reversed) — safety net.

## 4. Backend components (ework-web)

### 4.1 New module: `src/db-admin.ts`

Pure logic, testable, no HTTP. Owns the migration + test + enable steps.

```ts
// Probe a MySQL target WITHOUT touching the running sqlite driver.
// Opens a throwaway mysql2 pool, checks: reachable, auth ok, CREATE privilege,
// database exists (or can be created). Does NOT create tables. Closes pool.
export async function testMysqlConnection(opts: MysqlTargetOpts): Promise<
  { ok: true; serverVersion: string; databaseExists: boolean } |
  { ok: false; error: string; hint?: string }
>;

// Migrate sqlite → mysql. Opens a throwaway mysql pool (NOT the running driver),
// runs schema-mysql.sql (prefixed), then copies every table row-by-row in a
// single mysql transaction. Verifies per-table row count matches sqlite source.
// On any failure: ROLLBACK, drop the half-built tables, return error.
// Does NOT touch .env or the running process — caller decides whether to enable.
export async function migrateSqliteToMysql(opts: MysqlTargetOpts): Promise<
  { ok: true; tables: { table: string; rows: number }[] } |
  { ok: false; error: string; partial?: string[] }
>;

// The 13 web tables, in dependency-safe copy order (parents before children).
export const MIGRATION_TABLE_ORDER: readonly string[];

// Write the new DB_* keys to .env (forward-fill, never clobber unrelated keys).
// Sets WORK_DB_DRIVER=mysql + WORK_DB_HOST/PORT/USER/PASSWORD/NAME[/PREFIX].
// Returns the path written + the diff so the UI can show what changed.
export async function writeMysqlEnv(
  envPath: string,
  opts: MysqlTargetOpts
): Promise<{ written: string[]; envPath: string }>;

// Self-restart. Sends the HTTP response FIRST (caller responsibility), then:
//   systemd mode:  spawn `ework-aio restart web` (or systemctl --user restart)
//   pidfile mode:  same — aio CLI owns the lifecycle
// Must be the LAST thing the request does; any error after this is unreportable.
export function triggerWebRestart(mode: "systemd" | "pidfile"): void;
```

`MysqlTargetOpts`:
```ts
interface MysqlTargetOpts {
  host: string; port: number; user: string; password: string;
  database: string; prefix?: string;
}
```

### 4.2 New API endpoints (admin-only) — `src/index.ts`

All require `ctx.user?.is_admin === 1`, rate-limited, JSON.

| Method | Path | Action |
|--------|------|--------|
| GET  | `/api/db/status` | Current driver (from env), connection string (passwords masked), per-table row counts for the **running** driver. |
| POST | `/api/db/test` | Body: `MysqlTargetOpts`. Calls `testMysqlConnection`. Does NOT persist anything. |
| POST | `/api/db/migrate` | Body: `MysqlTargetOpts`. Calls `migrateSqliteToMysql`. Returns table+rows report. Idempotent-ish: re-running re-copies (drop+recreate target tables in the throwaway pool). |
| POST | `/api/db/enable` | Body: `MysqlTargetOpts`. Calls `writeMysqlEnv` then `triggerWebRestart`. **Response sent before restart.** Returns `{ ok: true, note: "restarting" }`. |
| POST | `/api/db/disable` | Reverse: migrate mysql→sqlite (if not already copied), rewrite `.env` to `WORK_DB_DRIVER=sqlite`, restart. Safety net. |

### 4.3 The migration algorithm (`migrateSqliteToMysql`)

```
1. Open throwaway mysql2 pool (NOT getDB() — running driver stays sqlite).
2. CREATE DATABASE IF NOT EXISTS (if permitted); USE database.
3. applyPrefix(schema-mysql.sql) → split on ';' → exec each (skip comments).
   → all 13 tables created in the target.
4. For each table in MIGRATION_TABLE_ORDER:
     rows = await sqliteDriver.all(`SELECT * FROM {{table}}`)   // running driver
     if rows.length === 0: continue
     cols = Object.keys(rows[0])
     placeholders = cols.map(()=>'?').join(',')
     insertSql = `INSERT INTO {{table}} (${cols}) VALUES (${placeholders})`
     await mysqlPool.query('START TRANSACTION')  // or per-batch
     for batch of chunked(rows, 500):
       await mysqlPool.query(insertSql, batch.flatMap(r => cols.map(c => r[c])))
     await mysqlPool.query('COMMIT')
5. Verify: for each table, COUNT(*) in mysql === rows.length from sqlite.
   Mismatch → THROW → catch → ROLLBACK + DROP TABLE all 13 → return error.
6. Close throwaway pool. Running sqlite driver untouched.
return { ok, tables: [{table, rows}] }
```

Notes:
- **Type coercion**: sqlite is dynamically typed; mysql columns are typed. The schema-mysql.sql already defines column types, so `INSERT` will coerce (e.g. sqlite TEXT ISO dates → mysql VARCHAR(40)). Test with real data; watch for `data too long` / `incorrect integer`.
- **Attachments/blob**: if any table has BLOB columns, stream them (don't load all into memory). Check schema-mysql.sql for LONGBLOB columns.
- **Idempotency**: re-running `migrate` drops+recreates target tables (TRUNCATE or DROP+CREATE). Safe to retry after a failed attempt.
- **Big tables**: chunk INSERTs (500 rows/batch) to avoid mysql `max_allowed_packet`.

## 5. Frontend — `src/views/settings.ts`

Add a new **standalone section** (NOT a `SettingGroup` — those are config-table-backed). Rendered separately in `buildSettingsPage`, above or below the existing sections.

```
<section class="sg">
  <h2>数据库后端</h2>
  [status block: 当前后端 / 数据量 / 连接]
  [if sqlite]
    <form id="db-migrate">
      MySQL 连接: host port user password database prefix
      <button type="button" onclick="testDb()">测试连接</button>
      <div id="db-test-result"></div>
      <button type="button" onclick="confirmMigrate()">迁移数据并启用</button>
    </form>
  [if mysql]
    <button onclick="disableDb()">切回 SQLite</button>
</section>
```

JS: small inline script (matches the existing settings page style — no build step, vanilla JS fetch to `/api/db/*`). Confirm dialogs for migrate + enable.

## 6. Restart mechanism

The web process cannot "restart itself" in-process. Mechanism:
- **Send the HTTP response first** (enable endpoint returns `{ ok: true, note: "restarting" }`).
- Then `spawn('ework-aio', ['restart', 'web'], { detached: true, stdio: 'ignore' })` and `unref()` it.
- The aio CLI (or systemd) kills the web process; the supervisor brings it back; new boot reads the updated `.env` → MySQL.

Prereqs to verify:
- ework-aio `restart web` works in both systemd + pidfile modes (check `src/commands/lifecycle.ts`).
- systemd unit has `Restart=always` OR the aio restart command handles the full cycle. (If pidfile mode, aio owns it.)
- The spawned aio process must run as the same user that owns the web process — verify the web service's user can invoke `ework-aio`.

Edge cases:
- `ework-aio` not on PATH (web installed standalone, not via aio) → `triggerWebRestart` returns `{ ok: false, error: "ework-aio CLI not found; restart manually" }` and the admin does `systemctl restart` by hand. `.env` is already written, so a manual restart completes the switch.
- Restart loop: if MySQL is unreachable on reboot, systemd `Restart=always` will thrash. Mitigate: on boot, if `initDB()` fails N times, log a clear "WORK_DB_DRIVER=mysql but can't connect — edit .env to fall back to sqlite" and exit (let the admin fix it).

## 7. Same-machine daemon config (follow-up section, same branch)

Once web-side works, add a **"服务调度端 (ework-daemon)"** section to `/settings`:
- Shows whether the daemon is reachable on `WORK_DAEMON_WEBHOOK_URL`.
- Daemon config form (bot login, GITEA_URL, model, DB backend for daemon, etc.).
- On save: web process writes the **daemon's** `.env` (same data dir, same user — feasible on aio single-box), then `spawn('ework-aio', ['restart', 'daemon'])`.
- **Same-machine only.** Cross-machine daemon management requires a daemon admin API (does not exist yet) — out of scope, tracked with the multi-machine work.

This is a UI-organization split (the existing settings already mix some `WORK_DAEMON_*` into web's `.env`); separating into explicit "Web" / "Daemon" blocks is a clarity win, no new mechanism beyond §4-6.

## 8. Security

- All `/api/db/*` endpoints: **admin-only** (`ctx.user?.is_admin === 1`), rate-limited (e.g. 5/min — migrations are heavy).
- MySQL password: **never persisted in the config DB table**. Lives only in `.env` (after enable) and in the request body transiently. The `/api/db/status` response **masks** the password.
- CSRF: the existing settings POST uses same-origin cookie auth + `SEC_HEADERS`; the new endpoints reuse the same auth context. Verify `Content-Type: application/json` + same-origin enforcement.
- The migrate endpoint opens a throwaway mysql pool with user-supplied creds — ensure creds are not logged (redact in any error/log).

## 9. Phasing / milestones

| Phase | Deliverable | Test gate |
|-------|-------------|-----------|
| **P1** | `src/db-admin.ts`: `testMysqlConnection` + `migrateSqliteToMysql` + `MIGRATION_TABLE_ORDER` + `writeMysqlEnv`. Pure logic, no HTTP. | Unit test: real sqlite fixture → throwaway mysql container → assert row counts match per table. Round-trip (migrate, then verify a sample query returns same data). |
| **P2** | `/api/db/*` endpoints wired in `src/index.ts` (admin-only, rate-limited). | Integration test: hit endpoints with admin cookie, assert status/test/migrate flow against a mysql container. |
| **P3** | `views/settings.ts` DB section + inline JS. Manual restart flow. | Manual: full wizard against a local mysql; verify post-restart the UI shows MySQL + data intact. |
| **P4** | `triggerWebRestart` via aio CLI; verify systemd + pidfile modes. End-to-end. | E2E: enable from UI → process restarts → comes back on mysql. |
| **P5** | Daemon config section (same-machine). | Manual + lifecycle test (restart daemon from web UI). |
| **P6** | "切回 SQLite" reverse migration. | Round-trip test: sqlite→mysql→sqlite, data intact. |

P1 is the technical core (migration correctness). Ship P1-P4 as the first usable version (sqlite→mysql one-way with UI). P5-P6 follow.

## 10. Out of scope (explicit)

- **Cross-machine daemon config** (web on box A managing daemon on box B) — needs daemon admin API, tracked with multi-machine coordination work.
- **Hot-swap DB driver** (no restart) — race-condition-heavy, not worth it for v1.
- **MySQL→MySQL reconfiguration** (changing host/db of an already-mysql deployment) — edge case; can hand-edit `.env` for now.
- **Schema drift detection** between sqlite and mysql (beyond row counts) — v1 trusts `schema-mysql.sql` + row counts; fuller consistency checks later if needed.

## 11. Files to add/modify

| File | Change |
|------|--------|
| `src/db-admin.ts` | **NEW** — test/migrate/enable/disable/restart logic. |
| `src/index.ts` | Add `/api/db/*` routes (admin-only). |
| `src/views/settings.ts` | Add 数据库后端 section. |
| `tests/db-admin.test.ts` | **NEW** — migration round-trip against mysql container. |
| `scripts/test-mysql.sh` | Reuse for the migration test (mysql container already wired). |

No changes to `src/db.ts` (driver layer), `src/store.ts` (data layer), or `schema-mysql.sql` — those already support MySQL from the 0.3.0 work.
