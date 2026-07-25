// Storage bootstrap. Owns the AsyncDatabase singleton. Two drivers behind one
// AsyncDatabase surface: SQLite (bun:sqlite, default) and MySQL (mysql2/promise).
// Driver picked by WORK_DB_DRIVER (sqlite|mysql). Schema runs in connect().
// Callers MUST `await initDB()` once at boot before issuing queries.
//
// Table prefix: every table/index/constraint reference in SQL is written as a
// {{name}} token; applyPrefix() rewrites {{name}} -> <WORK_DB_PREFIX>+name
// before execution. Default prefix "" leaves SQL identical (backward-
// compatible with existing ework-daemon.db files). WORK_DB_PREFIX is ENV-ONLY
// — the prefix must be available before the DB is open, so it cannot live in
// the DB itself (chicken-and-egg).
//
// Backward compat: WORK_DB_PATH falls back to DAEMON_DB_PATH (the legacy env
// var) so existing single-machine deployments keep working without changes.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// ---- public async interface (driver-agnostic) ----
export interface DbRunResult {
  /** Rowid of the last inserted row (SQLite lastInsertRowid / MySQL insertId). */
  insertId: number;
  /** Number of rows affected by the statement. */
  changes: number;
}

export interface AsyncDatabase {
  /** SELECT -> all matching rows. Empty array when none. */
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** SELECT -> first matching row or null. */
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  /** INSERT/UPDATE/DELETE -> insertId + affected-row count. */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;
  /** Execute DDL / raw statement (no params, no rows back). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction: commit on resolve, rollback on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Release the connection/pool. Idempotent. */
  close(): Promise<void>;
  /** Driver dialect — lets callers branch on SQLite vs MySQL specifics. */
  readonly dialect: "sqlite" | "mysql";
}

const DEFAULT_DB_PATH = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "ework-daemon",
  "ework-daemon.db"
);

// WORK_DB_PATH preferred; fall back to legacy DAEMON_DB_PATH for existing deploys.
const DB_PATH = process.env.WORK_DB_PATH || process.env.DAEMON_DB_PATH || DEFAULT_DB_PATH;

// ---- table prefix (env-only; read once at module load) ----
// Validated as a safe SQL identifier prefix. Empty = no prefix (default,
// backward-compatible). A non-empty prefix lets multiple ework-daemon
// instances share one database without colliding on table names.
const DB_PREFIX = (() => {
  const raw = (process.env.WORK_DB_PREFIX ?? "").trim();
  if (raw && !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(raw)) {
    throw new Error(
      `Invalid WORK_DB_PREFIX "${raw}": must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$`
    );
  }
  return raw;
})();

/** Rewrite {{table}} tokens -> <prefix>table. No-op when sql contains no tokens. */
export function applyPrefix(sql: string): string {
  if (!sql.includes("{{")) return sql;
  return sql.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => DB_PREFIX + name);
}

// ---- driver selection (env-only; read once at module load) ----
const DB_DRIVER = (process.env.WORK_DB_DRIVER ?? "sqlite").trim().toLowerCase();
const DB_SKIP_CREATE =
  process.env.WORK_DB_SKIP_CREATE === "1" || process.env.WORK_DB_SKIP_CREATE === "true";
if (DB_DRIVER !== "sqlite" && DB_DRIVER !== "mysql") {
  throw new Error(`Unsupported WORK_DB_DRIVER "${DB_DRIVER}": must be "sqlite" or "mysql"`);
}

// ---- SqliteDriver: wraps bun:sqlite behind AsyncDatabase ----
class SqliteDriver implements AsyncDatabase {
  readonly dialect = "sqlite" as const;
  private readonly db: Database;
  private inTx = false;
  private constructor(db: Database) {
    this.db = db;
  }

  static async create(): Promise<SqliteDriver> {
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(DB_PATH, { create: true, readwrite: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const schemaSql = applyPrefix(readFileSync(join(import.meta.dir, "schema-sqlite.sql"), "utf8"));
    db.exec(schemaSql);
    return new SqliteDriver(db);
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(applyPrefix(sql)).all(...(params as SQLQueryBindings[])) as T[];
  }
  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.query(applyPrefix(sql)).get(...(params as SQLQueryBindings[])) as T | null) ?? null;
  }
  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const info = this.db.query(applyPrefix(sql)).run(...(params as SQLQueryBindings[])) as unknown as {
      lastInsertRowid: number | bigint;
      changes: number;
    };
    return { insertId: Number(info.lastInsertRowid), changes: info.changes };
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(applyPrefix(sql));
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) {
      // SQLite can't nest BEGIN without SAVEPOINT; current codebase has no
      // nesting, so this safety net just runs the body inline.
      return fn();
    }
    this.db.exec("BEGIN");
    this.inTx = true;
    try {
      const r = await fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }
  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---- MysqlDriver: wraps mysql2/promise behind AsyncDatabase ----
// MySQL transactions must run on a single connection, so transaction() checks
// out a connection, pins it as txConn, and routes all/get/run/exec through it
// until commit/rollback. Outside a transaction, queries hit the pool. SQLite-
// specific SQL (INSERT OR IGNORE) is translated to MySQL equivalents by
// translateForMysql() so op.ts stays single-dialect.
interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  skipCreate: boolean;
}

function translateForMysql(sql: string): string {
  return sql.replace(/INSERT OR IGNORE INTO/g, "INSERT IGNORE INTO");
}

class MysqlDriver implements AsyncDatabase {
  readonly dialect = "mysql" as const;
  private readonly pool: Pool;
  private txConn: PoolConnection | null = null;
  private constructor(pool: Pool) {
    this.pool = pool;
  }

  private get conn(): Pool | PoolConnection {
    return this.txConn ?? this.pool;
  }

  static async create(opts: MysqlOptions): Promise<MysqlDriver> {
    const pool = createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    });
    const probe = await pool.getConnection();
    try {
      await probe.ping();
    } finally {
      probe.release();
    }
    if (!opts.skipCreate) {
      const raw = applyPrefix(readFileSync(join(import.meta.dir, "schema-mysql.sql"), "utf8"));
      // MySQL has no CREATE INDEX IF NOT EXISTS, so split into statements and
      // tolerate ER_DUP_KEYNAME (1061) so re-runs stay idempotent. Comment lines
      // are stripped first — they may contain ';' which would corrupt the split.
      const schema = raw
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
      for (const stmt of schema.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
        try {
          await pool.query(stmt);
        } catch (e) {
          if (e && typeof e === "object" && "errno" in e && (e as { errno: number }).errno === 1061) continue;
          throw e;
        }
      }
    }
    return new MysqlDriver(pool);
  }

  private prepare(sql: string): string {
    return translateForMysql(applyPrefix(sql));
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query(this.prepare(sql), params);
    return rows as T[];
  }
  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const [rows] = await this.conn.query(this.prepare(sql), params);
    const arr = rows as T[];
    return arr[0] ?? null;
  }
  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const [result] = await this.conn.query(this.prepare(sql), params);
    const r = result as ResultSetHeader;
    return { insertId: Number(r.insertId), changes: r.affectedRows };
  }
  async exec(sql: string): Promise<void> {
    await this.conn.query(this.prepare(sql));
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txConn) return fn();
    const conn = await this.pool.getConnection();
    this.txConn = conn;
    await conn.beginTransaction();
    try {
      const r = await fn();
      await conn.commit();
      return r;
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.txConn = null;
      conn.release();
    }
  }
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch {
      /* already closed */
    }
  }
}

let _driver: AsyncDatabase | null = null;

/** Initialize + connect the database. MUST be awaited once at boot. */
export async function initDB(): Promise<AsyncDatabase> {
  if (_driver) return _driver;
  if (DB_DRIVER === "mysql") {
    _driver = await MysqlDriver.create({
      host: process.env.WORK_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.WORK_DB_PORT ?? 3306),
      user: process.env.WORK_DB_USER ?? "ework-daemon",
      password: process.env.WORK_DB_PASSWORD ?? "",
      database: process.env.WORK_DB_NAME ?? "ework-daemon",
      skipCreate: DB_SKIP_CREATE,
    });
  } else {
    _driver = await SqliteDriver.create();
  }
  return _driver;
}

/** Returns the initialized AsyncDatabase. Throws if initDB() wasn't awaited. */
export function getDB(): AsyncDatabase {
  if (!_driver) throw new Error("getDB() called before initDB(); await initDB() at boot first");
  return _driver;
}
