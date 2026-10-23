import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

// Reproduces the 2026-10-23 fleet incident: a test process (BUN_TEST set)
// inheriting a production WORK_DB_PATH must be refused at initDB instead of
// wiping real tables. The guard lives in initDB before driver creation.
describe("db guard: BUN_TEST must not open non-temp databases", () => {
  test("refuses inherited production WORK_DB_PATH", async () => {
    // Sibling of tmpdir() — guaranteed outside it regardless of where $TMPDIR
    // points (fleet agents get TMPDIR=<workdir>/.tmp). The guard throws before
    // any file is created.
    const sentinel = join(dirname(tmpdir()), "dbguard-prod-sentinel", "ework.db");
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `process.env.BUN_TEST = "1"; process.env.WORK_DB_PATH = ${JSON.stringify(sentinel)};
         const { initDB } = require("./src/db.ts");
         initDB().then(
           () => { console.error("OPENED"); process.exit(0); },
           (err) => { console.error(err.message); process.exit(3); },
         );`,
      ],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const errText = new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(3);
    expect(errText).toContain("refusing to open non-temp database");
  });

  test("temp WORK_DB_PATH is allowed", async () => {
    const okPath = join(mkdtempSync(join(tmpdir(), "dbguard-ok-")), "ework.db");
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `process.env.BUN_TEST = "1"; process.env.WORK_DB_PATH = ${JSON.stringify(okPath)};
         const { initDB } = require("./src/db.ts");
         initDB().then(
           () => { console.error("OK"); process.exit(0); },
           (err) => { console.error(err.message); process.exit(3); },
         );`,
      ],
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const errText = new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(0);
    expect(errText).toContain("OK");
  });
});
