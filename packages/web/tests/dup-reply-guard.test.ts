import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import {
  addProjectMember, createIssue, createPat, createProject, createUser,
  getProject, postComment,
} from "../src/store";
import { initDB } from "../src/db";

// Duplicate-reply guard: a looping agent re-posts the same reply every turn.
// The API layer answers 429 with a self-describing error so the model can see
// its own loop through the reply tool; the daemon burst breaker stays backstop.

const REPO = "dup-repo-" + (process.pid % 10000) + "-" + Math.floor(Math.random() * 10000);
const PORT = 4597 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
let authHeaders: Record<string, string> = {};

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
  await createUser({ login: "dup-admin", password: "password123", is_admin: true });
  attRoot = mkdtempSync(join(tmpdir(), "ework-dup-"));
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
  const pat = await createPat({ user_login: "dup-admin", name: "dup-test" });
  authHeaders = { authorization: `token ${pat.plaintext}` };
  const project = (await getProject("dup-owner", REPO)) ?? (await createProject("dup-owner", REPO, "d"));
  await addProjectMember(project.id, "dup-admin", "admin");
});

afterAll(() => {
  child?.kill();
  rmSync(attRoot, { recursive: true, force: true });
});

async function makeIssue(): Promise<number> {
  const project = (await getProject("dup-owner", REPO))!;
  const issue = await createIssue(project.id, "dup guard seed " + Math.random(), "seed body", "dup-admin");
  return issue.number;
}

async function postIssueComment(number: number, body: string): Promise<Response> {
  return fetch(`${BASE}/api/v1/repos/dup-owner/${REPO}/issues/${number}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ body }),
  });
}

const LONG_BODY = "进展更新（① 纯代理 + ② V2 启动器）**① 纯代理模式 — 已验证通过** 这是一段足够长的重复回复正文。";

describe("duplicate-reply guard", () => {
  test("identical substantial body from same author within window → 429", async () => {
    const n = await makeIssue();
    const first = await postIssueComment(n, LONG_BODY);
    expect(first.status).toBe(201);
    const dup = await postIssueComment(n, LONG_BODY);
    expect(dup.status).toBe(429);
    const text = await dup.text();
    expect(text).toContain("duplicate reply suppressed");
  });

  test("whitespace-only differences still suppressed", async () => {
    const n = await makeIssue();
    await postIssueComment(n, LONG_BODY);
    const padded = LONG_BODY + "\n\n   \n";
    const dup = await postIssueComment(n, padded);
    expect(dup.status).toBe(429);
  });

  test("different body and short acks pass", async () => {
    const other = await postIssueComment(await makeIssue(), LONG_BODY.replace("已验证通过", "已复测通过"));
    expect(other.status).toBe(201);
    const short1 = await postIssueComment(await makeIssue(), "ok");
    expect(short1.status).toBe(201);
    const short2 = await postIssueComment(await makeIssue(), "ok");
    expect(short2.status).toBe(201);
  });

  test("[system] notices are exempt (identical by design)", async () => {
    const n = await makeIssue();
    const sys = `[system] 🏷 [ses_1](/sessions/ses_1?daemon_id=1) ✓ Message forwarded to **agent** (running).${" ".repeat(20)}`;
    const first = await postIssueComment(n, sys);
    expect(first.status).toBe(201);
    const second = await postIssueComment(n, sys);
    expect(second.status).toBe(201);
  });

  test("stale last comment (outside window) passes", async () => {
    const project = (await getProject("dup-owner", REPO))!;
    const issue = await createIssue(project.id, "dup guard stale", "stale body", "dup-admin");
    await postComment(issue.id, LONG_BODY, "dup-admin", { createdAt: "2020-01-01T00:00:00Z" });
    const res = await fetch(`${BASE}/api/v1/repos/dup-owner/${REPO}/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ body: LONG_BODY }),
    });
    expect(res.status).toBe(201);
  });
});
