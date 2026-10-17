import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { initDB } from "../src/db";
import { createProject, getIssueByUpstreamNumber, upsertUpstreamSync, updateUpstreamSyncState } from "../src/store";
import { UpstreamSync, setTitleTranslator } from "../src/upstream-sync";

const originalFetch = globalThis.fetch;
let issueList: any[] = [];
let translateCalls: string[] = [];

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
    if (url.includes("/issues?")) return Response.json(issueList);
    if (/\/issues\/\d+\/comments/.test(url)) return Response.json([]);
    return new Response("{}", { status: 404 });
  }) as any;
}

async function setup(cursor: string | null = "2026-09-30T00:00:00Z") {
  const project = await createProject("acme", `widget-tt-${Date.now() % 1000000}`, "test");
  await upsertUpstreamSync(project.id, {
    baseUrl: "https://github.com",
    upstreamOwner: "acme",
    upstreamRepo: "widget",
    enabled: true,
    token: "t",
  });
  await updateUpstreamSyncState(project.id, { issueCursor: cursor, commentCursor: cursor });
  const sync = new UpstreamSync(
    { ...(await (await import("../src/store")).getUpstreamSync(project.id))! },
    project,
    "http://origin.local",
    false,
    true,
  );
  return { sync, projectId: project.id };
}

describe("ingest title translation", () => {
  beforeAll(() => {
    initDB();
    translateCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("CJK title is imported with an English lead segment", async () => {
    setTitleTranslator(async (raw) => {
      translateCalls.push(raw);
      return `Fix session reset leak ${raw.length}`;
    });
    issueList = [gi(11, { title: "修复会话重置后指针残留" })];
    mockFetch();
    const { sync, projectId } = await setup();
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 11);
    expect(row?.title).toBe("Fix session reset leak 12 | 修复会话重置后指针残留");
  });

  test("non-CJK titles pass through untouched", async () => {
    issueList = [gi(12, { title: "plain english title" })];
    mockFetch();
    const { sync, projectId } = await setup();
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 12);
    expect(row?.title).toBe("plain english title");
    expect(translateCalls).not.toContain("plain english title");
  });

  test("translator failure falls back to the original title", async () => {
    setTitleTranslator(async () => null);
    issueList = [gi(13, { title: "压缩统计缺失" })];
    mockFetch();
    const { sync, projectId } = await setup();
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 13);
    expect(row?.title).toBe("压缩统计缺失");
  });

  test("translation is cached per raw title", async () => {
    let calls = 0;
    setTitleTranslator(async () => {
      calls += 1;
      return "Cached translation";
    });
    issueList = [gi(14, { title: "游标卡死修复" })];
    mockFetch();
    const { sync, projectId } = await setup();
    await sync.pollOnce();
    issueList = [gi(15, { title: "游标卡死修复" })];
    await sync.pollOnce();
    expect(calls).toBe(1);
    const a = await getIssueByUpstreamNumber(projectId, 14);
    const b = await getIssueByUpstreamNumber(projectId, 15);
    expect(a?.title).toBe("Cached translation | 游标卡死修复");
    expect(b?.title).toBe(a?.title);
  });

  test("already-translated titles are never rewritten by later polls", async () => {
    let calls = 0;
    setTitleTranslator(async () => {
      calls += 1;
      return `Translation v${calls}`;
    });
    const { sync, projectId } = await setup();
    // First import composes with v1.
    issueList = [gi(16, { title: "排队优先级缺陷" })];
    mockFetch();
    await sync.pollOnce();
    const row1 = await getIssueByUpstreamNumber(projectId, 16);
    expect(row1?.title).toBe("Translation v1 | 排队优先级缺陷");
    // A fresh poll cycle (new UpstreamSync instance, empty cache) with a
    // different translator output must NOT rewrite the stored title.
    issueList = [gi(16, { title: "排队优先级缺陷", updated_at: "2026-10-01T00:01:00Z" })];
    const { sync: sync2, projectId: p2 } = await setup();
    void sync2; void p2;
    const mod = await import("../src/upstream-sync");
    const sync3 = new mod.UpstreamSync(
      { ...(await (await import("../src/store")).getUpstreamSync(projectId))! },
      { id: projectId, owner: "acme", name: "widget", model: "m", public: 1 } as any,
      "http://origin.local",
      false,
      true,
    );
    await sync3.pollOnce();
    const row2 = await getIssueByUpstreamNumber(projectId, 16);
    expect(row2?.title).toBe("Translation v1 | 排队优先级缺陷");
  });
});

