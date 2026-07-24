// Storage bootstrap. Owns the AsyncDatabase singleton. SQLite today (bun:sqlite
// wrapped async); a MySQL driver will implement the same AsyncDatabase surface
// later. Schema + migrations run in connect(). Callers MUST `await initDB()`
// once at boot before issuing queries.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

// ---- public async interface (driver-agnostic) ----
export interface DbRunResult {
  /** Rowid of the last inserted row (SQLite lastInsertRowid / MySQL insertId). */
  insertId: number;
  /** Number of rows affected by the statement. */
  changes: number;
}

export interface AsyncDatabase {
  /** SELECT → all matching rows. Empty array when none. */
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /** SELECT → first matching row or null. */
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  /** INSERT/UPDATE/DELETE → insertId + affected-row count. */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;
  /** Execute DDL / raw statement (no params, no rows back). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction: commit on resolve, rollback on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Release the connection/pool. Idempotent. */
  close(): Promise<void>;
}

const DB_PATH =
  process.env.WORK_DB_PATH ||
  join(process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`, "ework", "ework.db");

function userTableColumns(db: Database): Set<string> {
  const rows = db.query("PRAGMA table_info(users)").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// schema.sql CREATE TABLE only applies full column list to fresh DBs;
// existing DBs need these ALTERs to gain new columns. Idempotent via PRAGMA check.
function migrateUsersTable(db: Database): void {
  if (userTableColumns(db).size === 0) return; // users doesn't exist yet; schema.sql will create it
  const have = userTableColumns(db);
  const additions: { col: string; ddl: string }[] = [
    { col: "password_hash", ddl: "ALTER TABLE users ADD COLUMN password_hash TEXT" },
    { col: "email", ddl: "ALTER TABLE users ADD COLUMN email TEXT" },
    { col: "is_admin", ddl: "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0" },
    { col: "is_active", ddl: "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1" },
    { col: "updated_at", ddl: "ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''" },
  ];
  for (const m of additions) {
    if (have.has(m.col)) continue;
    db.exec(m.ddl);
  }
  db.exec("CREATE INDEX IF NOT EXISTS users_is_admin ON users (is_admin) WHERE is_admin = 1");
}

function tableColumns(db: Database, name: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${name})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function migratePatTable(db: Database): void {
  const have = tableColumns(db, "personal_access_tokens");
  if (have.size === 0) return;
  if (!have.has("ip_allowlist")) {
    db.exec("ALTER TABLE personal_access_tokens ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]'");
  }
}

function migrateProjectsTable(db: Database): void {
  const have = tableColumns(db, "projects");
  if (have.size === 0) return;
  if (!have.has("upstream_urls")) {
    db.exec("ALTER TABLE projects ADD COLUMN upstream_urls TEXT NOT NULL DEFAULT '[]'");
  }
  if (!have.has("model")) {
    db.exec("ALTER TABLE projects ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
}

function migrateIssuesTable(db: Database): void {
  const have = tableColumns(db, "issues");
  if (have.size === 0) return;
  if (!have.has("closed_at")) {
    db.exec("ALTER TABLE issues ADD COLUMN closed_at TEXT");
  }
}

// ---- SqliteDriver: wraps bun:sqlite behind AsyncDatabase ----
class SqliteDriver implements AsyncDatabase {
  private readonly db: Database;
  private inTx = false;
  private constructor(db: Database) { this.db = db; }

  static async create(): Promise<SqliteDriver> {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH, { create: true, readwrite: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    );
    // Migration must run BEFORE schema.sql (same ordering as the original file).
    migrateUsersTable(db);
    migratePatTable(db);
    migrateProjectsTable(db);
    migrateIssuesTable(db);
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
    return new SqliteDriver(db);
  }

  async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(sql).all(...(params as SQLQueryBindings[])) as T[];
  }
  async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.query(sql).get(...(params as SQLQueryBindings[])) as T | null) ?? null;
  }
  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const info = this.db.query(sql).run(...(params as SQLQueryBindings[])) as unknown as {
      lastInsertRowid: number | bigint;
      changes: number;
    };
    return { insertId: Number(info.lastInsertRowid), changes: info.changes };
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
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
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.inTx = false;
    }
  }
  async close(): Promise<void> {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

let _driver: AsyncDatabase | null = null;

/** Initialize + connect the database. MUST be awaited once at boot. */
export async function initDB(): Promise<AsyncDatabase> {
  if (_driver) return _driver;
  _driver = await SqliteDriver.create();
  return _driver;
}

/** Returns the initialized AsyncDatabase. Throws if initDB() wasn't awaited. */
export function getDB(): AsyncDatabase {
  if (!_driver) throw new Error("getDB() called before initDB(); await initDB() at boot first");
  return _driver;
}

export async function getConfigAll(): Promise<Record<string, string>> {
  try {
    const driver = getDB();
    const rows = await driver.all<{ key: string; value: string }>("SELECT key, value FROM config");
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return {};
  }
}

export async function setConfig(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await getDB().run(
    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, value, now]
  );
}

export async function deleteConfig(key: string): Promise<void> {
  await getDB().run("DELETE FROM config WHERE key = ?", [key]);
}
