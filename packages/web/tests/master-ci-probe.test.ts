import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { initDB, setConfig, getDB } from "../src/db";
import { createProject, createIssue, upsertUpstreamSync, updateUpstreamSyncState } from "../src/store";
import { UpstreamSync } from "../src/upstream-sync";

const originalFetch = globalThis.fetch;
let masterSha = "deadbeef11";
let posted: { url: string; body: any }[] = [];

let ciFixesSha: string | null = null;
function mockFetch(opts: { failing: boolean; completed: boolean }) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String((input instanceof Request ? input.method : init?.method) ?? "GET");
    if (url.includes("/commits/ci-fixes")) {
      if (ciFixesSha === null) return new Response("{}", { status: 404 });
      return Response.json([{ sha: ciFixesSha }]);
    }
    if (url.includes("/check-runs")) {
      const checks = opts.completed
        ? [{ name: "CI", status: "completed", conclusion: opts.failing ? "failure" : "success" }]
        : [{ name: "CI", status: "in_progress", conclusion: null }];
      return Response.json({ total_count: checks.length, check_runs: checks });
    }
    if (url.includes("/commits/master")) {
      return Response.json([{ sha: masterSha }]);
    }
    if (url.includes("/issues?")) return Response.json([]);
    if (/\/issues\/\d+\/comments/.test(url)) return Response.json([]);
    if (/POST/.test(method)) {
      posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({});
    }
    return new Response("{}", { status: 404 });
  }) as any;
}

async function setup() {
  const project = await createProject("ranxianglei", `bc-probe-${Date.now() % 1000000}`, "test");
  await upsertUpstreamSync(project.id, {
    baseUrl: "https://github.com",
    upstreamOwner: "ranxianglei",
    upstreamRepo: "billion-context",
    enabled: true,
    token: "t",
  });
  await updateUpstreamSyncState(project.id, { issueCursor: "2026-10-01T00:00:00Z", commentCursor: "2026-10-01T00:00:00Z" });
  const issue = await createIssue(project.id, "CI 总控", "body", "dog", { number: 4599, state: "open" });
  // createIssue's opts.number is the LOCAL number; the probe matches the
  // upstream mirror column, so set it explicitly.
  await getDB().run("UPDATE issues SET upstream_issue_number = 4599, kind = 'issue' WHERE id = ?", [issue.id]);
  await setConfig(`ciSentinelIssue:ranxianglei/${project.name}`, "4599");
  const sync = new UpstreamSync(
    { ...(await (await import("../src/store")).getUpstreamSync(project.id))! },
    project,
    "http://origin.local",
    false,
    true,
    undefined,
  );
  return { sync, issue, project };
}

describe("master CI sentinel probe", () => {
  beforeAll(async () => { await initDB(); });
  afterEach(() => { globalThis.fetch = originalFetch; posted = []; ciFixesSha = null; });

  test("emits master_ci_failed once per failing sha, suppresses repeat, clears on green", async () => {
    const { sync } = await setup() as any;
    const us = sync as any;
    mockFetch({ failing: true, completed: true });
    const r1: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r1);
    expect(r1.issuesUpdated).toBe(1);
    expect(us.masterCiLastEmit?.sha).toBe(masterSha);
    const r2: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r2);
    expect(r2.issuesUpdated).toBe(0);
    masterSha = "newsha99887";
    const r3: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r3);
    expect(r3.issuesUpdated).toBe(1);
    mockFetch({ failing: false, completed: true });
    const r4: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r4);
    expect(us.masterCiLastEmit).toBe(null);
  });

  test("ci-fixes branch red dispatches sentinel with branch field, throttled independently of master", async () => {
    const { sync, project } = await setup() as any;
    const us = sync as any;
    const { createWebhook } = await import("../src/webhooks");
    await createWebhook({ project_id: project.id, url: "http://127.0.0.1:9/hook", secret: "s3" });
    ciFixesSha = "cifixes01";
    mockFetch({ failing: true, completed: true });
    // First poll: BOTH master and ci-fixes red -> two emissions.
    const r1: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r1);
    expect(r1.issuesUpdated).toBe(2);
    const masterPost = posted.find((p) => p.body?.action === "master_ci_failed" && p.body?.ci?.branch === "master");
    const fixPost = posted.find((p) => p.body?.action === "master_ci_failed" && p.body?.ci?.branch === "ci-fixes");
    expect(masterPost).toBeTruthy();
    expect(fixPost).toBeTruthy();
    // Repeat poll: both throttled.
    const r2: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r2);
    expect(r2.issuesUpdated).toBe(0);
    // New ci-fixes sha re-arms only the ci-fixes throttle.
    ciFixesSha = "cifixes99";
    const r3: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r3);
    expect(r3.issuesUpdated).toBe(1);
    // Green poll clears both branches' throttle keys (re-arm semantics).
    mockFetch({ failing: false, completed: true });
    const r4: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r4);
    expect(r4.issuesUpdated).toBe(0);
    ciFixesSha = "cifixes77";
    mockFetch({ failing: true, completed: true });
    const r5: any = { issuesUpdated: 0 };
    await us.probeMasterCi(r5);
    expect(r5.issuesUpdated).toBe(2);
    ciFixesSha = null;
  });

  test("missing ci-fixes branch skips silently", async () => {
    const { sync } = await setup() as any;
    ciFixesSha = null;
    mockFetch({ failing: true, completed: true });
    const r: any = { issuesUpdated: 0 };
    await (sync as any).probeMasterCi(r);
    expect(r.issuesUpdated).toBe(1); // master only
    ciFixesSha = null;
  });

  test("in-progress checks do not emit", async () => {
    const { sync } = await setup() as any;
    mockFetch({ failing: true, completed: false });
    const r: any = { issuesUpdated: 0 };
    await (sync as any).probeMasterCi(r);
    expect(r.issuesUpdated).toBe(0);
  });
});
