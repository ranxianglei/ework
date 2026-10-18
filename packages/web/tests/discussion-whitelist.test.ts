import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createProject,
  getIssueByUpstreamNumber,
  upsertUpstreamSync,
  updateUpstreamSyncState,
} from "../src/store";
import { waitForWebhookQueueIdle } from "../src/webhooks";
import { UpstreamSync } from "../src/upstream-sync";

const HOOK = "http://hook.local/cb";
const originalFetch = globalThis.fetch;

function gd(n: number, over: Partial<any> = {}): any {
  const ts = `2026-10-18T00:00:${String(n).padStart(2, "0")}Z`;
  return { number: n, title: `disc ${n}`, body: "b", state: "open", user: { login: "u" }, created_at: ts, updated_at: ts, ...over };
}

function gi(n: number, over: Partial<any> = {}): any {
  const ts = `2026-10-18T00:00:${String(n).padStart(2, "0")}Z`;
  return { number: n, title: `issue ${n}`, body: "b", state: "open", user: { login: "u" }, created_at: ts, updated_at: ts, ...over };
}

function mockFetch(discussions: any[], issues: any[]) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOOK)) return new Response("{}", { status: 200 });
    if (url.includes("/discussions?")) return Response.json(discussions);
    if (url.includes("/issues?")) return Response.json(issues);
    if (/\/discussions\/\d+\/comments/.test(url)) return Response.json([]);
    if (/\/issues\/\d+\/comments/.test(url)) return Response.json([]);
    return new Response("{}", { status: 404 });
  }) as any;
}

async function setup(whitelist?: string, issuesEnabled = true) {
  const project = await createProject("acme", `wlt-${Date.now() % 1000000}`, "test");
  await upsertUpstreamSync(project.id, {
    baseUrl: "https://github.com", upstreamOwner: "acme", upstreamRepo: "wlt",
    enabled: true, token: "t",
  });
  await updateUpstreamSyncState(project.id, { issueCursor: "2026-10-17T00:00:00Z", commentCursor: "2026-10-17T00:00:00Z", discussionCursor: "2026-10-17T00:00:00Z" });
  const row = (await (await import("../src/store")).getUpstreamSync(project.id))!;
  const sync = new UpstreamSync(row, project, "http://origin.local", true, issuesEnabled, whitelist, false);
  return { sync, projectId: project.id };
}

describe("discussion whitelist (single-thread listening)", () => {
  beforeAll(async () => { await initDB(); await getDB().exec("DELETE FROM webhook_deliveries"); });

  afterEach(async () => {
    await waitForWebhookQueueIdle();
    globalThis.fetch = originalFetch;
  });

  test("only whitelisted discussions sync; others in the repo stay untouched", async () => {
    const { sync, projectId } = await setup("5795");
    mockFetch([gd(5795), gd(5800, { updated_at: "2026-10-18T00:00:30Z" })], [gi(700)]);
    await sync.pollOnce();
    expect(await getIssueByUpstreamNumber(projectId, 5795, "discussion")).not.toBeNull();
    expect(await getIssueByUpstreamNumber(projectId, 5800, "discussion")).toBeNull();
  });

  test("issuesSync=0 keeps GitHub issues out even though the poller runs", async () => {
    const { sync, projectId } = await setup("5795", false);
    mockFetch([gd(5795)], [gi(700), gi(701)]);
    await sync.pollOnce();
    expect(await getIssueByUpstreamNumber(projectId, 700)).toBeNull();
    expect(await getIssueByUpstreamNumber(projectId, 701)).toBeNull();
  });

  test("no whitelist = all discussions sync (unchanged default)", async () => {
    const { sync, projectId } = await setup();
    mockFetch([gd(10), gd(11)], []);
    await sync.pollOnce();
    expect(await getIssueByUpstreamNumber(projectId, 10, "discussion")).not.toBeNull();
    expect(await getIssueByUpstreamNumber(projectId, 11, "discussion")).not.toBeNull();
  });
});
