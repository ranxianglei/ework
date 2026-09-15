import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { initDB } from "../src/db";

// GitHub-synced comments embed remote screenshots (user-attachments). The
// CSP must not be the thing that hides them: img-src has to allow https:.

const PORT = 4731 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ReturnType<typeof Bun.spawn> | null = null;
let attRoot: string;

async function waitUntilUp(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status < 500) return;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`web did not come up on ${BASE}`);
}

beforeAll(async () => {
  await initDB();
  attRoot = mkdtempSync(join(tmpdir(), "ework-csp-"));
  child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      WORK_PORT: String(PORT),
      WORK_TOKEN: process.env.WORK_TOKEN ?? "test-token-123",
      WORK_COOKIE_SECRET: process.env.WORK_COOKIE_SECRET ?? "test-cookie-secret-123",
      WORK_ATTACHMENT_ROOT: attRoot,
      WORK_DB_PATH: process.env.WORK_DB_PATH,
      WORK_WEBHOOK_SECRET: "whsec-test",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitUntilUp();
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
