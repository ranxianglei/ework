import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createProject,
  createIssue,
  getIssueByUpstreamNumber,
  getUpstreamSync,
  upsertUpstreamSync,
  updateUpstreamSyncState,
} from "../src/store";
import { createWebhook, waitForWebhookQueueIdle } from "../src/webhooks";
import { UpstreamSync } from "../src/upstream-sync";

const HOOK = "http://hook.local/cb";
const originalFetch = globalThis.fetch;

let issueList: any[] = [];

function gi(n: number, over: Partial<any> = {}): any {
  const ts = `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`;
  return {
    number: n,
    title: `entry ${n}`,
    body: "b",
    state: "open",
    user: { login: "carol" },
    created_at: ts,
    updated_at: ts,
    ...over,
  };
}

function mockFetch() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOOK)) return new Response("{}", { status: 200 });
    if (url.includes("/issues?")) return Response.json(issueList);
    if (/\/issues\/\d+\/comments/.test(url)) return Response.json([]);
    return new Response("{}", { status: 404 });
  }) as any;
}

async function settle() {
  await waitForWebhookQueueIdle();
}

async function setup(cursor: string | null = "2026-09-30T00:00:00Z") {
  const project = await createProject("acme", `widget-prlabel-${Date.now() % 1000000}`, "test");
  await upsertUpstreamSync(project.id, {
    baseUrl: "https://github.com",
    upstreamOwner: "acme",
    upstreamRepo: "widget",
    enabled: true,
    token: "t",
  } as any);
  if (cursor) {
    await updateUpstreamSyncState(project.id, { issueCursor: cursor, commentCursor: cursor });
  }
  await createWebhook({ project_id: project.id, url: HOOK, secret: "", events: ["issues"] });
  const row = (await getUpstreamSync(project.id))!;
  return { sync: new UpstreamSync(row, project, "http://web.local", false), projectId: project.id };
}

async function labelsOf(issueId: number): Promise<string[]> {
  const db = getDB();
  const rows = await db.all<{ name: string }>(
    "SELECT l.name FROM {{labels}} l JOIN {{issue_labels}} il ON il.label_id = l.id WHERE il.issue_id = ?",
    [issueId],
  );
  return rows.map((r) => r.name);
}

describe("pr mirror label + title recompose", () => {
  beforeAll(async () => {
    await initDB();
  });

  afterEach(async () => {
    await settle();
    globalThis.fetch = originalFetch;
    issueList = [];
    const db = getDB();
    const mysql = db.dialect === "mysql";
    await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
    for (const t of ["issue_labels", "labels", "comments", "issues", "webhooks", "webhook_deliveries", "upstream_sync", "projects", "users"]) {
      await db.exec(`DELETE FROM {{${t}}}`);
    }
    await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
  });

  test("importing a PR attaches the pr label and keeps the [PR] title prefix", async () => {
    const { sync, projectId } = await setup(null);
    mockFetch();
    issueList = [gi(41, { pull_request: {} })];
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 41);
    expect(row?.title).toBe("[PR] entry 41");
    expect(await labelsOf(row!.id)).toContain("pr");
  });

  test("a stripped mirror title is recomposed on the next live poll", async () => {
    const { sync, projectId } = await setup("2026-09-29T00:00:00Z");
    const created = await createIssue(projectId, "entry 42", "b", "carol", {
      number: 42,
      upstreamIssueNumber: 42,
      createdAt: "2026-09-29T00:00:00Z",
      updatedAt: "2026-09-29T00:00:00Z",
    });
    void created;
    mockFetch();
    issueList = [gi(42, { pull_request: {}, updated_at: "2026-10-02T00:00:00Z" })];
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 42);
    expect(row?.title).toBe("[PR] entry 42");
    expect(await labelsOf(row!.id)).toContain("pr");
  });

  test("plain issues never get the pr label or prefix", async () => {
    const { sync, projectId } = await setup(null);
    mockFetch();
    issueList = [gi(43)];
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 43);
    expect(row?.title).toBe("entry 43");
    expect(await labelsOf(row!.id)).toEqual([]);
  });
});
