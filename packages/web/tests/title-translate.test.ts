import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { initDB } from "../src/db";
import { createProject, getIssueByUpstreamNumber, upsertUpstreamSync, updateUpstreamSyncState } from "../src/store";
import { UpstreamSync, setTitleTranslator } from "../src/upstream-sync";

const originalFetch = globalThis.fetch;
let issueList: any[] = [];
let translateCalls: string[] = [];
let labelPosts: { n: number }[] = [];
let labelCreates: number[] = [];

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
    if (/POST/.test(String(input.method ?? "GET"))) {
      const m = url.match(/\/issues\/(\d+)\/labels$/);
      if (m) { labelPosts.push({ n: Number(m[1]) }); return Response.json([]); }
      if (url.endsWith("/labels")) { labelCreates.push(1); return Response.json({}); }
    }
    if (/\/issues\/\d+\/labels$/.test(url)) return Response.json([]);
    if (url.endsWith("/labels")) return Response.json([]);
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

  test("composeTitle is idempotent under its own write-back (no [PR] storm, no double lead)", async () => {
    let calls = 0;
    setTitleTranslator(async (t) => {
      calls += 1;
      return `Translation of ${t}`;
    });
    const { sync } = await setup();
    // Round 1: plain EN PR title.
    issueList = [gi(21, { title: "Enrich auto-filed diagnostics reports", pull_request: {} })];
    mockFetch();
    await sync.pollOnce();
    // Simulate write-back: upstream now returns our own composed title.
    issueList = [gi(21, { title: "[PR] Enrich auto-filed diagnostics reports", pull_request: {}, updated_at: "2026-10-01T00:02:00Z" })];
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber((await setup()).projectId, 21);
    expect(row?.title).toBe("[PR] Enrich auto-filed diagnostics reports");
    // CJK variant: bilingual title comes back — lead reused, not re-translated.
    issueList = [gi(22, { title: "排队缺陷", pull_request: {} })];
    await sync.pollOnce();
    issueList = [gi(22, { title: "[PR] Translation of 排队缺陷 | 排队缺陷", pull_request: {}, updated_at: "2026-10-01T00:03:00Z" })];
    await sync.pollOnce();
    expect(calls).toBeLessThan(4);
  });

  test("label write-back fires even when the title is healthy (#3723 regression)", async () => {
    labelPosts = []; labelCreates = [];
    setTitleTranslator(async (t) => `EN ${t}`);
    const { sync, projectId } = await setup();
    // Seed the mirror with an already-composed title + two labels.
    issueList = [gi(81, { title: "EN 排队缺陷 | 排队缺陷" })];
    mockFetch();
    await sync.pollOnce();
    const row = (await getIssueByUpstreamNumber(projectId, 81))!;
    const { ensureIssueHasLabel } = await import("../src/store");
    await ensureIssueHasLabel(projectId, row.id, "bug", "#d73a4a");
    await ensureIssueHasLabel(projectId, row.id, "p2", "#d93f0b");
    // Upstream already shows the composed title AND an existing GH label.
    issueList = [gi(81, { title: "EN 排队缺陷 | 排队缺陷", labels: [{ name: "bug" }] })];
    labelPosts = []; labelCreates = [];
    await sync.pollOnce();
    // bug already upstream -> only p2 must be posted; no repo-label creation needed.
    expect(labelPosts.length).toBe(1);
  });

  test("translator echo does not duplicate the title", async () => {
    let calls = 0;
    setTitleTranslator(async (t) => {
      calls += 1;
      return t; // echo: returns the CJK input unchanged
    });
    const { sync, projectId } = await setup();
    issueList = [gi(21, { title: "用两条出站不变量定死缓存稳定" })];
    mockFetch();
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 21);
    expect(row?.title).toBe("用两条出站不变量定死缓存稳定");
    expect(calls).toBe(1);
  });

  test("agent-mangled CJK | EN tail is normalized to EN | CJK without translating", async () => {
    let calls = 0;
    setTitleTranslator(async () => {
      calls += 1;
      return "should-not-be-called";
    });
    const { sync, projectId } = await setup();
    issueList = [gi(22, { title: "中文原题 | some english tail the agent appended" })];
    mockFetch();
    await sync.pollOnce();
    const row = await getIssueByUpstreamNumber(projectId, 22);
    expect(row?.title).toBe("some english tail the agent appended | 中文原题");
    expect(calls).toBe(0);
  });
});


