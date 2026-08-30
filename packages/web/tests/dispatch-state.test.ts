import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue, createProject, ensureUser, getProject, updateIssueAiStatus } from "../src/store";
import { initDB, setConfig } from "../src/db";

// Regression test: /api/v1/dispatch-state used to be shadowed by the Gitea
// shim catch-all 404, so daemons always saw "blocked" and dispatch died.
// The route now lives inside the /api/v1/ block, ahead of handleGiteaApi.

const PORT = 4371 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
let cookie = "";

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    body: new URLSearchParams({ token: process.env.WORK_TOKEN ?? "" }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`login failed: ${res.status}`);
  cookie = setCookie.split(";")[0] ?? "";
}

function fetchAuth(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { Cookie: cookie } });
}
const OWNER = "dog";
const REPO = `dsreg${process.pid % 1000}`;

let child: ReturnType<typeof Bun.spawn> | null = null;

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
  child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      WORK_PORT: String(PORT),
      WORK_DB_PATH: process.env.WORK_DB_PATH ?? "",
      WORK_AUTOWIRE_ACTIVE: "false",
      WORK_WEBHOOK_MAX_CONCURRENT: "3",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitUntilUp();
  await login();
});

afterAll(() => {
  child?.kill();
  child?.exited;
});

test("dispatch-state returns 200 with real issue state (not shim 404)", async () => {
  await ensureUser("dog");
  const project = await createProject(OWNER, REPO, "dispatch-state regression");
  const issue = await createIssue(project.id, "t", "b", "dog");

  const res = await fetchAuth(`${BASE}/api/v1/dispatch-state?owner=${OWNER}&repo=${REPO}&number=${issue.number}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { dispatchOff: boolean; aiStatus: string };
  expect(body.dispatchOff).toBe(false);
  expect(body.aiStatus).toBe("");

  await updateIssueAiStatus(issue.id, "dispatch_off");
  const res2 = await fetchAuth(`${BASE}/api/v1/dispatch-state?owner=${OWNER}&repo=${REPO}&number=${issue.number}`);
  expect(res2.status).toBe(200);
  const body2 = (await res2.json()) as { dispatchOff: boolean; aiStatus: string };
  expect(body2.dispatchOff).toBe(true);
  expect(body2.aiStatus).toBe("dispatch_off");
});

test("dispatch-state reports global and project dispatch-off switches", async () => {
  const q = `owner=${OWNER}&repo=${REPO}&number=1`;
  await setConfig(`dispatchOff:${OWNER}/${REPO}`, "1");
  const projectOff = (await (await fetchAuth(`${BASE}/api/v1/dispatch-state?${q}`)).json()) as {
    dispatchOff: boolean;
  };
  expect(projectOff.dispatchOff).toBe(true);
  await setConfig(`dispatchOff:${OWNER}/${REPO}`, "0");

  await setConfig("dispatchEnabled", "false");
  const globalOff = (await (await fetchAuth(`${BASE}/api/v1/dispatch-state?${q}`)).json()) as {
    dispatchOff: boolean;
  };
  expect(globalOff.dispatchOff).toBe(true);
  await setConfig("dispatchEnabled", "true");
});

test("dispatch-state tolerates unknown project and missing params", async () => {
  const unknown = await fetchAuth(`${BASE}/api/v1/dispatch-state?owner=ghost&repo=none&number=9`);
  expect(unknown.status).toBe(200);
  const unknownBody = (await unknown.json()) as { dispatchOff: boolean; aiStatus: string };
  expect(unknownBody.dispatchOff).toBe(false);

  const missing = await fetchAuth(`${BASE}/api/v1/dispatch-state?owner=a`);
  expect(missing.status).toBe(400);
});

test("reset-session button: sets marker, surfaces in dispatch-state, renders on page", async () => {
  await ensureUser("dog");
  const project = (await getProject(OWNER, REPO)) ?? (await createProject(OWNER, REPO, "reset-session"));
  const issue = await createIssue(project.id, "t", "b", "dog");

  const before = (await (await fetchAuth(
    `${BASE}/api/v1/dispatch-state?owner=${OWNER}&repo=${REPO}&number=${issue.number}`,
  )).json()) as { sessionResetMs: number | null };
  expect(before.sessionResetMs).toBeNull();

  const btn = await fetchAuth(`${BASE}/${OWNER}/${REPO}/issues/${issue.number}/reset-session`, { method: "POST" });
  expect(btn.status).toBe(200);
  expect(((await btn.json()) as { ok: boolean }).ok).toBe(true);

  const after = (await (await fetchAuth(
    `${BASE}/api/v1/dispatch-state?owner=${OWNER}&repo=${REPO}&number=${issue.number}`,
  )).json()) as { sessionResetMs: number | null };
  expect(after.sessionResetMs).not.toBeNull();
  expect(after.sessionResetMs!).toBeGreaterThan(1_700_000_000_000);

  const page = await fetchAuth(`${BASE}/${OWNER}/${REPO}/issues/${issue.number}`);
  const html = await page.text();
  expect(html).toContain(`issues/${issue.number}/reset-session`);
  expect(html).toContain("🔄 重置会话");
});
