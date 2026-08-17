import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createProject,
  ensureUser,
  getIssueByUpstreamNumber,
  getCommentByUpstreamId,
  getUpstreamSync,
  listIssues,
  upsertUpstreamSync,
  type UpstreamSyncRow,
} from "../src/store";
import { createWebhook } from "../src/webhooks";
import { UpstreamSync, syncOrigin } from "../src/upstream-sync";
import { parseUpstreamSyncForm } from "../src/views/projectUpstreams";
import type { Config } from "../src/config";

const UPSTREAM = "http://gitea.local";
const HOOK = "http://hook.local/cb";
const originalFetch = globalThis.fetch;

let projectId = 0;
let hookCalls: { url: string; body: any }[] = [];
let issuePages: any[][] = [];
let repoComments: any[] = [];
let issueComments: Record<number, any[]> = {};

beforeAll(async () => {
  await initDB();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  hookCalls = [];
  issuePages = [];
  repoComments = [];
  issueComments = {};
  await new Promise((r) => setTimeout(r, 60));
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["comments", "issues", "webhooks", "webhook_deliveries", "upstream_sync", "projects", "users"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
});

function giteaIssue(n: number, over: Partial<any> = {}): any {
  return {
    number: n,
    title: `upstream #${n}`,
    body: `body of ${n}`,
    state: "open",
    user: { login: "alice" },
    created_at: `2026-08-01T00:00:${String(10 + n).padStart(2, "0")}Z`,
    updated_at: `2026-08-01T00:00:${String(10 + n).padStart(2, "0")}Z`,
    ...over,
  };
}

function giteaComment(id: number, issueNumber: number, over: Partial<any> = {}): any {
  const sec = String(10 + (id % 50)).padStart(2, "0");
  return {
    id,
    body: `comment ${id}`,
    user: { login: "bob" },
    created_at: `2026-08-01T01:00:${sec}Z`,
    updated_at: `2026-08-01T01:00:${sec}Z`,
    issue_url: `${UPSTREAM}/api/v1/repos/acme/widget/issues/${issueNumber}`,
    ...over,
  };
}

function freshTs(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

async function settle() {
  await new Promise((r) => setTimeout(r, 80));
}

function mockFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOOK)) {
      hookCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    }
    if (url.startsWith(`${UPSTREAM}/api/v1/repos/acme/widget/issues/comments`)) {
      return Response.json(repoComments);
    }
    const perIssue = url.match(/\/issues\/(\d+)\/comments/);
    if (perIssue) {
      return Response.json(issueComments[Number(perIssue[1])] ?? []);
    }
    if (url.startsWith(`${UPSTREAM}/api/v1/repos/acme/widget/issues`)) {
      return Response.json(issuePages.shift() ?? []);
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

async function setup(enabled = true): Promise<{ sync: UpstreamSyncRow }> {
  await ensureUser("root");
  const project = await createProject("acme", "widget", "root");
  projectId = project.id;
  await createWebhook({ project_id: project.id, url: HOOK, events: ["issues", "issue_comment"] });
  const sync = await upsertUpstreamSync(project.id, {
    baseUrl: UPSTREAM,
    upstreamOwner: "acme",
    upstreamRepo: "widget",
    enabled,
    pollIntervalMs: 10_000,
  });
  return { sync };
}

function makeSyncer(sync: UpstreamSyncRow): UpstreamSync {
  const project = { id: projectId, owner: "acme", name: "widget" } as any;
  return new UpstreamSync(sync, project, "http://web.local");
}

describe("upsertUpstreamSync", () => {
  test("normalizes trailing slash and /api/v1 suffix", async () => {
    await setup(false);
    const row = await upsertUpstreamSync(projectId, {
      baseUrl: `${UPSTREAM}/api/v1/`,
      upstreamOwner: "acme",
      upstreamRepo: "widget",
    });
    expect(row.base_url).toBe(UPSTREAM);
  });

  test("rejects non-http base url and interval < 10s", async () => {
    await setup(false);
    await expect(
      upsertUpstreamSync(projectId, {
        baseUrl: "git@gitea.local:acme/widget.git",
        upstreamOwner: "acme",
        upstreamRepo: "widget",
      })
    ).rejects.toThrow(/http/);
    await expect(
      upsertUpstreamSync(projectId, {
        baseUrl: UPSTREAM,
        upstreamOwner: "acme",
        upstreamRepo: "widget",
        pollIntervalMs: 5_000,
      })
    ).rejects.toThrow(/10/);
  });

  test("keeps stored token when form leaves it empty", async () => {
    await setup(false);
    await upsertUpstreamSync(projectId, { baseUrl: UPSTREAM, upstreamOwner: "acme", upstreamRepo: "widget", token: "sec" });
    const row = await upsertUpstreamSync(projectId, { baseUrl: UPSTREAM, upstreamOwner: "acme", upstreamRepo: "widget" });
    expect(row.token).toBe("sec");
  });
});

describe("parseUpstreamSyncForm", () => {
  const mk = (fields: Record<string, string>) => ({ get: (n: string) => fields[n] ?? null });

  test("parses fields and clamps interval", () => {
    const out = parseUpstreamSyncForm(mk({ base_url: `${UPSTREAM}/`, upstream_owner: "acme", upstream_repo: "widget", poll_interval: "3", enabled: "1" }));
    expect(out.baseUrl).toBe(`${UPSTREAM}/`);
    expect(out.enabled).toBe(true);
    expect(out.pollIntervalMs).toBe(60_000);
  });

  test("empty token stays undefined", () => {
    const out = parseUpstreamSyncForm(mk({ base_url: UPSTREAM, upstream_owner: "a", upstream_repo: "b", token: "  " }));
    expect(out.token).toBeUndefined();
    expect(out.enabled).toBe(false);
  });
});

describe("backfill (first poll, silent)", () => {
  test("imports open issues + comments without webhooks, sets cursors", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1), giteaIssue(2)]];
    issueComments = { 1: [giteaComment(101, 1)], 2: [] };
    mockFetch();

    const r = await makeSyncer(sync).pollOnce();
    await settle();

    expect(r.issuesImported).toBe(2);
    expect(r.commentsImported).toBe(1);
    expect(hookCalls.length).toBe(0);

    const i1 = await getIssueByUpstreamNumber(projectId, 1);
    const i2 = await getIssueByUpstreamNumber(projectId, 2);
    expect(i1?.title).toBe("upstream #1");
    expect(i1?.author).toBe("alice");
    expect(i2).toBeTruthy();
    expect(await getCommentByUpstreamId(101)).toBeTruthy();

    const after = await getUpstreamSync(projectId);
    expect(after?.issue_cursor).toBe("2026-08-01T00:00:12Z");
    expect(after?.comment_cursor).toBe("2026-08-01T00:00:12Z");
  });

  test("is idempotent on rerun", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1)]];
    issueComments = { 1: [] };
    mockFetch();
    await makeSyncer(sync).pollOnce();
    await settle();

    issuePages = [[giteaIssue(1)]];
    const r2 = await makeSyncer(sync).pollOnce();
    await settle();
    expect(r2.issuesImported).toBe(0);
    expect((await listIssues(projectId)).length).toBe(1);
  });
});

describe("live poll (emits webhooks)", () => {
  test("new upstream issue emits opened + imports its comments", async () => {
    await setup();
    // advance to live mode by seeding cursors through a backfill
    issuePages = [[]];
    repoComments = [];
    mockFetch();
    await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    hookCalls = [];

    issuePages = [[giteaIssue(5, { created_at: freshTs(), updated_at: freshTs() })]];
    issueComments = { 5: [giteaComment(501, 5, { created_at: freshTs(), updated_at: freshTs() })] };
    repoComments = [giteaComment(501, 5, { created_at: freshTs(), updated_at: freshTs() })];
    const r = await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    await settle();

    expect(r.issuesImported).toBe(1);
    expect(r.commentsImported).toBeGreaterThanOrEqual(1);
    const actions = hookCalls.map((c) => c.body?.action).sort();
    expect(actions).toContain("opened");
    expect(hookCalls.length).toBeGreaterThanOrEqual(2);
    const i5 = await getIssueByUpstreamNumber(projectId, 5);
    expect(i5).toBeTruthy();
  });

  test("upstream close propagates and emits closed", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1)]];
    issueComments = { 1: [] };
    mockFetch();
    await makeSyncer(sync).pollOnce();
    await settle();
    hookCalls = [];

    const cursor = (await getUpstreamSync(projectId))!.issue_cursor!;
    issuePages = [[giteaIssue(1, { state: "closed", updated_at: freshTs() })]];
    repoComments = [];
    const r = await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    await settle();

    expect(r.issuesUpdated).toBe(1);
    expect((await getIssueByUpstreamNumber(projectId, 1))?.state).toBe("closed");
    expect(hookCalls.some((c) => c.body?.action === "closed")).toBe(true);
    expect(cursor).toBeTruthy();
  });

  test("comment on repo-wide feed maps to local issue via issue_url", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1)]];
    issueComments = { 1: [] };
    mockFetch();
    await makeSyncer(sync).pollOnce();
    await settle();
    hookCalls = [];

    issuePages = [[]];
    repoComments = [giteaComment(777, 1, { created_at: freshTs(), updated_at: freshTs() })];
    const r = await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    await settle();

    expect(r.commentsImported).toBe(1);
    expect(await getCommentByUpstreamId(777)).toBeTruthy();
    expect(hookCalls.some((c) => c.body?.action === "created")).toBe(true);
  });
});

describe("syncOrigin", () => {
  test("prefers first public origin, falls back to local port", () => {
    const cfg = { publicOrigins: ["http://ex.example/"], port: 3000 } as unknown as Config;
    expect(syncOrigin(cfg)).toBe("http://ex.example");
    expect(syncOrigin({ publicOrigins: [], port: 3002 } as unknown as Config)).toBe("http://127.0.0.1:3002");
  });
});
