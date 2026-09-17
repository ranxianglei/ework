import { describe, expect, it } from "bun:test";
import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { ISOLATED_DB_ENV_KEYS, isolatedDbPath, assertIsolatedDbEnv } from "./env-isolation";
import { RESOLVED_DB_PATH } from "../src/db";

// Regression suite for ranxianglei/ework#7: no test process may ever open a
// database pointed at by inherited daemon env vars.

describe("test DB isolation (ranxianglei/ework#7)", () => {
  it("preload pinned WORK_DB_PATH under the system tmpdir", () => {
    assertIsolatedDbEnv();
    expect(isolatedDbPath().startsWith(tmpdir())).toBe(true);
    expect(process.env.WORK_DB_PATH).toBe(isolatedDbPath());
  });

  it("incident variables are absent from the test process env", () => {
    for (const key of ISOLATED_DB_ENV_KEYS) {
      if (key === "WORK_DB_PATH") continue;
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("src/db resolved the pinned path, not an inherited one", () => {
    expect(RESOLVED_DB_PATH).toBe(isolatedDbPath());
  });

  it("child sim: inherited DAEMON_DB_PATH cannot reach the prod DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ework-daemon-isosim-"));
    const fakeProd = join(dir, "prod.db");
    try {
      const childScript = join(dirname(import.meta.path), "db-isolation-child.ts");
      const proc = spawn({
        cmd: ["bun", "run", childScript],
        env: { ...process.env, FAKE_PROD_DB: fakeProd },
        stdout: "pipe",
        stderr: "inherit",
      });
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();
      const lastLine = out.trim().split("\n").pop() ?? "";
      expect(code).toBe(0);
      const res = JSON.parse(lastLine) as { resolved: string; fakeProd: string };
      // The isolation layer must redirect the child away from the inherited
      // production pointer, into a throwaway file under tmpdir.
      expect(res.resolved).not.toBe(res.fakeProd);
      expect(res.resolved.startsWith(tmpdir())).toBe(true);
      // The incident assertion itself: the "production" file must never be
      // created or touched by a test process.
      expect(existsSync(fakeProd)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
