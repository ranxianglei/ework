// Storage bootstrap. Owns the AsyncDatabase singleton. Two drivers behind one
// AsyncDatabase surface: SQLite (bun:sqlite, default) and MySQL (mysql2/promise).
// Driver picked by WORK_DB_DRIVER (sqlite|mysql). Schema + migrations run in
// connect(). Callers MUST `await initDB()` once at boot before issuing queries.
//
// Table prefix: every table reference in SQL is written as a {{table}} token;
// applyPrefix() rewrites {{name}} -> <WORK_DB_PREFIX>+name before execution.
// Default prefix "" leaves SQL identical (backward-compatible with existing
// ework.db files). WORK_DB_PREFIX is ENV-ONLY (never stored in the config
// table) — the prefix is needed to locate the config table itself, so it
// cannot live inside it (chicken-and-egg).

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
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
  /** Driver dialect — lets callers branch on SQLite vs MySQL specifics. */
  readonly dialect: "sqlite" | "mysql";
}

const DB_PATH =
  process.env.WORK_DB_PATH ||
  join(process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`, "ework", "ework.db");

// ---- table prefix (env-only; read once at module load) ----
// Validated as a safe SQL identifier prefix. Empty = no prefix (default,
// backward-compatible). A non-empty prefix lets multiple ework instances (or
// ework + another app) share one database without colliding on table names.
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
const DB_SKIP_CREATE = process.env.WORK_DB_SKIP_CREATE === "1" || process.env.WORK_DB_SKIP_CREATE === "true";
if (DB_DRIVER !== "sqlite" && DB_DRIVER !== "mysql") {
  throw new Error(`Unsupported WORK_DB_DRIVER "${DB_DRIVER}": must be "sqlite" or "mysql"`);
}

function userTableColumns(db: Database): Set<string> {
  const rows = db.query(applyPrefix("PRAGMA table_info({{users}})")).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// schema.sql CREATE TABLE only applies full column list to fresh DBs;
// existing DBs need these ALTERs to gain new columns. Idempotent via PRAGMA check.
function migrateUsersTable(db: Database): void {
  if (userTableColumns(db).size === 0) return; // users doesn't exist yet; schema.sql will create it
  const have = userTableColumns(db);
  const additions: { col: string; ddl: string }[] = [
    { col: "password_hash", ddl: "ALTER TABLE {{users}} ADD COLUMN password_hash TEXT" },
    { col: "email", ddl: "ALTER TABLE {{users}} ADD COLUMN email TEXT" },
    { col: "is_admin", ddl: "ALTER TABLE {{users}} ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0" },
    { col: "is_active", ddl: "ALTER TABLE {{users}} ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1" },
    { col: "updated_at", ddl: "ALTER TABLE {{users}} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''" },
  ];
  for (const m of additions) {
    if (have.has(m.col)) continue;
    db.exec(applyPrefix(m.ddl));
  }
  db.exec(applyPrefix("CREATE INDEX IF NOT EXISTS users_is_admin ON {{users}} (is_admin) WHERE is_admin = 1"));
}

function tableColumns(db: Database, name: string): Set<string> {
  const rows = db.query(applyPrefix(`PRAGMA table_info({{${name}}})`)).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function migratePatTable(db: Database): void {
  const have = tableColumns(db, "personal_access_tokens");
  if (have.size === 0) return;
  if (!have.has("ip_allowlist")) {
    db.exec(applyPrefix("ALTER TABLE {{personal_access_tokens}} ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]'"));
  }
}

function migrateProjectsTable(db: Database): void {
  const have = tableColumns(db, "projects");
  if (have.size === 0) return;
  if (!have.has("upstream_urls")) {
    db.exec(applyPrefix("ALTER TABLE {{projects}} ADD COLUMN upstream_urls TEXT NOT NULL DEFAULT '[]'"));
  }
  if (!have.has("model")) {
    db.exec(applyPrefix("ALTER TABLE {{projects}} ADD COLUMN model TEXT NOT NULL DEFAULT ''"));
  }
  if (!have.has("visibility")) {
    db.exec(applyPrefix("ALTER TABLE {{projects}} ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'"));
  }
}

function migrateIssuesTable(db: Database): void {
  const have = tableColumns(db, "issues");
  if (have.size === 0) return;
  if (!have.has("closed_at")) {
    db.exec(applyPrefix("ALTER TABLE {{issues}} ADD COLUMN closed_at TEXT"));
  }
  if (!have.has("ai_status")) {
    db.exec(applyPrefix("ALTER TABLE {{issues}} ADD COLUMN ai_status TEXT NOT NULL DEFAULT ''"));
  }
  if (!have.has("model")) {
    db.exec(applyPrefix("ALTER TABLE {{issues}} ADD COLUMN model TEXT NOT NULL DEFAULT ''"));
  }
  if (!have.has("runtime")) {
    db.exec(applyPrefix("ALTER TABLE {{issues}} ADD COLUMN runtime TEXT NOT NULL DEFAULT ''"));
  }
  if (!have.has("upstream_issue_number")) {
    db.exec(applyPrefix("ALTER TABLE {{issues}} ADD COLUMN upstream_issue_number INTEGER"));
  }
}

function migrateCommentsTable(db: Database): void {
  const have = tableColumns(db, "comments");
  if (have.size === 0) return;
  if (!have.has("upstream_comment_id")) {
    db.exec(applyPrefix("ALTER TABLE {{comments}} ADD COLUMN upstream_comment_id INTEGER"));
  }
  if (!have.has("model")) {
    db.exec(applyPrefix("ALTER TABLE {{comments}} ADD COLUMN model TEXT NOT NULL DEFAULT ''"));
  }
}

function migrateLabelsTable(db: Database): void {
  const have = tableColumns(db, "labels");
  if (have.size === 0) return;
  if (!have.has("description")) {
    db.exec(applyPrefix("ALTER TABLE {{labels}} ADD COLUMN description TEXT NOT NULL DEFAULT ''"));
  }
  if (!have.has("exclusive")) {
    db.exec(applyPrefix("ALTER TABLE {{labels}} ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0"));
  }
  if (!have.has("is_archived")) {
    db.exec(applyPrefix("ALTER TABLE {{labels}} ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"));
  }
}

function migrateConfigTable(db: Database): void {
  const have = tableColumns(db, "config");
  if (have.size === 0) return;
  if (have.has("id") && have.has("akey")) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    const oldKeyCol = have.has("key") ? "key" : "akey";
    db.exec(applyPrefix("ALTER TABLE {{config}} RENAME TO config_old"));
    db.exec(applyPrefix(
      "CREATE TABLE {{config}} (id INTEGER PRIMARY KEY AUTOINCREMENT, akey TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ));
    db.exec(applyPrefix(
      `INSERT INTO {{config}} (akey, value, updated_at) SELECT ${oldKeyCol}, value, updated_at FROM config_old`
    ));
    db.exec("DROP TABLE config_old");
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const SURROGATE_ID_TABLES: Array<{ name: string; createSql: string; dataCols: string }> = [
  {
    name: "users",
    createSql: "CREATE TABLE {{users}} (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human','bot','system')), display_name TEXT, password_hash TEXT, email TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '')",
    dataCols: "login, kind, display_name, password_hash, email, is_admin, is_active, created_at, updated_at",
  },
  {
    name: "model_cache",
    createSql: "CREATE TABLE {{model_cache}} (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_model TEXT NOT NULL UNIQUE, label TEXT NOT NULL, refreshed_at TEXT NOT NULL)",
    dataCols: "provider_model, label, refreshed_at",
  },
  {
    name: "issue_labels",
    createSql: "CREATE TABLE {{issue_labels}} (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES {{issues}}(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES {{labels}}(id) ON DELETE CASCADE, UNIQUE (issue_id, label_id))",
    dataCols: "issue_id, label_id",
  },
  {
    name: "reactions",
    createSql: "CREATE TABLE {{reactions}} (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL REFERENCES {{comments}}(id) ON DELETE CASCADE, user_login TEXT NOT NULL REFERENCES {{users}}(login), content TEXT NOT NULL, UNIQUE (comment_id, user_login, content))",
    dataCols: "comment_id, user_login, content",
  },
  {
    name: "attachments",
    createSql: "CREATE TABLE {{attachments}} (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, issue_id INTEGER NOT NULL REFERENCES {{issues}}(id) ON DELETE CASCADE, filename TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', size INTEGER NOT NULL, blob_path TEXT NOT NULL, uploaded_by TEXT NOT NULL REFERENCES {{users}}(login), created_at TEXT NOT NULL)",
    dataCols: "uuid, issue_id, filename, content_type, size, blob_path, uploaded_by, created_at",
  },
  {
    name: "project_members",
    createSql: "CREATE TABLE {{project_members}} (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES {{projects}}(id) ON DELETE CASCADE, user_login TEXT NOT NULL REFERENCES {{users}}(login) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'writer' CHECK (role IN ('reader','writer','admin')), created_at TEXT NOT NULL, UNIQUE (project_id, user_login))",
    dataCols: "project_id, user_login, role, created_at",
  },
];

function migrateAddSurrogateId(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const t of SURROGATE_ID_TABLES) {
      const have = tableColumns(db, t.name);
      if (have.size === 0 || have.has("id")) continue;
      db.exec(applyPrefix(`ALTER TABLE {{${t.name}}} RENAME TO ${t.name}_old`));
      db.exec(applyPrefix(t.createSql));
      db.exec(applyPrefix(`INSERT INTO {{${t.name}}} (${t.dataCols}) SELECT ${t.dataCols} FROM ${t.name}_old`));
      db.exec(`DROP TABLE ${t.name}_old`);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// ---- SqliteDriver: wraps bun:sqlite behind AsyncDatabase ----
class SqliteDriver implements AsyncDatabase {
  readonly dialect = "sqlite" as const;
  private readonly db: Database;
  private inTx = false;
  private constructor(db: Database) { this.db = db; }

  static async create(): Promise<SqliteDriver> {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH, { create: true, readwrite: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      applyPrefix(
        "CREATE TABLE IF NOT EXISTS {{config}} (id INTEGER PRIMARY KEY AUTOINCREMENT, akey TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
      )
    );
    // Migration must run BEFORE schema.sql (same ordering as the original file).
  migrateConfigTable(db);
  migrateUsersTable(db);
  migratePatTable(db);
  migrateProjectsTable(db);
  migrateIssuesTable(db);
  migrateCommentsTable(db);
  migrateLabelsTable(db);
  migrateAddSurrogateId(db);
    db.exec(applyPrefix(readFileSync(join(import.meta.dir, "schema.sql"), "utf8")));
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

// ---- MysqlDriver: wraps mysql2/promise behind AsyncDatabase ----
// MySQL transactions must run on a single connection, so transaction() checks
// out a connection, pins it as txConn, and routes all/get/run/exec through it
// until commit/rollback. Outside a transaction, queries hit the pool. SQLite-
// specific SQL (INSERT OR IGNORE, ON CONFLICT ... excluded.x) is translated to
// MySQL equivalents by translateForMysql() so store.ts stays single-dialect.
interface MysqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  skipCreate: boolean;
}

function translateForMysql(sql: string): string {
  return sql
    .replace(/INSERT OR IGNORE INTO/g, "INSERT IGNORE INTO")
    .replace(/ON CONFLICT\((\w+)\) DO UPDATE SET/g, "ON DUPLICATE KEY UPDATE")
    .replace(/excluded\.(\w+)/g, "VALUES($1)")
    .replace(/LIKE \? ESCAPE '\\'/g, "LIKE ?");
}

async function migrateMysqlSurrogateId(pool: Pool): Promise<void> {
  const MYSQL_ALTERS: Array<{ table: string; sql: string }> = [
    { table: "users", sql: "ALTER TABLE {{users}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_users_login (login)" },
    { table: "model_cache", sql: "ALTER TABLE {{model_cache}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_mc_pm (provider_model)" },
    { table: "issue_labels", sql: "ALTER TABLE {{issue_labels}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_il (issue_id, label_id)" },
    { table: "reactions", sql: "ALTER TABLE {{reactions}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_react (comment_id, user_login, content)" },
    { table: "attachments", sql: "ALTER TABLE {{attachments}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_att_uuid (uuid)" },
    { table: "project_members", sql: "ALTER TABLE {{project_members}} DROP PRIMARY KEY, ADD COLUMN id BIGINT AUTO_INCREMENT PRIMARY KEY FIRST, ADD UNIQUE INDEX uk_pm (project_id, user_login)" },
  ];
  for (const m of MYSQL_ALTERS) {
    const tbl = DB_PREFIX + m.table;
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'",
      [tbl]
    );
    if ((cols as unknown[]).length > 0) continue;
    try {
      await pool.query(applyPrefix(m.sql));
    } catch (e) {
      const errno = (e as { errno?: number }).errno;
      if (errno === 1146) continue;
      console.warn(`[db] MySQL surrogate-id migration for ${m.table} failed (errno ${errno}):`, (e as Error).message);
    }
  }
  const [cfgCols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'key'",
    [DB_PREFIX + "config"]
  );
  if ((cfgCols as unknown[]).length > 0) {
    try {
      await pool.query(applyPrefix("ALTER TABLE {{config}} CHANGE `key` akey VARCHAR(255) NOT NULL"));
    } catch (e) {
      console.warn("[db] MySQL config key→akey rename failed:", (e as Error).message);
    }
  }
}

async function migrateMysqlProjectsVisibility(pool: Pool): Promise<void> {
  const [cols] = await pool.query(
    applyPrefix("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{{projects}}' AND COLUMN_NAME = 'visibility'")
  );
  if (Array.isArray(cols) && cols.length > 0) return;
  try {
    await pool.query(applyPrefix("ALTER TABLE {{projects}} ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'public'"));
  } catch (e) {
    console.warn("[db] MySQL projects visibility column add failed:", (e as Error).message);
  }
}

async function migrateMysqlColumn(pool: Pool, table: string, column: string, ddl: string): Promise<void> {
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_PREFIX + table, column]
    );
    if (Array.isArray(cols) && cols.length > 0) return;
    await pool.query(applyPrefix(`ALTER TABLE {{${table}}} ADD COLUMN ${ddl}`));
  } catch (e) {
    console.warn(`[db] MySQL ${table}.${column} column add failed:`, (e as Error).message);
  }
}

async function migrateMysqlIssuesAiStatus(pool: Pool): Promise<void> {
  await migrateMysqlColumn(pool, "issues", "ai_status", "ai_status VARCHAR(32) NOT NULL DEFAULT ''");
  await migrateMysqlColumn(pool, "issues", "model", "model VARCHAR(128) NOT NULL DEFAULT ''");
  await migrateMysqlColumn(pool, "issues", "runtime", "runtime VARCHAR(32) NOT NULL DEFAULT ''");
  await migrateMysqlColumn(pool, "issues", "upstream_issue_number", "upstream_issue_number INT DEFAULT NULL");
  await migrateMysqlColumn(pool, "comments", "model", "model VARCHAR(128) NOT NULL DEFAULT ''");
    await migrateMysqlColumn(pool, "comments", "upstream_comment_id", "upstream_comment_id BIGINT DEFAULT NULL");
  const indexes: Array<[string, string]> = [
    ["uq_issues_project_upstream", applyPrefix("CREATE UNIQUE INDEX uq_issues_project_upstream ON {{issues}} (project_id, upstream_issue_number)")],
    ["uq_comments_upstream", applyPrefix("CREATE UNIQUE INDEX uq_comments_upstream ON {{comments}} (upstream_comment_id)")],
  ];
  for (const [name, sql] of indexes) {
    try {
      const [rows] = await pool.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ? LIMIT 1`,
        [name]
      );
      if (Array.isArray(rows) && rows.length > 0) continue;
      await pool.query(sql);
    } catch (e) {
      const errno = (e as { errno?: number }).errno;
      if (errno === 1061 || errno === 30000) continue;
      console.warn(`[db] MySQL index ${name} create failed:`, (e as Error).message);
    }
  }
}

class MysqlDriver implements AsyncDatabase {
  readonly dialect = "mysql" as const;
  private readonly pool: Pool;
  private txConn: PoolConnection | null = null;
  private constructor(pool: Pool) { this.pool = pool; }

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
      const schema = raw.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
      for (const stmt of schema.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
        try {
          await pool.query(stmt);
        } catch (e) {
          const errno = (e as { errno?: number }).errno;
          if (errno === 1061 || errno === 30000) continue;
          throw e;
        }
      }
      await migrateMysqlSurrogateId(pool);
      await migrateMysqlProjectsVisibility(pool);
      await migrateMysqlIssuesAiStatus(pool);
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
      try { await conn.rollback(); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.txConn = null;
      conn.release();
    }
  }
  async close(): Promise<void> {
    try { await this.pool.end(); } catch { /* already closed */ }
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
      user: process.env.WORK_DB_USER ?? "ework",
      password: process.env.WORK_DB_PASSWORD ?? "",
      database: process.env.WORK_DB_NAME ?? "ework",
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

export async function getConfigAll(): Promise<Record<string, string>> {
  try {
    const driver = getDB();
    try {
      const rows = await driver.all<{ akey: string; value: string }>("SELECT akey, value FROM {{config}}");
      const out: Record<string, string> = {};
      for (const r of rows) out[r.akey] = r.value;
      return out;
    } catch {
      const rows = await driver.all<{ key: string; value: string }>("SELECT key, value FROM {{config}}");
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    }
  } catch {
    return {};
  }
}

export async function setConfig(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await getDB().run(
      "INSERT INTO {{config}} (akey, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(akey) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value, now]
    );
  } catch {
    await getDB().run(
      "INSERT INTO {{config}} (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value, now]
    );
  }
}

export async function deleteConfig(key: string): Promise<void> {
  try {
    await getDB().run("DELETE FROM {{config}} WHERE akey = ?", [key]);
  } catch {
    await getDB().run("DELETE FROM {{config}} WHERE key = ?", [key]);
  }
}
