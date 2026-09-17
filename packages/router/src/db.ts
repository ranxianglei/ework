import type { Config } from "./config.ts";
import type { DaemonInfo } from "./types.ts";

let pool: import("mysql2/promise").Pool | null = null;
let sqliteDb: import("bun:sqlite").Database | null = null;

function applyPrefix(sql: string, prefix: string): string {
  if (!sql.includes("{{")) return sql;
  return sql.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => (prefix ?? "") + name);
}

export async function initDB(cfg: Config): Promise<void> {
  if (cfg.WORK_DB_DRIVER === "mysql") {
    const mysql = await import("mysql2/promise");
    pool = mysql.createPool({
      host: cfg.WORK_DB_HOST,
      port: cfg.WORK_DB_PORT,
      user: cfg.WORK_DB_USER,
      password: cfg.WORK_DB_PASSWORD,
      database: cfg.WORK_DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
    const conn = await pool.getConnection();
    await conn.query("SELECT 1");
    conn.release();
  } else {
    const { Database } = await import("bun:sqlite");
    const path = cfg.WORK_DB_PATH || `${process.env.HOME}/.local/share/ework-router/router.db`;
    // sqlite creates the file but not parent dirs — a fresh $HOME (docker
    // volume, new machine) dies with SQLITE_CANTOPEN without this.
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(path), { recursive: true });
    sqliteDb = new Database(path, { create: true });
  }
}

export async function closeDB(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
  if (sqliteDb) { sqliteDb.close(); sqliteDb = null; }
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const finalSql = applyPrefix(sql, process.env.WORK_DB_PREFIX ?? "");
  if (pool) {
    const [rows] = await pool.query(finalSql, params);
    return rows as T[];
  }
  if (sqliteDb) {
    return sqliteDb.prepare(finalSql).all(...params as never[]) as T[];
  }
  return [];
}

export async function getActiveDaemons(cfg: Config): Promise<DaemonInfo[]> {
  const staleThreshold = new Date(Date.now() - cfg.ROUTER_STALE_THRESHOLD_MS).toISOString();
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;

  interface DaemonRow {
    id: number;
    display_name: string;
    internal_endpoint: string;
    capacity: number;
    last_heartbeat: string;
    status: string;
  }

  // Query 1: active daemons (simple SELECT — no subquery JOIN)
  let daemonRows: DaemonRow[];
  try {
    daemonRows = await query<DaemonRow>(
      `SELECT id, display_name, internal_endpoint, capacity, last_heartbeat, status
       FROM {{${daemonPrefix}daemons}}
       WHERE status = 'active' AND last_heartbeat > ?
       ORDER BY id`,
      [staleThreshold],
    );
  } catch (err) {
    console.warn("[ework-router] getActiveDaemons: daemon query failed:", err);
    return [];
  }

  if (daemonRows.length === 0) return [];

  // Query 2: active session counts per daemon (separate simple query, join in memory)
  const sessionMap = new Map<number, number>();
  try {
    const sessionRows = await query<{ owner_daemon_id: number; active_count: number }>(
      `SELECT i.owner_daemon_id, COUNT(*) AS active_count
       FROM {{${daemonPrefix}issues}} i
       JOIN {{${daemonPrefix}op_sessions}} s ON s.issue_id = i.uid
       WHERE s.state = 'running' AND i.owner_daemon_id IS NOT NULL
       GROUP BY i.owner_daemon_id`,
    );
    for (const r of sessionRows) {
      sessionMap.set(r.owner_daemon_id, Number(r.active_count) || 0);
    }
  } catch (err) {
    console.warn("[ework-router] getActiveDaemons: session count query failed, defaulting to 0:", err);
  }

  return daemonRows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    endpoint: r.internal_endpoint,
    capacity: r.capacity,
    lastHeartbeat: r.last_heartbeat,
    status: r.status,
    activeSessions: sessionMap.get(r.id) ?? 0,
  }));
}

export async function getAllDaemons(cfg: Config): Promise<DaemonInfo[]> {
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;
  interface DaemonRow {
    id: number;
    display_name: string;
    internal_endpoint: string;
    capacity: number;
    last_heartbeat: string;
    status: string;
  }
  try {
    const rows = await query<DaemonRow>(
      `SELECT id, display_name, internal_endpoint, capacity, last_heartbeat, status
       FROM {{${daemonPrefix}daemons}} ORDER BY id`,
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      endpoint: r.internal_endpoint,
      capacity: r.capacity,
      lastHeartbeat: r.last_heartbeat,
      status: r.status,
      activeSessions: 0,
    }));
  } catch (err) {
    console.warn("[ework-router] getAllDaemons: query failed:", err);
    return [];
  }
}

export async function markStaleDaemonsDead(cfg: Config): Promise<number> {
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;
  const staleThreshold = new Date(Date.now() - cfg.ROUTER_STALE_THRESHOLD_MS).toISOString();
  const sql = `UPDATE {{${daemonPrefix}daemons}} SET status = 'dead' WHERE status = 'active' AND last_heartbeat < ?`;
  try {
    if (pool) {
      const [result] = await pool.query(applyPrefix(sql, process.env.WORK_DB_PREFIX ?? ""), [staleThreshold]);
      return (result as { affectedRows: number }).affectedRows || 0;
    }
    if (sqliteDb) {
      const r = sqliteDb.prepare(applyPrefix(sql, process.env.WORK_DB_PREFIX ?? ""))
        .run(staleThreshold as never);
      return Number(r.changes) || 0;
    }
  } catch (err) {
    console.warn("[ework-router] markStaleDaemonsDead: failed:", err);
  }
  return 0;
}

export async function releaseOrphanedSessions(cfg: Config): Promise<number> {
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;
  const sql = `UPDATE {{${daemonPrefix}op_sessions}} SET owner_daemon_id = NULL, state = 'pending'
     WHERE owner_daemon_id IN (SELECT id FROM {{${daemonPrefix}daemons}} WHERE status = 'dead')
     AND state = 'running'`;
  try {
    if (pool) {
      const [result] = await pool.query(applyPrefix(sql, process.env.WORK_DB_PREFIX ?? ""));
      return (result as { affectedRows: number }).affectedRows || 0;
    }
    if (sqliteDb) {
      const r = sqliteDb.prepare(applyPrefix(sql, process.env.WORK_DB_PREFIX ?? "")).run();
      return Number(r.changes) || 0;
    }
  } catch (err) {
    console.warn("[ework-router] releaseOrphanedSessions: failed:", err);
  }
  return 0;
}

export async function getIssueOwnerDaemonId(cfg: Config, scopeKey: string, issueId: number): Promise<number | null> {
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;
  try {
    const rows = await query<{ owner_daemon_id: number | null }>(
      `SELECT owner_daemon_id FROM {{${daemonPrefix}issues}}
       WHERE tracker_scope_key = ? AND tracker_issue_id = ?
       LIMIT 1`,
      [scopeKey, String(issueId)],
    );
    const ownerId = rows[0]?.owner_daemon_id;
    return ownerId ?? null;
  } catch (err) {
    console.warn("[ework-router] getIssueOwnerDaemonId: query failed:", err);
    return null;
  }
}
