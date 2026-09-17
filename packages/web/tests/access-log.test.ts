import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Regression (issue #4): during the 2026-09-17 disk-full incident every
// request 500'd while the access log was unwritable. appendAccessLog must be
// best-effort: any write failure (ENOSPC/EACCES/ENOTDIR) degrades to a warn
// and the request still succeeds. To make the failure deterministic without
// filling a disk, point WORK_ACCESS_LOG at a path whose parent is a regular
// file — appendFileSync then throws ENOTDIR on every request.

const PORT = 4531 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = join(tmpdir(), `ework-accesslog-test-${Date.now()}`);

let child: ReturnType<typeof Bun.spawn> | null = null;
let stderrBuf = "";

async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`web exited early (code ${child.exitCode}): ${stderrBuf.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`web did not come up on ${BASE}: ${stderrBuf.slice(-2000)}`);
}

beforeAll(async () => {
  // Parent of the access-log path is a regular file → ENOTDIR on append.
  const blocker = join(TMP, "blocker");
  mkdirSync(TMP, { recursive: true });
  writeFileSync(blocker, "x");

  child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      WORK_PORT: String(PORT),
      WORK_HOST: "127.0.0.1",
      WORK_TOKEN: "test-token-accesslog",
      WORK_COOKIE_SECRET: "test-cookie-secret",
      WORK_DB_PATH: join(TMP, "web.db"),
      WORK_ATTACHMENT_ROOT: join(TMP, "attachments"),
      WORK_ACCESS_LOG: join(blocker, "sub", "access.log"),
      WORK_AUTOWIRE_ACTIVE: "false",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = child.stderr;
  if (err && typeof err !== "number") {
    void err.pipeTo(new WritableStream({
      write(chunk) { stderrBuf += Buffer.from(chunk).toString(); },
    }));
  }
  await waitUntilUp();
});

afterAll(() => {
  try { child?.kill("SIGKILL"); } catch { /* already dead */ }
  rmSync(TMP, { recursive: true, force: true });
});

test("requests still succeed when the access log cannot be written", async () => {
  const res = await fetch(`${BASE}/healthz`);
  expect(res.status).toBe(200);
});

test("subsequent requests keep succeeding (failure is per-request, not fatal)", async () => {
  const res = await fetch(`${BASE}/projects`);
  // unauthenticated redirect or page — anything except a 500 proves the
  // handler survived another failed log append
  expect(res.status).not.toBe(500);
});
