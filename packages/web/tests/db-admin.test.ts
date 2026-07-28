// Round-trip migration test (sqlite → MySQL). Gated by WORK_MIGRATE_TEST=1
// because it spawns a real MySQL 8.0 container (slow). Default `bun test`
// skips it; run with:
//
//   WORK_MIGRATE_TEST=1 bun test tests/db-admin.test.ts
//
// Override the host port with WORK_MIGRATE_TEST_PORT (default 3313, chosen to
// avoid 3310/3311/3312 used by other tests). Requires Docker.
//
// Run ALONE — not alongside other tests. The migration source is whatever the
// running driver happens to be; default WORK_DB_DRIVER=sqlite (set by
// tests/setup.ts) makes the source sqlite. If the caller's env has
// WORK_DB_DRIVER=mysql, this test would migrate mysql→mysql and the assertions
// would still pass but the test name would be a lie.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createPool, type Pool } from "mysql2/promise";
import { getDB, initDB, setConfig } from "../src/db";
import {
  migrateSqliteToMysql,
  MIGRATION_TABLE_ORDER,
  testMysqlConnection,
  writeMysqlEnv,
  type MysqlTargetOpts,
} from "../src/db-admin";
import {
  addProjectMember,
  addReaction,
  createAttachment,
  createIssue,
  createLabel,
  createPat,
  createProject,
  createUser,
  ensureUser,
  postComment,
  replaceCachedModels,
  setIssueLabel,
} from "../src/store";
import { createWebhook } from "../src/webhooks";

const PORT = Number(process.env.WORK_MIGRATE_TEST_PORT ?? 3313);
const ROOT_PW = "testpw";
const CONTAINER = `ework-migrate-test-${process.pid}`;
const DATABASE = `ework_migrate_test`;
const TARGET_DB_USER = "ework";
const TARGET_DB_PASS = "ework_pw";

const opts: MysqlTargetOpts = {
  host: "127.0.0.1",
  port: PORT,
  user: TARGET_DB_USER,
  password: TARGET_DB_PASS,
  database: DATABASE,
};

// Use root for setup (creating the DB + the limited user). The migration
// itself runs as TARGET_DB_USER to verify the "create-tables + insert" path
// works for a non-root user (the realistic deploy case).
const rootOpts: MysqlTargetOpts = {
  host: "127.0.0.1",
  port: PORT,
  user: "root",
  password: ROOT_PW,
  database: DATABASE,
};

let containerStarted = false;

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer | string) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer | string) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function waitForMysql(maxSeconds = 90): Promise<void> {
  // Same readiness gate as scripts/test-mysql.sh: docker exec mysql -e SELECT 1.
  // NOT mysqladmin ping — the mysql:8.0 entrypoint races a temp socket-only
  // server during init; ping succeeds during the temp phase then races the
  // restart, while a TCP query only succeeds once the real server is up.
  for (let i = 0; i < maxSeconds; i++) {
    const r = await run("docker", [
      "exec", CONTAINER, "mysql",
      "-h", "127.0.0.1", `-p${ROOT_PW}`,
      "-e", "SELECT 1", "--silent",
    ]);
    if (r.code === 0) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`MySQL container ${CONTAINER} did not become ready in ${maxSeconds}s`);
}

describe.skipIf(!process.env.WORK_MIGRATE_TEST)("db-admin: sqlite→mysql round-trip", () => {
  beforeAll(async () => {
    // 1. Populate the running sqlite driver with representative fixture rows
    //    across many tables. Counts are verified after migration, so adding
    //    rows here directly drives the assertions below.
    await initDB();
    await setConfig("test.key", "test.value");
    await setConfig("another.key", "another.value");
    await replaceCachedModels(["zhipu/glm-4o", "openai/gpt-4o-mini"]);
    await createUser({ login: "alice", password: "password123", is_admin: true });
    await ensureUser("bob", "human");
    await ensureUser("carol", "bot");
    const p = await createProject("dog", "repo", "fixture project");
    const issue = await createIssue(p.id, "Migration test issue", "body", "alice");
    const c1 = await postComment(issue.id, "first comment", "alice");
    const c2 = await postComment(issue.id, "second comment", "bob");
    await addReaction(c1.id, "alice", "+1");
    await addReaction(c1.id, "bob", "heart");
    await addReaction(c2.id, "alice", "+1");
    const lab = await createLabel(p.id, { name: "bug", color: "#ff0000" });
    await setIssueLabel(issue.id, lab.id, true);
    await createAttachment({
      uuid: "deadbeef-1234",
      issue_id: issue.id,
      filename: "f.txt",
      content_type: "text/plain",
      size: 42,
      blob_path: "/tmp/f",
      uploaded_by: "alice",
    });
    await addProjectMember(p.id, "bob", "writer");
    await addProjectMember(p.id, "carol", "reader");
    await createWebhook({
      project_id: p.id,
      url: "http://example.com/h",
      secret: "k",
      events: ["issues"],
    });
    await createPat({ user_login: "alice", name: "test-token" });
    await createPat({ user_login: "bob", name: "bob-token" });

    // 2. Start the MySQL container.
    const r = await run("docker", [
      "run", "-d", "--rm", "--name", CONTAINER,
      "-p", `${PORT}:3306`,
      "-e", `MYSQL_ROOT_PASSWORD=${ROOT_PW}`,
      "-e", `MYSQL_DATABASE=${DATABASE}`,
      "-e", `MYSQL_USER=${TARGET_DB_USER}`,
      "-e", `MYSQL_PASSWORD=${TARGET_DB_PASS}`,
      "mysql:8.0",
    ]);
    if (r.code !== 0) {
      throw new Error(`docker run failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    containerStarted = true;
    await waitForMysql();

    // 3. Verify root can connect (sanity check) before the migration tests
    //    use the limited user.
    const rootTest = await testMysqlConnection(rootOpts);
    if (!rootTest.ok) {
      throw new Error(`root connection probe failed: ${rootTest.error}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (containerStarted) {
      await run("docker", ["rm", "-f", CONTAINER]);
    }
  });

  test("testMysqlConnection: ok with good creds + existing DB", async () => {
    const r = await testMysqlConnection(opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.serverVersion.length).toBeGreaterThan(0);
    expect(r.databaseExists).toBe(true);
  });

  test("testMysqlConnection: fails with bad password (redacted)", async () => {
    const bad = { ...opts, password: "definitely-wrong-pw-xyz" };
    const r = await testMysqlConnection(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(0);
    // Password MUST NOT leak into the error message — that's a security
    // requirement on redactPassword().
    expect(r.error).not.toContain("definitely-wrong-pw-xyz");
  });

  test("testMysqlConnection: fails with unreachable host", async () => {
    const r = await testMysqlConnection({
      host: "127.0.0.1",
      port: 1, // nothing listens here
      user: "x",
      password: "x",
      database: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.hint).toBeTruthy();
  });

  test("migrateSqliteToMysql: copies all 14 tables with matching row counts", async () => {
    const r = await migrateSqliteToMysql(opts);
    if (!r.ok) {
      console.error("migrate failed:", r);
    }
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Cross-check against the running sqlite driver's actual counts. We can't
    // hard-code expected counts because the fixture inserts above may grow
    // over time; the contract is "mysql count == sqlite count per table".
    const sqliteCounts = new Map<string, number>();
    const db = getDB();
    for (const t of MIGRATION_TABLE_ORDER) {
      const rows = await db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM {{${t}}}`);
      sqliteCounts.set(t, rows[0]?.c ?? -1);
    }

    // Every table in MIGRATION_TABLE_ORDER must be reported + match source.
    expect(r.tables.length).toBe(MIGRATION_TABLE_ORDER.length);
    for (const entry of r.tables) {
      const sc = sqliteCounts.get(entry.table) ?? -1;
      expect(sc, `table ${entry.table} should have a sqlite count >= 0`).toBeGreaterThanOrEqual(0);
      expect(entry.rows, `mysql count for ${entry.table}`).toBe(sc);
    }

    // Print a comparison table for the human reviewer (the task asks for it).
    const header = ["table", "sqlite", "mysql", "match"];
    const cols = [28, 8, 8, 6];
    const fmtRow = (cells: string[]) =>
      cells.map((c, i) => c.padEnd(cols[i] ?? 0)).join(" ");
    console.log("\n=== migration row-count comparison ===");
    console.log(fmtRow(header));
    for (const entry of r.tables) {
      const sc = sqliteCounts.get(entry.table) ?? -1;
      const match = sc === entry.rows ? "OK" : "FAIL";
      console.log(fmtRow([entry.table, String(sc), String(entry.rows), match]));
    }
    console.log("=======================================\n");
  }, 120_000);

  test("sample data round-trips verbatim (varchar/text/int)", async () => {
    // Open a SEPARATE throwaway pool to read back from MySQL — must NOT touch
    // the running sqlite driver (this simulates the post-migration verification
    // step that the UI will do).
    const pool: Pool = createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      connectionLimit: 2,
      charset: "utf8mb4",
    });
    try {
      const [usersRaw] = await pool.query(
        "SELECT login, display_name, is_admin FROM users WHERE login = ?",
        ["alice"]
      );
      const users = usersRaw as { login: string; display_name: string | null; is_admin: number }[];
      const alice = users[0];
      expect(alice?.login).toBe("alice");
      expect(alice?.is_admin).toBe(1);

      const [issuesRaw] = await pool.query("SELECT title FROM issues LIMIT 1");
      const issues = issuesRaw as { title: string }[];
      const issue0 = issues[0];
      expect(issue0?.title).toBe("Migration test issue");

      const [configRaw] = await pool.query(
        "SELECT `key`, value FROM config WHERE `key` = ?",
        ["test.key"]
      );
      const config = configRaw as { key: string; value: string }[];
      const cfg0 = config[0];
      expect(cfg0?.value).toBe("test.value");

      // Reactions use a composite PK + FK to comments and users — verify the
      // graph migrated intact.
      const [reactionsRaw] = await pool.query(
        "SELECT COUNT(*) AS c FROM reactions"
      );
      const reactions = reactionsRaw as { c: number }[];
      expect(reactions[0]?.c).toBe(3);
    } finally {
      try { await pool.end(); } catch { /* already ended */ }
    }
  });

  test("migrate is idempotent: re-running produces identical counts", async () => {
    const db = getDB();
    const sqliteCounts = new Map<string, number>();
    for (const t of MIGRATION_TABLE_ORDER) {
      const rows = await db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM {{${t}}}`);
      sqliteCounts.set(t, rows[0]?.c ?? -1);
    }

    const r1 = await migrateSqliteToMysql(opts);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const r2 = await migrateSqliteToMysql(opts);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    for (const e2 of r2.tables) {
      const sc = sqliteCounts.get(e2.table) ?? -1;
      expect(e2.rows, `second-run count for ${e2.table}`).toBe(sc);
    }
  }, 120_000);

  test("writeMysqlEnv: forward-fills .env without clobbering unrelated keys", async () => {
    // Use a PID-suffixed temp file so the test never touches the real .env.
    const fs = await import("fs");
    const path = await import("path");
    const tmp = path.join("/tmp", `ework-migrate-env-${process.pid}.env`);
    const original = [
      "# header comment",
      "WORK_PORT=3002",
      "WORK_TOKEN=secret-token-abc",
      "",
      "# db section below",
      "WORK_DB_DRIVER=sqlite",
      "WORK_DB_HOST=old-host",
    ].join("\n");
    fs.writeFileSync(tmp, original, "utf8");

    try {
      const r = await writeMysqlEnv(tmp, opts);
      expect(r.envPath).toBe(tmp);
      const written = new Set(r.written);
      expect(written.has("WORK_DB_DRIVER")).toBe(true);
      expect(written.has("WORK_DB_HOST")).toBe(true);
      expect(written.has("WORK_DB_PORT")).toBe(true);
      expect(written.has("WORK_DB_USER")).toBe(true);
      expect(written.has("WORK_DB_PASSWORD")).toBe(true);
      expect(written.has("WORK_DB_NAME")).toBe(true);

      const after = fs.readFileSync(tmp, "utf8");
      expect(after).toContain("WORK_PORT=3002");
      expect(after).toContain("WORK_TOKEN=secret-token-abc");
      expect(after).toContain("# header comment");
      expect(after).toContain("WORK_DB_DRIVER=mysql");
      expect(after).toContain(`WORK_DB_HOST=${opts.host}`);
      expect(after).toContain(`WORK_DB_PORT=${opts.port}`);
      expect(after).toContain(`WORK_DB_NAME=${opts.database}`);
      expect(after).not.toContain("old-host");
      expect(after).toContain(`WORK_DB_PASSWORD=${opts.password}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  });
});
