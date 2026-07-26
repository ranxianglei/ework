import type { Config } from "./config.ts";
import type { DaemonInfo } from "./types.ts";

let pool: import("mysql2/promise").Pool | null = null;
let sqliteDb: import("bun:sqlite").Database | null = null;

function applyPrefix(sql: string, prefix: string): string {
  if (!prefix || !sql.includes("{{")) return sql;
  return sql.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => prefix + name);
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
  const staleThreshold = new Date(Date.now() - cfg.ROUTER_STALE_THRESHOLD_MS)
    .toISOString().slice(0, 19).replace("T", " ");
  const daemonPrefix = cfg.DAEMON_TABLE_PREFIX;

  const sql = `
    SELECT
      d.id, d.display_name, d.internal_endpoint, d.capacity,
      d.last_heartbeat, d.status,
      COALESCE(s.active_count, 0) AS active_sessions
    FROM {{${daemonPrefix}daemons}} d
    LEFT JOIN (
      SELECT owner_daemon_id, COUNT(*) AS active_count
      FROM {{${daemonPrefix}op_sessions}}
      WHERE state = 'running'
      GROUP BY owner_daemon_id
    ) s ON s.owner_daemon_id = d.id
    WHERE d.status = 'active'
      AND d.last_heartbeat > ?
    ORDER BY d.id
  `;

  interface Row {
    id: number;
    display_name: string;
    internal_endpoint: string;
    capacity: number;
    last_heartbeat: string;
    status: string;
    active_sessions: number;
  }

  let rows: Row[];
  try {
    rows = await query<Row>(sql, [staleThreshold]);
  } catch {
    const fallbackSql = `
      SELECT d.id, d.display_name, d.internal_endpoint, d.capacity,
             d.last_heartbeat, d.status, 0 AS active_sessions
      FROM {{${daemonPrefix}daemons}} d
      WHERE d.status = 'active'
        AND d.last_heartbeat > ?
      ORDER BY d.id
    `;
    rows = await query<Row>(fallbackSql, [staleThreshold]);
  }

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    endpoint: r.internal_endpoint,
    capacity: r.capacity,
    lastHeartbeat: r.last_heartbeat,
    status: r.status,
    activeSessions: Number(r.active_sessions) || 0,
  }));
}
