import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { initDB } from "../src/db";

// GitHub-synced comments embed remote screenshots (user-attachments). The
// CSP must not be the thing that hides them: img-src has to allow https:.

const PORT_BASE = 4731 + (process.pid % 200);
let BASE = `http://127.0.0.1:${PORT_BASE}`;

let child: ReturnType<typeof Bun.spawn> | null = null;
let attRoot: string;
let childErr = "";

function spawnWeb(port: number): void {
  childErr = "";
  child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      WORK_PORT: String(port),
      WORK_TOKEN: process.env.WORK_TOKEN ?? "test-token-123",
      WORK_COOKIE_SECRET: process.env.WORK_COOKIE_SECRET ?? "test-cookie-secret-123",
      WORK_ATTACHMENT_ROOT: attRoot,
      WORK_DB_PATH: process.env.WORK_DB_PATH,
      WORK_WEBHOOK_SECRET: "whsec-test",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain stderr continuously (a full pipe blocks the child) and keep its
  // tail — the child logs nowhere else, so without this a boot failure in CI
  // surfaces only as an opaque 20s timeout.
  const stream = child.stderr;
  if (stream instanceof ReadableStream) {
    void (async () => {
      const dec = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        childErr += dec.decode(value);
        if (childErr.length > 8192) childErr = childErr.slice(-4096);
      }
    })();
  }
}

async function waitUntilUp(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status < 500) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`web did not come up on ${BASE} within 20s; child stderr tail:\n${childErr.slice(-3000)}`);
}

beforeAll(async () => {
  await initDB();
  attRoot = mkdtempSync(join(tmpdir(), "ework-csp-"));
  // One retry on a fresh port: recurring CI flake (runs 35182466080,
  // 35173704025, 35181154567) had the child fail to come up within 20s with
  // stderr discarded — a transient boot/port collision now self-heals, and a
  // real boot failure fails with the child's own log tail in the error.
  for (let attempt = 0; ; attempt++) {
    const port = attempt === 0 ? PORT_BASE : PORT_BASE + 200 + Math.floor(Math.random() * 8000);
    BASE = `http://127.0.0.1:${port}`;
    spawnWeb(port);
    try {
      await waitUntilUp();
      return;
    } catch (err) {
      child?.kill();
      child = null;
      if (attempt >= 1) throw err;
    }
  }
});

afterAll(() => {
  child?.kill();
  try { rmSync(attRoot, { recursive: true, force: true }); } catch {}
});

test("img-src allows remote https images (GitHub-synced screenshots)", async () => {
  const res = await fetch(`${BASE}/login`);
  const csp = res.headers.get("content-security-policy") ?? "";
  const imgSrc = /img-src ([^;]+)/.exec(csp)?.[1] ?? "";
  expect(imgSrc).toContain("https:");
});

test("scripts remain self-only", async () => {
  const res = await fetch(`${BASE}/login`);
  const csp = res.headers.get("content-security-policy") ?? "";
  const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
  expect(scriptSrc).toBe("'self'");
});
