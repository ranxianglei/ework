import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  createIssue,
  createProject,
  ensureUser,
  getIssueByUpstreamNumber,
  listIssues,
  upsertUpstreamSync,
  type UpstreamSyncRow,
} from "../src/store";
import { UpstreamSync } from "../src/upstream-sync";

const GH = "https://github.com";
const originalFetch = globalThis.fetch;

let issuePages: any[][] = [];
let repoComments: any[] = [];
let issueComments: Record<number, any[]> = [];
let calledUrls: string[] = [];

beforeAll(async () => {
  await initDB();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  issuePages = [];
  repoComments = [];
  issueComments = [];
  calledUrls = [];
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["comments", "issues", "webhook_deliveries", "upstream_sync", "projects", "users"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
});

function ghIssue(n: number, over: Partial<any> = {}): any {
  const ts = `2026-08-01T00:00:${String(10 + n).padStart(2, "0")}Z`;
  return {
    number: n,
    title: `upstream #${n}`,
    body: `body of ${n}`,
    state: "open",
    user: { login: "alice" },
    created_at: ts,
    updated_at: ts,
    ...over,
  };
}

function ghComment(id: number, issueNumber: number, over: Partial<any> = {}): any {
  const sec = String(10 + (id % 50)).padStart(2, "0");
  return {
    id,
    body: `comment ${id}`,
    user: { login: "bob" },
    created_at: `2026-08-01T01:00:${sec}Z`,
    updated_at: `2026-08-01T01:00:${sec}Z`,
    issue_url: `https://api.github.com/repos/acme/widget/issues/${issueNumber}`,
    ...over,
  };
}

function mockFetch() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calledUrls.push(url);
    if (url.startsWith("https://api.github.com/repos/acme/widget/issues/comments")) {
      return Response.json(repoComments);
    }
    const perIssue = url.match(/\/issues\/(\d+)\/comments/);
    if (perIssue) {
      return Response.json(issueComments[Number(perIssue[1])] ?? []);
    }
    if (url.startsWith("https://api.github.com/repos/acme/widget/issues")) {
      return Response.json(issuePages.shift() ?? []);
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

async function setup(): Promise<{ sync: UpstreamSyncRow; project: any }> {
  await ensureUser("root");
  const project = await createProject("acme", "widget", "root");
  const sync = await upsertUpstreamSync(project.id, {
    baseUrl: GH,
    upstreamOwner: "acme",
    upstreamRepo: "widget",
    enabled: true,
  });
  return { sync, project };
}

function engine(sync: UpstreamSyncRow, project: any): UpstreamSync {
  return new UpstreamSync(sync, project, "http://ework.local");
}

describe("upstream-sync github adapter", () => {
  test("targets api.github.com without /api/v1 and github pagination", async () => {
    const { sync, project } = await setup();
    issuePages = [[ghIssue(1)]];
    mockFetch();
    await engine(sync, project).pollOnce();
    expect(calledUrls[0]).toBe(
      "https://api.github.com/repos/acme/widget/issues?state=open&per_page=50&page=1&sort=created&direction=asc"
    );
    expect(calledUrls.some((u) => u.includes("?per_page=50"))).toBe(true);
    expect(calledUrls.every((u) => !u.includes("/api/v1"))).toBe(true);
  });

  test("imports PRs with [PR] prefix, plain issues untouched", async () => {
    const { sync, project } = await setup();
    issuePages = [[ghIssue(1), ghIssue(2, { title: "fix thing", pull_request: { url: "x" } })]];
    mockFetch();
    await engine(sync, project).pollOnce();
    const rows = await listIssues(sync.project_id);
    expect(rows.some((r) => r.title === "upstream #1")).toBe(true);
    expect(rows.some((r) => r.title === "[PR] fix thing")).toBe(true);
  });

  test("skips write-back marker comments on import (backfill path)", async () => {
    const { sync, project } = await setup();
    issuePages = [[ghIssue(1)]];
    issueComments[1] = [
      ghComment(11, 1),
      ghComment(12, 1, { body: "[bot] mirrored reply\n\n<!-- ework-mirror -->" }),
    ];
    mockFetch();
    await engine(sync, project).pollOnce();
    const db = getDB();
    const rows = await db.all(`SELECT author, body FROM {{comments}}`);
    expect(rows.length).toBe(1);
    expect((rows[0] as any).body).toBe("comment 11\n\n<!-- upstream-sync -->");
  });

  test("live poll uses github comment cursor params and skips markers", async () => {
    const { sync, project } = await setup();
    issuePages = [[]];
    await (await import("../src/store")).updateUpstreamSyncState(sync.project_id, {
      issueCursor: "2026-08-01T00:00:00Z",
      commentCursor: "2026-08-01T00:00:00Z",
    });
    const fresh = await (await import("../src/store")).getUpstreamSync(sync.project_id);
    repoComments = [
      ghComment(21, 1, {
        created_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      ghComment(22, 1, {
        body: "echo\n\n<!-- ework-mirror -->",
        created_at: new Date(Date.now() + 90_000).toISOString(),
        updated_at: new Date(Date.now() + 90_000).toISOString(),
      }),
    ];
    issuePages = [[ghIssue(1)]];
    mockFetch();
    await engine(fresh!, project).pollOnce();
    const db = getDB();
    const rows = await db.all(`SELECT upstream_comment_id FROM {{comments}}`);
    expect(rows.length).toBe(1);
    expect((rows[0] as any).upstream_comment_id).toBe(21);
    expect(calledUrls.some((u) => u.includes("per_page=100&since="))).toBe(true);
  });

  test("non-github base keeps gitea paths", async () => {
    await ensureUser("root");
    const project = await createProject("acme", "gizmo", "root");
    const sync = await upsertUpstreamSync(project.id, {
      baseUrl: "http://gitea.local",
      upstreamOwner: "acme",
      upstreamRepo: "gizmo",
      enabled: true,
    });
    issuePages = [[]];
    mockFetch();
    await engine(sync, project).pollOnce();
    expect(calledUrls[0]!.startsWith("http://gitea.local/api/v1/repos/acme/gizmo/issues?")).toBe(true);
    expect(calledUrls[0]!).toContain("type=issues&limit=50");
    expect(await getIssueByUpstreamNumber(project.id, 1)).toBeNull();
  });
});

describe('upstream-sync github bot-kind mapping', () => {
  test('imports [bot]-authored comments as bot users', async () => {
    const { sync, project } = await setup();
    issuePages = [[ghIssue(1)]];
    issueComments[1] = [ghComment(31, 1, { user: { login: 'github-actions[bot]' } })];
    mockFetch();
    await engine(sync, project).pollOnce();
    const db = getDB();
    const u = await db.get('SELECT login, kind FROM {{users}} WHERE login = ?', ['github-actions[bot]']);
    expect((u as any)?.kind).toBe('bot');
  });
});

describe('upstream-sync agent-PR feedback loop guard', () => {
  test('PR carrying the agent marker imports silently (no opened event)', async () => {
    const { sync, project } = await setup();
    const { createWebhook } = await import('../src/webhooks');
    await createWebhook({ project_id: project.id, url: 'http://hook.local/x', events: ['issues'] });
    issuePages = [[ghIssue(9, { title: 'agent work', pull_request: { url: 'x' }, body: 'done\n<!-- ework-agent-pr -->' })]];
    mockFetch();
    await engine({ ...sync, issue_cursor: '2020-01-01T00:00:00Z' }, project).pollOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(await getIssueByUpstreamNumber(project.id, 9)).not.toBeNull();
    expect(calledUrls.filter((u) => u.startsWith('http://hook.local')).length).toBe(0);
  });

  test('human PR without marker still emits opened', async () => {
    const { sync, project } = await setup();
    const { createWebhook } = await import('../src/webhooks');
    await createWebhook({ project_id: project.id, url: 'http://hook.local/x', events: ['issues'] });
    issuePages = [[ghIssue(8, { title: 'human PR', pull_request: { url: 'x' }, body: 'normal' })]];
    mockFetch();
    await engine({ ...sync, issue_cursor: '2020-01-01T00:00:00Z' }, project).pollOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(calledUrls.filter((u) => u.startsWith('http://hook.local')).length).toBe(1);
  });
});

describe("mirrored-issue echo guard (issue level)", () => {
  test("mirror-created issue links to its origin instead of twin-importing", async () => {
    const { sync, project } = await setup();
    await ensureUser("dog");
    const local = await createIssue(
      project.id,
      "local born",
      "body",
      "dog",
      { state: "open" }
    );
    issuePages = [[ghIssue(238, {
      title: "local born",
      user: { login: "ranxianglei" },
      body: "body\n\n---\n_Mirrored from ework issue #" + local.number + "_\n\n<!-- ework-mirror -->",
    })]];
    mockFetch();
    await engine(sync, project).pollOnce();
    const rows = await listIssues(project.id);
    expect(rows).toHaveLength(1);
    const relinked = await getIssueByUpstreamNumber(project.id, 238);
    expect(relinked?.id).toBe(local.id);
  });

  test("mirrored issue with unresolvable origin never twins", async () => {
    const { sync, project } = await setup();
    issuePages = [[ghIssue(77, {
      body: "orphan\n\n---\n_Mirrored from ework issue #999_\n\n<!-- ework-mirror -->",
    })]];
    mockFetch();
    await engine(sync, project).pollOnce();
    const rows = await listIssues(project.id);
    expect(rows).toHaveLength(0);
  });
});
