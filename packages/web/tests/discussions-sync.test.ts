import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createProject,
  createIssue,
  getIssueByUpstreamNumber,
  getCommentByUpstreamId,
  getUpstreamSync,
  upsertUpstreamSync,
  updateUpstreamSyncState,
  type UpstreamSyncRow,
} from "../src/store";
import { createWebhook, waitForWebhookQueueIdle } from "../src/webhooks";
import { UpstreamSync } from "../src/upstream-sync";

const HOOK = "http://hook.local/cb";
const originalFetch = globalThis.fetch;

let hookCalls: { url: string; body: any }[] = [];
let discussionList: any[] = [];
let discussionComments: Record<number, any[]> = {};
let issueList: any[] = [];

function discussion(n: number, over: Partial<any> = {}): any {
  const ts = `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`;
  return {
    number: n,
    title: `discussion ${n}`,
    body: `body of discussion ${n}`,
    state: "open",
    user: { login: "carol" },
    created_at: ts,
    updated_at: ts,
    category: { name: "Plugins" },
    ...over,
  };
}

function dcomment(id: number, _n: number, over: Partial<any> = {}): any {
  const ts = `2026-10-01T01:00:${String(id).padStart(2, "0")}Z`;
  return {
    id,
    body: `dcomment ${id}`,
    user: { login: "dave" },
    created_at: ts,
    updated_at: ts,
    ...over,
  };
}

function mockFetch() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOOK)) {
      hookCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    }
    const perDiscussion = url.match(/\/discussions\/(\d+)\/comments/);
    if (perDiscussion) {
      return Response.json(discussionComments[Number(perDiscussion[1])] ?? []);
    }
    if (/\/discussions(\?|$)/.test(url)) {
      return Response.json(discussionList);
    }
    if (/\/issues(\?|$)/.test(url)) {
      return Response.json(issueList);
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

async function settle() {
  await Bun.sleep(20);
  await waitForWebhookQueueIdle(15_000).catch(() => {});
}

async function setup(enabled = true): Promise<{ sync: UpstreamSyncRow }> {
  const project = await createProject("acme", "widget", "test");
  await createWebhook({ project_id: project.id, url: HOOK, secret: "", events: ["issues", "issue_comment"] });
  const sync = await upsertUpstreamSync(project.id, {
    baseUrl: "https://github.com",
    upstreamOwner: "acme",
    upstreamRepo: "widget",
    enabled,
  });
  return { sync };
}

async function makeSyncer(projectId: number, discussions = true): Promise<UpstreamSync> {
  const row = (await getUpstreamSync(projectId))!;
  const project = { id: row.project_id, owner: "acme", name: "widget" } as any;
  return new UpstreamSync(row, project, "http://web.local", discussions);
}

describe("discussions sync", () => {
  beforeAll(async () => {
    await initDB();
  });

  afterEach(async () => {
    await settle();
    globalThis.fetch = originalFetch;
    hookCalls = [];
    discussionList = [];
    discussionComments = {};
    issueList = [];
    const db = getDB();
    const mysql = db.dialect === "mysql";
    await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
    for (const t of ["comments", "issues", "webhooks", "webhook_deliveries", "upstream_sync", "projects", "users"]) {
      await db.exec(`DELETE FROM {{${t}}}`);
    }
    await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
  });

  test("backfill imports discussions and comments silently, sets cursor", async () => {
    const { sync } = await setup();
    mockFetch();
    discussionList = [discussion(11), discussion(12, { state: "closed" })];
    discussionComments[11] = [dcomment(1, 11)];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const d11 = await getIssueByUpstreamNumber(sync.project_id, 11, "discussion");
    const d12 = await getIssueByUpstreamNumber(sync.project_id, 12, "discussion");
    expect(d11?.kind).toBe("discussion");
    expect(d11?.title).toBe("[Plugins] discussion 11");
    expect(d12?.state).toBe("closed");
    expect(await getCommentByUpstreamId(1)).toBeTruthy();
    expect(hookCalls.length).toBe(0);
    const row = await getUpstreamSync(sync.project_id);
    expect(row?.discussion_cursor).toBeTruthy();
  });

  test("live poll emits opened and comment events for new activity", async () => {
    const { sync } = await setup();
    mockFetch();
    await updateUpstreamSyncState(sync.project_id, {
      issueCursor: "2026-09-01T00:00:00Z",
      commentCursor: "2026-09-01T00:00:00Z",
      discussionCursor: "2026-09-01T00:00:00Z",
    });
    discussionList = [discussion(21, { updated_at: "2026-10-02T00:00:00Z" })];
    discussionComments[21] = [dcomment(2, 21)];
    issueList = [];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const opened = hookCalls.find((c) => c.body.action === "opened");
    const commented = hookCalls.find((c) => c.body.action === "created");
    expect(opened?.body.issue.kind).toBe("discussion");
    expect(commented?.body.issue.kind).toBe("discussion");
    const local = await getIssueByUpstreamNumber(sync.project_id, 21, "discussion");
    expect(local).toBeTruthy();
  });

  test("discussion and issue sharing an upstream number coexist via kind", async () => {
    const { sync } = await setup();
    const issue = await createIssue(sync.project_id, "real issue", "b", "alice", { upstreamIssueNumber: 5, number: 5 });
    mockFetch();
    await updateUpstreamSyncState(sync.project_id, { discussionCursor: "2026-09-01T00:00:00Z" });
    discussionList = [discussion(5, { updated_at: "2026-10-02T00:00:00Z" })];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const asIssue = await getIssueByUpstreamNumber(sync.project_id, 5, "issue");
    const asDiscussion = await getIssueByUpstreamNumber(sync.project_id, 5, "discussion");
    expect(asIssue?.id).toBe(issue.id);
    expect(asDiscussion?.id).not.toBe(issue.id);
    expect(asDiscussion?.upstream_issue_number).toBe(5);
  });

  test("local number collision falls back to free slot keeping upstream number", async () => {
    const { sync } = await setup();
    await createIssue(sync.project_id, "occupies #30", "b", "alice", { number: 30 });
    mockFetch();
    discussionList = [discussion(30)];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const d = await getIssueByUpstreamNumber(sync.project_id, 30, "discussion");
    expect(d).toBeTruthy();
    expect(d?.number).not.toBe(30);
    expect(d?.upstream_issue_number).toBe(30);
  });

  test("disabled flag leaves discussions untouched", async () => {
    const { sync } = await setup();
    mockFetch();
    discussionList = [discussion(41)];
    await (await makeSyncer(sync.project_id, false)).pollOnce();
    await settle();
    expect(await getIssueByUpstreamNumber(sync.project_id, 41, "discussion")).toBeNull();
  });

  test("state change to closed emits closed event", async () => {
    const { sync } = await setup();
    mockFetch();
    discussionList = [discussion(51)];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const row = await getUpstreamSync(sync.project_id);
    await updateUpstreamSyncState(sync.project_id, { discussionCursor: row!.discussion_cursor });
    discussionList = [discussion(51, { state: "closed", updated_at: "2026-10-03T00:00:00Z" })];
    await (await makeSyncer(sync.project_id)).pollOnce();
    await settle();
    const closed = hookCalls.find((c) => c.body.action === "closed");
    expect(closed?.body.issue.kind).toBe("discussion");
    const local = await getIssueByUpstreamNumber(sync.project_id, 51, "discussion");
    expect(local?.state).toBe("closed");
  });
});
