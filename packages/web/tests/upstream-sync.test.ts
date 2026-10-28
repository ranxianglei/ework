import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createProject,
  ensureUser,
  getIssueByUpstreamNumber,
  getCommentByUpstreamId,
  getProject,
  getProjectUpstreamUrls,
  getUpstreamSync,
  listIssues,
  setProjectUpstreamUrls,
  upsertUpstreamSync,
  type UpstreamSyncRow,
} from "../src/store";
import { createWebhook, waitForWebhookQueueIdle } from "../src/webhooks";
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
let listUrls: string[] = [];

beforeAll(async () => {
  await initDB();
});

afterEach(async () => {
  await Bun.sleep(20);
  await waitForWebhookQueueIdle(15_000).catch(() => {});
  globalThis.fetch = originalFetch;
  hookCalls = [];
  issuePages = [];
  repoComments = [];
  issueComments = {};
  listUrls = [];
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
  await Bun.sleep(20);
  await waitForWebhookQueueIdle(15_000).catch(() => {});
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
      listUrls.push(url);
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

  test("imports a listing-lagged issue even when its updated_at is below the cursor (billion-context#1306)", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1)]];
    issueComments = { 1: [] };
    mockFetch();
    await makeSyncer(sync).pollOnce();
    await settle();
    const cursor = (await getUpstreamSync(projectId))!.issue_cursor!;
    expect(cursor).toBe("2026-08-01T00:00:11Z");
    hookCalls = [];

    issuePages = [[giteaIssue(2, { created_at: "2026-08-01T00:00:05Z", updated_at: "2026-08-01T00:00:05Z" })]];
    issueComments = { 2: [] };
    repoComments = [];
    const r = await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    await settle();

    expect(r.issuesImported).toBe(1);
    expect(await getIssueByUpstreamNumber(projectId, 2)).toBeTruthy();
    expect(hookCalls.some((c) => c.body?.action === "opened")).toBe(true);
  });

  test("cursor still dedupes state syncs of already-mirrored rows", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1)]];
    issueComments = { 1: [] };
    mockFetch();
    await makeSyncer(sync).pollOnce();
    await settle();
    hookCalls = [];

    issuePages = [[giteaIssue(1, { updated_at: "2026-08-01T00:00:11Z" })]];
    repoComments = [];
    const r = await makeSyncer((await getUpstreamSync(projectId))!).pollOnce();
    await settle();

    expect(r.issuesImported).toBe(0);
    expect(r.issuesUpdated).toBe(0);
    expect(hookCalls.length).toBe(0);
  });

  test("backfill lists all states, not just open, and imports closed history", async () => {
    const { sync } = await setup();
    issuePages = [[giteaIssue(1), giteaIssue(2, { state: "closed" })]];
    issueComments = { 1: [], 2: [] };
    mockFetch();

    const r = await makeSyncer(sync).pollOnce();
    await settle();

    expect(listUrls[0]).toContain("state=all");
    expect(r.issuesImported).toBe(2);
    expect((await getIssueByUpstreamNumber(projectId, 2))?.state).toBe("closed");
  });
});

describe("syncOrigin", () => {
  test("prefers first public origin, falls back to local port", () => {
    const cfg = { publicOrigins: ["http://ex.example/"], port: 3000 } as unknown as Config;
    expect(syncOrigin(cfg)).toBe("http://ex.example");
    expect(syncOrigin({ publicOrigins: [], port: 3002 } as unknown as Config)).toBe("http://127.0.0.1:3002");
  });
});

describe("upstream sync defaults project upstream_urls", () => {
  test("enabled sync on a project without upstream_urls defaults them", async () => {
    const project = await createProject("acme", "jumpless", "root");
    await upsertUpstreamSync(project.id, {
      baseUrl: "http://gitea.local",
      upstreamOwner: "acme",
      upstreamRepo: "widget",
      enabled: true,
    });
    const after = await getProject("acme", "jumpless");
    expect(getProjectUpstreamUrls(after!)).toEqual(["http://gitea.local/acme/widget"]);
  });

  test("api.github.com base is normalized to the github.com web base", async () => {
    const project = await createProject("acme", "apibase", "root");
    await upsertUpstreamSync(project.id, {
      baseUrl: "https://api.github.com",
      upstreamOwner: "ranxianglei",
      upstreamRepo: "ework",
      enabled: true,
    });
    const after = await getProject("acme", "apibase");
    expect(getProjectUpstreamUrls(after!)).toEqual(["https://github.com/ranxianglei/ework"]);
  });

  test("explicitly configured upstream_urls are never overwritten", async () => {
    const project = await createProject("acme", "explicit", "root");
    await setProjectUpstreamUrls(project.id, ["https://example.com/custom"]);
    await upsertUpstreamSync(project.id, {
      baseUrl: "https://github.com",
      upstreamOwner: "acme",
      upstreamRepo: "explicit",
      enabled: true,
    });
    const after = await getProject("acme", "explicit");
    expect(getProjectUpstreamUrls(after!)).toEqual(["https://example.com/custom"]);
  });
});

test("master head movement clears merge-probe bookkeeping (owner incident 2026-10-26 #4801)", async () => {
  // Quiet PRs that turn conflicting via a master merge were never re-probed:
  // probe eligibility keyed on PR-side activity. The invalidation on master
  // head movement is the fix — verified here against the preloaded test DB
  // (setup.ts owns WORK_DB_PATH; tests must never re-point it mid-run or the
  // process-global db singleton poisons every later file).
  const { getDB } = await import("../src/db");
  const db = getDB();
  const { createIssue, createProject } = await import("../src/store");
  const proj = await createProject("mvhead-owner", "billion-context", "");
  const pid = proj.id;
  const quiet = await createIssue(pid, "quiet pr", "", "dog", { upstreamIssueNumber: 4801, state: "open" });
  const plain = await createIssue(pid, "plain issue", "", "dog", { kind: "issue", upstreamIssueNumber: 2, state: "open" });
  const shut = await createIssue(pid, "closed pr", "", "dog", { upstreamIssueNumber: 3, state: "closed" });
  await db.run("UPDATE issues SET upstream_merge_checked_at = '2026-10-26T08:00:00Z' WHERE id IN (?, ?)", [quiet.id, shut.id]);

  const mod: any = await import("../src/upstream-sync");
  const us = Object.create(mod.UpstreamSync.prototype);
  Object.defineProperty(us, "isGithub", { value: true }); // private getter — shadow it per-instance
  us.project = { id: pid };
  us.lastMasterHead = "aaa111222333";
  us.mergeReprobeQueue = [];
  const fetchedUrls: string[] = [];
  us.fetchJson = async (url: string) => {
    fetchedUrls.push(url);
    if (url.startsWith("/pulls?")) return [{ number: 4801 }];
    return { sha: "bbb999888777" };
  };
  await mod.UpstreamSync.prototype.clearMergeProbesIfMasterMoved.call(us);
  const row: any = await db.get("SELECT upstream_merge_checked_at c FROM issues WHERE id = ?", [quiet.id]);
  const closed: any = await db.get("SELECT upstream_merge_checked_at c FROM issues WHERE id = ?", [shut.id]);
  const issue: any = await db.get("SELECT upstream_merge_checked_at c FROM issues WHERE id = ?", [plain.id]);
  expect(fetchedUrls.some((u) => u.startsWith("/commits/master"))).toBe(true);
  expect(us.mergeReprobeQueue).toContain(4801);
  expect(row.c).toBe(null);
  expect(closed.c ?? "untouched").toBe("2026-10-26T08:00:00Z");
  expect(issue.c ?? "untouched").toBe("untouched");
  expect(us.lastMasterHead).toBe("bbb999888777");
  // second run with the same head must NOT re-clear (no churn)
  await mod.UpstreamSync.prototype.clearMergeProbesIfMasterMoved.call(us);
  expect(us.lastMasterHead).toBe("bbb999888777");

  // drain: the queued quiet PR reads dirty → row flips + conflict bookkeeping set
  us.fetchJson = async (url: string) =>
    url.startsWith("/pulls/4801") ? { mergeable: false, mergeable_state: "dirty" } : ({} as any);
  us.origin = "http://origin";
  await mod.UpstreamSync.prototype.drainMergeReprobe.call(us, { issuesUpdated: 0 } as any);
  const after: any = await db.get("SELECT upstream_mergeable_state ms, upstream_conflict_state cs FROM issues WHERE id = ?", [quiet.id]);
  expect(after.ms).toBe("dirty");
  expect(after.cs).toContain("lastEmit");
  expect(us.mergeReprobeQueue.length).toBe(0);
});

test("in-flight CI suites park quiet PRs on a re-probe queue until completion (owner incident 2026-10-26 #4794)", async () => {
  // GitHub's PR updated_at does not change when check-runs complete, so a PR
  // whose suite is still running drops out of the changed-item stream and its
  // red would never emit. The suite must be followed to completion directly.
  const { getDB } = await import("../src/db");
  const db = getDB();
  const { createIssue, createProject } = await import("../src/store");
  const proj = await createProject("cireprobe-owner", "billion-context", "");
  const pr = await createIssue(proj.id, "[PR] kernel lockfile churn", "", "dog", { upstreamIssueNumber: 4794, state: "open" });

  const mod: any = await import("../src/upstream-sync");
  const us = Object.create(mod.UpstreamSync.prototype);
  Object.defineProperty(us, "isGithub", { value: true });
  us.project = { id: proj.id, owner: "ranxianglei", name: "billion-context" };
  us.ciReprobeQueue = [];
  us.origin = "http://origin";
  let completed = false;
  us.fetchJson = async (url: string) => {
    if (url.startsWith("/pulls/4794")) return { head: { sha: "sha4794" } };
    if (url.startsWith("/commits/sha4794/check-runs")) {
      return completed
        ? { check_runs: [
            { name: "test", status: "completed", conclusion: "success" },
            { name: "kernel-guard", status: "completed", conclusion: "failure" },
          ] }
        : { check_runs: [
            { name: "test", status: "in_progress", conclusion: null },
            { name: "kernel-guard", status: "completed", conclusion: "failure" },
          ] };
    }
    return {} as any;
  };

  // 1) stream-path probe sees an in-progress suite → parks the PR, decides nothing
  await mod.UpstreamSync.prototype.probeCiState.call(us, { number: 4794 }, pr, { issuesUpdated: 0 } as any);
  expect(us.ciReprobeQueue).toContain(4794);
  let row: any = await db.get("SELECT upstream_ci_state s FROM issues WHERE id = ?", [pr.id]);
  expect(row.s).toBe(null);

  // 2) drain while still in-progress → stays parked, still no premature green/red decision
  await mod.UpstreamSync.prototype.drainCiReprobe.call(us, { issuesUpdated: 0 } as any);
  expect(us.ciReprobeQueue).toContain(4794);

  // 3) suite completes with a failure → drain emits and records attempt bookkeeping
  const { createWebhook } = await import("../src/webhooks");
  await createWebhook({ project_id: proj.id, url: "http://hook.local/x", secret: "s3cret" });
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init?.body) posted.push(String(init.body));
    return { ok: true, status: 200, text: async () => "" } as any;
  }) as any;
  try {
    completed = true;
    await mod.UpstreamSync.prototype.drainCiReprobe.call(us, { issuesUpdated: 0 } as any);
    expect(posted.some((b) => b.includes("ci_failed") && b.includes("4794"))).toBe(true);
    // let the webhook queue drain while the stub still answers, so afterEach
    // does not wait on undeliverable posts against the restored real fetch
    const { waitForWebhookQueueIdle } = await import("../src/webhooks");
    await waitForWebhookQueueIdle(4_000).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  row = await db.get("SELECT upstream_ci_state s FROM issues WHERE id = ?", [pr.id]);
  expect(row.s).toContain("attempts");
  expect(us.ciReprobeQueue.length).toBe(0);
});

test("merge-guard truth poll emits pr_unmergeable on dirty/behind transitions only (owner directive 2026-10-26)", async () => {
  const { getDB } = await import("../src/db");
  const db = getDB();
  const { createIssue, createProject } = await import("../src/store");
  const proj = await createProject("mguard-owner", "billion-context", "");
  await createIssue(proj.id, "[PR] dirty one", "", "dog", { upstreamIssueNumber: 501, state: "open" });
  await createIssue(proj.id, "[PR] behind one", "", "dog", { upstreamIssueNumber: 502, state: "open" });
  await createIssue(proj.id, "[PR] clean one", "", "dog", { upstreamIssueNumber: 503, state: "open" });
  await createIssue(proj.id, "[PR] blocked red", "", "dog", { upstreamIssueNumber: 504, state: "open" });
  await createIssue(proj.id, "[PR] blocked green", "", "dog", { upstreamIssueNumber: 505, state: "open" });

  const mod: any = await import("../src/upstream-sync");
  const us = Object.create(mod.UpstreamSync.prototype);
  Object.defineProperty(us, "isGithub", { value: true });
  us.project = { id: proj.id, owner: "ranxianglei", name: "billion-context" };
  us.mergeGuardTick = 0;
  us.mergeGuardCursor = 0;
  us.mergeGuardLastEmit = new Map();
  us.origin = "http://origin";
  let stale = false;
  // Guard reads PR truth via GraphQL pagination (REST fan-out retired for
  // quota — owner directive 2026-10-28); blocked check-runs probes stay REST.
  us.fetchGql = async (_q: string, vars: Record<string, unknown>) => {
    const updated = new Date(Date.now() - (stale ? 100 * 3600_000 : 3600_000)).toISOString();
    if (vars.end) return { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    const node = (n: number, ms: string, sha?: string) => ({ number: n, updatedAt: updated, mergeableState: ms, headRefOid: sha });
    return {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false },
          nodes: [node(501, "DIRTY"), node(502, "BEHIND"), node(503, "CLEAN"), node(504, "BLOCKED", "abc123"), node(505, "BLOCKED", "def456")],
        },
      },
    };
  };
  us.fetchJson = async (url: string) => {
    if (url.includes("/commits/abc123/check-runs"))
      return { total_count: 2, check_runs: [
        { name: "test (u22)", status: "completed", conclusion: "success" },
        { name: "test (u24)", status: "completed", conclusion: "failure", html_url: "http://x" },
      ] };
    if (url.includes("/commits/def456/check-runs"))
      return { total_count: 1, check_runs: [{ name: "test (u22)", status: "completed", conclusion: "success" }] };
    return {} as any;
  };

  const { createWebhook } = await import("../src/webhooks");
  await createWebhook({ project_id: proj.id, url: "http://hook.local/g", secret: "s3cret" });
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init?.body) posted.push(String(init.body));
    return { ok: true, status: 200, text: async () => "" } as any;
  }) as any;
  try {
    await mod.UpstreamSync.prototype.pollMergeGuard.call(us);
    const { waitForWebhookQueueIdle } = await import("../src/webhooks");
    await waitForWebhookQueueIdle(4_000).catch(() => {});
    expect(posted.some((b) => b.includes("pr_unmergeable") && b.includes("501") && b.includes("conflict"))).toBe(true);
    expect(posted.some((b) => b.includes("pr_unmergeable") && b.includes("502") && b.includes("behind"))).toBe(true);
    expect(posted.some((b) => b.includes("ci_failed") && b.includes("504") && b.includes("abc123"))).toBe(true);
    expect(posted.some((b) => b.includes("ci_failed") && b.includes("505"))).toBe(false);
    expect(posted.some((b) => b.includes("503"))).toBe(false);

    // same bad states within the 6h re-arm window → no re-emit
    posted.length = 0;
    await mod.UpstreamSync.prototype.pollMergeGuard.call(us);
    expect(posted.length).toBe(0);

    // a PR older than 72h is outside the scan horizon
    posted.length = 0;
    stale = true;
    us.mergeGuardLastEmit.clear();
    await mod.UpstreamSync.prototype.pollMergeGuard.call(us);
    expect(posted.length).toBe(0);
    await waitForWebhookQueueIdle(4_000).catch(() => {});
  } finally {
    globalThis.fetch = realFetch;
  }
  const row: any = await db.get("SELECT upstream_merge_guard_at g FROM issues i JOIN (SELECT id FROM issues WHERE project_id = ? AND upstream_issue_number = 501) t ON i.id = t.id", [proj.id]);
  expect(row.g).toBeTruthy();
});

test("applyCiState persists the global check cache workers read instead of gh-polling (owner directive 2026-10-27)", async () => {
  const { getDB } = await import("../src/db");
  const db = getDB();
  const { createIssue, createProject } = await import("../src/store");
  const proj = await createProject("checkcache-owner", "billion-context", "");
  const pr = await createIssue(proj.id, "[PR] cache me", "", "dog", { upstreamIssueNumber: 5101, state: "open" });

  const mod: any = await import("../src/upstream-sync");
  const us = Object.create(mod.UpstreamSync.prototype);
  Object.defineProperty(us, "isGithub", { value: true });
  us.project = { id: proj.id, owner: "ranxianglei", name: "billion-context" };
  us.ciReprobeQueue = [];
  us.origin = "http://origin";
  let completed = false;
  us.fetchJson = async (url: string) => {
    if (url.startsWith("/pulls/5101")) return { head: { sha: "sha5101" }, mergeable_state: "dirty" };
    if (url.startsWith("/commits/sha5101/check-runs")) {
      return { check_runs: completed
        ? [{ name: "test", status: "completed", conclusion: "success" }]
        : [{ name: "test", status: "in_progress", conclusion: null }] };
    }
    return {} as any;
  };

  // 1) in-progress suite → snapshot cached with live status (workers watch this)
  await mod.UpstreamSync.prototype.applyCiState.call(us, 5101, pr, { issuesUpdated: 0 } as any);
  let row: any = await db.get("SELECT upstream_checks c FROM issues WHERE id = ?", [pr.id]);
  let snap = JSON.parse(row.c);
  expect(snap.sha).toBe("sha5101");
  expect(snap.mergeable_state).toBe("dirty");
  expect(snap.checks[0].status).toBe("in_progress");

  // 2) suite completes → snapshot refreshed with conclusions
  completed = true;
  await mod.UpstreamSync.prototype.applyCiState.call(us, 5101, pr, { issuesUpdated: 0 } as any);
  row = await db.get("SELECT upstream_checks c FROM issues WHERE id = ?", [pr.id]);
  snap = JSON.parse(row.c);
  expect(snap.checks[0].conclusion).toBe("success");
  expect(snap.fetched_at).toBeTruthy();
});
