// SQLite store. One DB file holds the runtime config table AND the ework schema
// (projects/issues/comments/labels/reactions/attachments/users) so transactions
// span them. Schema is applied on boot via schema.sql.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

const DB_PATH =
  process.env.WORK_DB_PATH ||
  join(process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`, "ework", "ework.db");

let _db: Database | null = null;

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
}

function db(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { create: true, readwrite: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec(
    "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
  // Migration must run BEFORE schema.sql: schema.sql's CREATE TABLE for fresh
  // DBs doesn't help legacy DBs, and any index that references a new column
  // would fail if schema.sql ran first.
  migrateUsersTable(_db);
  migratePatTable(_db);
  migrateProjectsTable(_db);
  _db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  return _db;
}

export function rawDB(): Database {
  return db();
}

export function getConfigAll(): Record<string, string> {
  try {
    const rows = db().query("SELECT key, value FROM config").all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return {};
  }
}

export function setConfig(key: string, value: string): void {
  const now = new Date().toISOString();
  db()
    .query(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, value, now);
}

export function deleteConfig(key: string): void {
  db().query("DELETE FROM config WHERE key = ?").run(key);
}
