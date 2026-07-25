// DB-backend UI — Phase 1 (pure logic, no HTTP).
//
// Three primitives for the migration wizard: testMysqlConnection (probe a
// target without side effects), migrateSqliteToMysql (copy every table from
// the running sqlite driver into a throwaway mysql pool), writeMysqlEnv
// (forward-fill .env). Design spec: docs/db-backend-ui.md §4.1 + §4.3.
//
// The throwaway-pool pattern is load-bearing: every function opens a NEW
// mysql2 pool with caller-supplied creds and closes it before returning. The
// running driver (getDB(), opened once at boot) is never touched, so the
// wizard can fail/retry without affecting live traffic.

import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { getDB } from "./db";

export interface MysqlTargetOpts {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Optional table prefix for the target. Empty = no prefix. Validated
   *  against the same identifier rule as WORK_DB_PREFIX in db.ts so generated
   *  SQL can't be SQL-injected via the prefix. */
  prefix?: string;
}

export type TestMysqlResult =
  | { ok: true; serverVersion: string; databaseExists: boolean }
  | { ok: false; error: string; hint?: string };

export type MigrateResult =
  | { ok: true; tables: { table: string; rows: number }[] }
  | { ok: false; error: string; partial?: string[] };

export type WriteEnvResult = { written: string[]; envPath: string };

// FK-safe copy order (parents before children). `config` lives first — it's
// created in db.ts (not in schema.sql), has no FK deps, and holds the
// migration wizard's own settings. We additionally SET FOREIGN_KEY_CHECKS=0
// during the copy as belt-and-suspenders; keeping the array FK-ordered still
// matches what a manual dump/restore would do.
//
// When adding a table, update this list AND schema.sql + schema-mysql.sql —
// otherwise migrate() silently skips the new table.
export const MIGRATION_TABLE_ORDER = [
  "config",
  "users",
  "projects",
  "model_cache",
  "issues",
  "labels",
  "comments",
  "issue_labels",
  "reactions",
  "attachments",
  "webhooks",
  "personal_access_tokens",
  "project_members",
  "webhook_deliveries",
] as const;

/** Rewrite {{token}} -> prefix+token. Mirrors db.ts:applyPrefix but takes a
 *  caller-supplied prefix — the target may differ from the running driver's
 *  (module-private) prefix, and importing DB_PREFIX would couple this module
 *  to the boot-time env. */
function applyTargetPrefix(sql: string, prefix: string): string {
  if (!sql.includes("{{")) return sql;
  return sql.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => prefix + name);
}

function validatePrefix(p: string): string {
  const v = (p ?? "").trim();
  if (v && !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(v)) {
    throw new Error(
      `Invalid DB prefix "${v}": must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$`
    );
  }
  return v;
}

/** Redact password-shaped substrings from connection-string-like output.
 *  Covers URL-style `://user:pw@host`, querystring `?password=...` /
 *  `&password=...`, and shell `password='...'` / `password="..."`. */
function redactPassword(s: string): string {
  return s
    .replace(/(:\/\/[^:/@]*):[^@/]*@/g, "$1:***@")
    .replace(/[?&]password=[^&\s]*/gi, (m) => m.charAt(0) + "password=***")
    .replace(/password\s*=\s*'[^']*'/gi, "password='***'")
    .replace(/password\s*=\s*"[^"]*"/gi, 'password="***"');
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size) as T[]);
  }
  return out;
}

/** Strip `--` comment lines BEFORE splitting on `;` — comment lines may
 *  contain `;` and corrupt the split (same trick as db.ts:MysqlDriver.create). */
function readSchemaMysqlStatements(prefix: string): string[] {
  const raw = readFileSync(join(import.meta.dir, "schema-mysql.sql"), "utf8");
  const stripped = raw
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  for (const stmt of stripped.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    out.push(applyTargetPrefix(stmt, prefix));
  }
  return out;
}

function hintForError(msg: string): string | undefined {
  const lc = msg.toLowerCase();
  if (lc.includes("econnrefused") || lc.includes("enotfound") || lc.includes("etimedout")) {
    return "Check host and port; is MySQL running and reachable from this host?";
  }
  if (lc.includes("access denied") || lc.includes("error 1045") || lc.includes("er_access_denied")) {
    return "Bad username or password.";
  }
  if (lc.includes("unknown database") || lc.includes("error 1049")) {
    return "Create the database first, or grant CREATE to the user so migrate() can create it.";
  }
  if (lc.includes("ssl") || lc.includes("tls")) {
    return "TLS/SSL handshake failed — check MySQL's TLS config and the client's ssl mode.";
  }
  return undefined;
}

/** Backtick-quote a SQL identifier. Doubles internal backticks per the MySQL
 *  escape rule. */
function ident(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export async function testMysqlConnection(opts: MysqlTargetOpts): Promise<TestMysqlResult> {
  let pool: Pool | null = null;
  let conn: PoolConnection | null = null;
  try {
    // No database selected at handshake — we may be probing a DB that doesn't
    // exist yet (user has CREATE but hasn't run it). Selecting a non-existent
    // DB at connect time would fail the handshake.
    pool = createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      waitForConnections: true,
      connectionLimit: 2,
      charset: "utf8mb4",
      connectTimeout: 10_000,
    });

    conn = await pool.getConnection();
    // A real query, NOT mysqladmin ping — the mysql:8.0 entrypoint races a
    // temp socket-only server during init; ping succeeds during the temp
    // phase and races the restart. See scripts/test-mysql.sh.
    const [versionRowsRaw] = await conn.query("SELECT VERSION() AS v");
    const versionRows = versionRowsRaw as { v: string }[];
    const version0 = versionRows[0];
    const serverVersion = version0?.v ?? "unknown";

    const [dbRowsRaw] = await conn.query(
      "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
      [opts.database]
    );
    const dbRows = dbRowsRaw as { SCHEMA_NAME: string }[];
    const databaseExists = dbRows.length > 0;

    // Best-effort privilege check. We can't cleanly ask "do I have CREATE on
    // a not-yet-existent DB?" without parsing SHOW GRANTS (the GRANT syntax
    // has many shapes). If the DB doesn't exist, require CREATE anywhere in
    // the user's grants. False negatives are fine — the user can create the
    // DB by hand; false positives get caught at migrate().
    let hasCreate = true;
    if (!databaseExists) {
      const [grantsRaw] = await conn.query("SHOW GRANTS FOR CURRENT_USER()");
      const grantsRows = grantsRaw as Record<string, string>[];
      const grants = grantsRows
        .map((r) => Object.values(r)[0])
        .filter((v): v is string => typeof v === "string");
      hasCreate = grants.some((g) => /\bCREATE\b/i.test(g));
    }

    if (!databaseExists && !hasCreate) {
      return {
        ok: false,
        error: `Database "${opts.database}" does not exist and user "${opts.user}" has no CREATE privilege`,
        hint: "Create the database first (CREATE DATABASE ... CHARACTER SET utf8mb4) or grant CREATE on it to the user.",
      };
    }

    return { ok: true, serverVersion, databaseExists };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: redactPassword(msg),
      hint: hintForError(msg),
    };
  } finally {
    if (conn) {
      try { conn.release(); } catch (e) { console.warn("[db-admin] conn.release failed:", e); }
    }
    if (pool) {
      try { await pool.end(); } catch (e) { console.warn("[db-admin] pool.end failed:", e); }
    }
  }
}

export async function migrateSqliteToMysql(opts: MysqlTargetOpts): Promise<MigrateResult> {
  const prefix = validatePrefix(opts.prefix ?? "");
  let pool: Pool | null = null;
  let conn: PoolConnection | null = null;
  const completed: { table: string; rows: number }[] = [];

  try {
    // Pool WITHOUT `database`: if the target DB doesn't exist yet (the common
    // migration-wizard case), selecting it at handshake would fail with
    // "Unknown database". We CREATE + USE on a single held connection below.
    //
    // Holding ONE connection for the whole migrate() is load-bearing:
    // USE, FOREIGN_KEY_CHECKS, and transactions are all session-scoped. With
    // a pool, sequential pool.query() calls can land on different underlying
    // connections, so session state set on one wouldn't apply to the next.
    // One held connection makes that state deterministic.
    pool = createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      waitForConnections: true,
      connectionLimit: 2,
      charset: "utf8mb4",
    });

    conn = await pool.getConnection();

    await conn.query(
      `CREATE DATABASE IF NOT EXISTS ${ident(opts.database)} CHARACTER SET utf8mb4`
    );
    await conn.query(`USE ${ident(opts.database)}`);

    // The `config` table is created in db.ts:SqliteDriver.create at boot but
    // is missing from schema-mysql.sql (pre-existing gap — MysqlDriver.create
    // doesn't create it either, so a plain mysql boot has no config table).
    // Recreate the same shape here so migrate() can copy config rows. `key`
    // is a MySQL reserved word — must be backticked. VARCHAR(255) on the PK
    // because MySQL TEXT can't be a PRIMARY KEY without a prefix length.
    await conn.query(
      applyTargetPrefix(
        "CREATE TABLE IF NOT EXISTS {{config}} (" +
          "`key` VARCHAR(255) PRIMARY KEY," +
          "value TEXT NOT NULL," +
          "updated_at VARCHAR(40) NOT NULL" +
          ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        prefix
      )
    );

    // Apply schema-mysql.sql. CREATE INDEX lacks IF NOT EXISTS in MySQL, so
    // tolerate ER_DUP_KEYNAME (1061) for re-runs.
    for (const stmt of readSchemaMysqlStatements(prefix)) {
      try {
        await conn.query(stmt);
      } catch (e) {
        if (
          e && typeof e === "object" && "errno" in e &&
          (e as { errno: number }).errno === 1061
        ) {
          continue;
        }
        throw e;
      }
    }

    // Idempotent re-run: TRUNCATE resets data + AUTO_INCREMENT. FK_CHECKS=0
    // lets us TRUNCATE tables that are referenced by others (TRUNCATE
    // otherwise refuses even on empty data). Stays 0 for the whole copy
    // phase; reset to 1 once every table has been inserted + verified.
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of MIGRATION_TABLE_ORDER) {
      await conn.query(`TRUNCATE TABLE ${ident(prefix + t)}`);
    }

    const sqlite = getDB();
    for (const table of MIGRATION_TABLE_ORDER) {
      const rows = await sqlite.all<Record<string, unknown>>(
        `SELECT * FROM {{${table}}}`
      );
      if (rows.length === 0) {
        completed.push({ table, rows: 0 });
        continue;
      }
      const first = rows[0];
      if (!first) {
        // Unreachable given length>0; noUncheckedIndexedAccess forces the guard.
        completed.push({ table, rows: 0 });
        continue;
      }
      const cols = Object.keys(first);
      if (cols.length === 0) {
        completed.push({ table, rows: rows.length });
        continue;
      }

      // `INSERT INTO t (a,b) VALUES ?` with a 2D array — mysql2 expands the
      // nested arrays into a comma-separated value list. undefined → null
      // (sqlite rows shouldn't have undefined fields, but JS-side defaults
      // sometimes do; mysql2 rejects undefined).
      const insertSql =
        `INSERT INTO ${ident(prefix + table)}` +
        ` (${cols.map(ident).join(",")}) VALUES ?`;

      // Per-table transaction: a bad batch rolls back THIS table's inserts
      // without touching earlier tables. (DDL above already auto-committed;
      // only the INSERTs are transactional.)
      try {
        await conn.beginTransaction();
        for (const batch of chunk(rows, 500)) {
          const matrix: unknown[][] = batch.map((r) =>
            cols.map((c) => {
              const v = r[c];
              return v === undefined ? null : v;
            })
          );
          await conn.query(insertSql, [matrix]);
        }
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch (rollbackErr) {
          console.warn("[db-admin] rollback failed for", table, ":", rollbackErr);
        }
        throw e;
      }

      const [cntRowsRaw] = await conn.query(
        `SELECT COUNT(*) AS c FROM ${ident(prefix + table)}`
      );
      const cntRows = cntRowsRaw as { c: number }[];
      const cnt0 = cntRows[0];
      const mysqlCount = cnt0?.c ?? -1;
      if (mysqlCount !== rows.length) {
        throw new Error(
          `Row-count mismatch for ${prefix}${table}: sqlite=${rows.length} mysql=${mysqlCount}`
        );
      }
      completed.push({ table, rows: rows.length });
    }

    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    return { ok: true, tables: completed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // DDL above auto-committed (MySQL implicit commit on DDL), so ROLLBACK
    // wouldn't undo CREATE TABLE. Explicitly DROP every half-built table so
    // the next migrate() call starts from a clean target.
    if (conn) {
      try {
        await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        for (const t of MIGRATION_TABLE_ORDER) {
          await conn.query(`DROP TABLE IF EXISTS ${ident(prefix + t)}`);
        }
        await conn.query("SET FOREIGN_KEY_CHECKS = 1");
      } catch (cleanupErr) {
        // The migrate() failure is the primary signal. A cleanup failure
        // leaves stale tables; the next migrate() run will TRUNCATE them.
        console.warn("[db-admin] cleanup DROP TABLES failed:", cleanupErr);
      }
    }
    return {
      ok: false,
      error: redactPassword(msg),
      partial: completed.map((c) => `${c.table}=${c.rows}`),
    };
  } finally {
    if (conn) {
      try { conn.release(); } catch (e) { console.warn("[db-admin] conn.release failed:", e); }
    }
    if (pool) {
      try { await pool.end(); } catch (e) { console.warn("[db-admin] pool.end failed:", e); }
    }
  }
}

export async function writeMysqlEnv(
  envPath: string,
  opts: MysqlTargetOpts
): Promise<WriteEnvResult> {
  const prefix = validatePrefix(opts.prefix ?? "");

  // PASSWORD is written verbatim — the .env file is mode 0600 (deploy.sh
  // enforces) and the existing .env format is bare KEY=VALUE (see
  // .env.example). If a password contains '#' or whitespace, the user must
  // hand-quote; we don't try to be smart about shell quoting because Bun's
  // env loader / systemd EnvironmentFile is the source of truth.
  const desired: Record<string, string> = {
    WORK_DB_DRIVER: "mysql",
    WORK_DB_HOST: opts.host,
    WORK_DB_PORT: String(opts.port),
    WORK_DB_USER: opts.user,
    WORK_DB_PASSWORD: opts.password,
    WORK_DB_NAME: opts.database,
  };
  if (prefix) desired.WORK_DB_PREFIX = prefix;

  const linesIn = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split(/\r?\n/)
    : [];

  const written: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];

  // First pass: update existing keys in place (preserves comments + order).
  // Matches the project's .env style: `KEY=VALUE`, no surrounding quotes.
  for (const line of linesIn) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      const key = m[1] ?? "";
      if (key in desired) {
        out.push(`${key}=${desired[key] ?? ""}`);
        written.push(key);
        seen.add(key);
        continue;
      }
    }
    out.push(line);
  }

  // Second pass: append missing keys under a legible banner.
  const missing = Object.keys(desired).filter((k) => !seen.has(k));
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push("# ework-web: MySQL backend (written by db-admin migration)");
    for (const k of missing) {
      out.push(`${k}=${desired[k] ?? ""}`);
      written.push(k);
    }
  }

  writeFileSync(envPath, out.join("\n") + "\n", "utf8");
  return { written, envPath };
}

// Reverse migration: MySQL → SQLite. Creates a fresh SQLite file at targetPath,
// applies schema.sql, copies all 14 tables from the running MySQL driver.
// Used as the safety net when the MySQL switch goes wrong.
export async function migrateMysqlToSqlite(targetPath: string): Promise<MigrateResult> {
  const target = new Database(targetPath, { create: true, readwrite: true });
  const completed: { table: string; rows: number }[] = [];

  try {
    target.exec("PRAGMA journal_mode = WAL");
    target.exec("PRAGMA foreign_keys = ON");

    // config table (same shape as db.ts:144 — not in schema.sql).
    // `key` is NOT reserved in SQLite (unlike MySQL).
    target.exec(
      applyTargetPrefix(
        "CREATE TABLE IF NOT EXISTS {{config}} (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
        ""
      )
    );

    // schema.sql — bun:sqlite's exec handles the whole file (comments + multi-statement).
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    target.exec(applyTargetPrefix(schema, ""));

    const source = getDB();
    for (const table of MIGRATION_TABLE_ORDER) {
      const rows = await source.all<Record<string, unknown>>(`SELECT * FROM {{${table}}}`);
      if (rows.length === 0) {
        completed.push({ table, rows: 0 });
        continue;
      }
      const first = rows[0];
      if (!first) {
        completed.push({ table, rows: 0 });
        continue;
      }
      const cols = Object.keys(first);
      if (cols.length === 0) {
        completed.push({ table, rows: rows.length });
        continue;
      }

      const placeholders = cols.map(() => "?").join(",");
      const insertSql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`;

      target.transaction(() => {
        for (const row of rows) {
          const vals = cols.map((c) => {
            const v = (row as Record<string, unknown>)[c];
            return v === undefined ? null : v;
          });
          target.query(insertSql).run(...(vals as SQLQueryBindings[]));
        }
      })();

      const countRow = target.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | null;
      const count = countRow?.c ?? -1;
      if (count !== rows.length) {
        throw new Error(`Row-count mismatch for ${table}: mysql=${rows.length} sqlite=${count}`);
      }
      completed.push({ table, rows: rows.length });
    }

    target.close();
    return { ok: true, tables: completed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try { target.close(); } catch { /* already closed */ }
    try { unlinkSync(targetPath); } catch { /* file may not exist */ }
    return { ok: false, error: redactPassword(msg), partial: completed.map((c) => `${c.table}=${c.rows}`) };
  }
}

export async function writeSqliteEnv(envPath: string, dbPath: string): Promise<WriteEnvResult> {
  const desired: Record<string, string> = {
    WORK_DB_DRIVER: "sqlite",
    WORK_DB_PATH: dbPath,
  };

  const linesIn = existsSync(envPath)
    ? readFileSync(envPath, "utf8").split(/\r?\n/)
    : [];

  const written: string[] = [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const line of linesIn) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) {
      const key = m[1] ?? "";
      if (key in desired) {
        out.push(`${key}=${desired[key] ?? ""}`);
        written.push(key);
        seen.add(key);
        continue;
      }
    }
    out.push(line);
  }

  const missing = Object.keys(desired).filter((k) => !seen.has(k));
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push("# ework-web: revert to SQLite (written by db-admin migration)");
    for (const k of missing) {
      out.push(`${k}=${desired[k] ?? ""}`);
      written.push(k);
    }
  }

  writeFileSync(envPath, out.join("\n") + "\n", "utf8");
  return { written, envPath };
}
