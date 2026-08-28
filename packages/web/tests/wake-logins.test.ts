import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addProjectMember, createIssue, createProject, ensureUser } from "../src/store";
import { initDB } from "../src/db";

// Wake whitelist API + AI-tab form regression. /api/v1/wake-logins feeds the
// daemon's projectWakeLogins() merge (fail-closed on error), and the POST
// route is also the backend of the issue-page ＋白名单 button (json=1 mode).

const PORT = 4391 + (process.pid % 200);
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

const OWNER = "dog";
const REPO = `wl${process.pid % 1000}`;

test("GET returns empty list before any config, then POST add merges case-insensitively", async () => {
  await ensureUser("dog");
  await createProject(OWNER, REPO, "wake whitelist");

  const get0 = await fetch(`${BASE}/api/v1/wake-logins?owner=${OWNER}&repo=${REPO}`, {
    headers: { Cookie: cookie },
  });
  expect(get0.status).toBe(200);
  expect(((await get0.json()) as { logins: string[] }).logins).toEqual([]);

  const add = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ add: "Stirp" }),
  });
  expect(add.status).toBe(200);
  let logins = ((await add.json()) as { logins: string[] }).logins;
  expect(logins).toEqual(["Stirp"]);

  const addDupe = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ add: "stirp" }),
  });
  logins = ((await addDupe.json()) as { logins: string[] }).logins;
  expect(logins).toEqual(["Stirp"]);

  const get1 = await fetch(`${BASE}/api/v1/wake-logins?owner=${OWNER}&repo=${REPO}`, {
    headers: { Cookie: cookie },
  });
  expect(((await get1.json()) as { logins: string[] }).logins).toEqual(["Stirp"]);
});

test("POST textarea replaces the whole list; clearing deletes the config key", async () => {
  const replace = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ logins: "alice, bob\ncharlie" }),
  });
  const logins = ((await replace.json()) as { logins: string[] }).logins;
  expect(logins.sort()).toEqual(["alice", "bob", "charlie"].sort());

  const clear = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ logins: "" }),
  });
  expect(((await clear.json()) as { logins: string[] }).logins).toEqual([]);

  const get = await fetch(`${BASE}/api/v1/wake-logins?owner=${OWNER}&repo=${REPO}`, {
    headers: { Cookie: cookie },
  });
  expect(((await get.json()) as { logins: string[] }).logins).toEqual([]);
});

test("invalid logins are rejected, not silently stored", async () => {
  const res = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ add: "bad login!" }),
  });
  expect(res.status).toBe(400);
});

test("unauthenticated callers cannot read or write the whitelist", async () => {
  const get = await fetch(`${BASE}/api/v1/wake-logins?owner=${OWNER}&repo=${REPO}`);
  expect(get.status).toBe(401);

  const post = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ add: "someone" }),
  });
  expect(post.status).toBe(302);
  expect(new URL(post.headers.get("location") ?? "", BASE).pathname).toBe("/login");
});

test("AI settings page renders the wake whitelist card with current entries", async () => {
  await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai/wake-logins?json=1`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: new URLSearchParams({ add: "stirp" }),
  });
  const page = await fetch(`${BASE}/${OWNER}/${REPO}/settings/ai`, { headers: { Cookie: cookie } });
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain("唤醒白名单");
  expect(html).toContain("stirp");
});

test("issue page shows submitter; external humans get a ＋白名单 form", async () => {
  const AREPO = `wla${process.pid % 1000}`;
  await ensureUser("dog");
  await ensureUser("Rika-xie", "human");
  await ensureUser("merge-app[bot]", "bot");
  const project = await createProject(OWNER, AREPO, "author line");
  await addProjectMember(project.id, "dog", "admin");
  const ext = await createIssue(project.id, "upstream report", "body", "Rika-xie");
  const bot = await createIssue(project.id, "[PR] automated change", "body", "merge-app[bot]");
  const own = await createIssue(project.id, "local issue", "body", "dog");

  const base = `${BASE}/${OWNER}/${AREPO}/issues`;
  const extHtml = await (await fetch(`${base}/${ext.number}`, { headers: { Cookie: cookie } })).text();
  expect(extHtml).toContain('由 <strong>Rika-xie</strong> 提交');
  expect(extHtml).toContain(`name="add" value="Rika-xie"`);
  expect(extHtml).toContain(`name="back" value="/${OWNER}/${AREPO}/issues/${ext.number}"`);

  const botHtml = await (await fetch(`${base}/${bot.number}`, { headers: { Cookie: cookie } })).text();
  expect(botHtml).toContain('由 <strong>merge-app[bot]</strong> 提交');
  expect(botHtml).toContain('kind-tag">bot');
  expect(botHtml).not.toContain(`name="add" value="merge-app[bot]"`);

  const ownHtml = await (await fetch(`${base}/${own.number}`, { headers: { Cookie: cookie } })).text();
  expect(ownHtml).toContain('由 <strong>dog</strong> 提交');
  expect(ownHtml).not.toContain(`name="add" value="dog"`);
});

test("submitter ＋白名单 form posts and the button disappears once whitelisted", async () => {
  const AREPO = `wlb${process.pid % 1000}`;
  await ensureUser("Rika-xie", "human");
  const project = await createProject(OWNER, AREPO, "author line 2");
  const ext = await createIssue(project.id, "another report", "body", "Rika-xie");

  const form = new URLSearchParams({ add: "Rika-xie", back: `/${OWNER}/${AREPO}/issues/${ext.number}` });
  const post = await fetch(`${BASE}/${OWNER}/${AREPO}/settings/ai/wake-logins`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
    redirect: "manual",
  });
  expect(post.status).toBe(303);
  const loc = post.headers.get("location") ?? "";
  expect(loc).toContain(`/${OWNER}/${AREPO}/issues/${ext.number}`);
  expect(decodeURIComponent(loc)).toContain("已把 Rika-xie 加入唤醒白名单");

  const page = await fetch(`${BASE}/${OWNER}/${AREPO}/issues/${ext.number}`, { headers: { Cookie: cookie } });
  const html = await page.text();
  expect(html).toContain('由 <strong>Rika-xie</strong> 提交');
  expect(html).not.toContain(`name="add" value="Rika-xie"`);
});
