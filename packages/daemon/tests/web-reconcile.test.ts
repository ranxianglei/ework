import { beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { Store } from "../src/op";
import { initDB, getDB } from "../src/db";
import { reconcileWebIssues } from "../src/sync/web-reconcile";

// Tests for the web→daemon open-issue reconciler (ranxianglei/ework#7 item 4):
// rows lost from the engine DB are re-created from the web's open-issue list,
// without ever spawning work. The web response shape mirrors the ework shim's
// search endpoint (url field carries /api/v1/repos/{owner}/{repo}/issues/{n}).

let store: Store;

const WEB = "http://web.test";

interface FakeItem {
  url?: string;
  html_url?: string;
  number?: number;
  title?: string;
}

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

function mockFetch(items: FakeItem[], status = 200): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push(String(input));
    void init;
    return new Response(JSON.stringify(items), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

// Serves a different item list per requested ?page=N (1-based); unknown pages
// come back empty so the walker sees a short page and stops.
function mockFetchPaged(pages: FakeItem[][]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push(String(input));
    void init;
    const m = String(input).match(/page=(\d+)/);
    const idx = m ? Number(m[1]) - 1 : 0;
    const items = pages[idx] ?? [];
    return new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  await db.exec("PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues", "daemons"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec("PRAGMA foreign_keys = ON");
  store = new Store();
});

describe("reconcileWebIssues", () => {
  it("restores missing open issue rows as active", async () => {
    const items: FakeItem[] = [
      { url: `${WEB}/api/v1/repos/dog/repo/issues/42`, number: 42, title: "lost thread" },
    ];
    const { fetchImpl } = mockFetch(items);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl });

    expect(result).toEqual({ checked: 1, matched: 1, restored: 1 });
    const row = await store.findIssue("gitea", "dog/repo", "42");
    expect(row).toBeDefined();
    expect(row!.title).toBe("lost thread");
    expect(row!.state).toBe("active");
    expect(row!.trackerScopeKey).toBe("dog/repo");
  });

  it("is idempotent — existing rows are not touched", async () => {
    const ref = { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "42" };
    const existing = await store.findOrCreateIssue(ref, "dog/repo", "original title");
    await store.updateIssueState(existing.id, "closed");

    const items: FakeItem[] = [
      { url: `${WEB}/api/v1/repos/dog/repo/issues/42`, number: 42, title: "renamed on web" },
    ];
    const { fetchImpl } = mockFetch(items);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl });

    expect(result.restored).toBe(0);
    const row = await store.findIssue("gitea", "dog/repo", "42");
    expect(row!.id).toBe(existing.id);
    expect(row!.title).toBe("original title");
    expect(row!.state).toBe("closed");
  });

  it("ignores issues outside the requested scopes and unparseable urls", async () => {
    const items: FakeItem[] = [
      { url: `${WEB}/api/v1/repos/other/project/issues/7`, number: 7, title: "not mine" },
      { url: "no-scope-here", number: 8, title: "broken" },
      { url: `${WEB}/api/v1/repos/dog/repo/issues/9`, number: 9, title: "mine" },
    ];
    const { fetchImpl } = mockFetch(items);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl });

    expect(result.checked).toBe(3);
    expect(result.matched).toBe(1);
    expect(result.restored).toBe(1);
    expect(await store.findIssue("gitea", "other/project", "7")).toBeUndefined();
    expect(await store.findIssue("gitea", "dog/repo", "9")).toBeDefined();
  });

  it("accepts html_url fallback when url is absent", async () => {
    const items: FakeItem[] = [
      { html_url: `${WEB}/dog/repo/issues/55`, number: 55, title: "html only" },
    ];
    const { fetchImpl } = mockFetch(items);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl });

    expect(result.restored).toBe(1);
    expect((await store.findIssue("gitea", "dog/repo", "55"))?.title).toBe("html only");
  });

  it("skips fetching entirely when no scopes are requested", async () => {
    const { fetchImpl, calls } = mockFetch([]);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: [], store, fetchImpl });

    expect(result).toEqual({ checked: 0, matched: 0, restored: 0 });
    expect(calls).toHaveLength(0);
  });

  it("throws on non-OK responses so the caller can log and retry next cycle", async () => {
    const { fetchImpl } = mockFetch([], 503);
    await expect(
      reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl }),
    ).rejects.toThrow(/503/);
  });

  it("sends the admin read token and queries only open issues", async () => {
    const seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = async (input, init) => {
      void input;
      const h = new Headers(init?.headers);
      seenHeaders["authorization"] = h.get("authorization") ?? "";
      return new Response("[]", { status: 200 });
    };
    let calledWith = "";
    const wrapped: FetchLike = async (input, init) => {
      calledWith = String(input);
      return fetchImpl(input, init);
    };

    await reconcileWebIssues({ webUrl: WEB, token: "admin-tok", scopes: ["dog/repo"], store, fetchImpl: wrapped });
    expect(calledWith).toContain("/api/v1/repos/issues/search?q=&state=open&type=issues&limit=200&page=1");
    expect(seenHeaders["authorization"]).toBe("token admin-tok");
  });

  it("walks multiple pages until a short page and restores across pages", async () => {
    // limit=50 keeps this under the 5s test timeout on slow CI boxes while
    // still exercising full-page → next-page → short-page termination.
    const page1: FakeItem[] = Array.from({ length: 50 }, (_, i) => ({
      url: `${WEB}/api/v1/repos/dog/repo/issues/${i + 1}`,
      number: i + 1,
      title: `issue ${i + 1}`,
    }));
    const page2: FakeItem[] = Array.from({ length: 3 }, (_, i) => ({
      url: `${WEB}/api/v1/repos/dog/repo/issues/${i + 51}`,
      number: i + 51,
      title: `issue ${i + 51}`,
    }));
    const { fetchImpl, calls } = mockFetchPaged([page1, page2]);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl, limit: 50 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("&limit=50&page=1");
    expect(calls[1]).toContain("&limit=50&page=2");
    expect(result).toEqual({ checked: 53, matched: 53, restored: 53 });
    expect(await store.findIssue("gitea", "dog/repo", "1")).toBeDefined();
    expect(await store.findIssue("gitea", "dog/repo", "53")).toBeDefined();
  });

  it("stops when an old shim repeats the same page instead of looping forever", async () => {
    const page: FakeItem[] = [
      { url: `${WEB}/api/v1/repos/dog/repo/issues/1`, number: 1, title: "a" },
      { url: `${WEB}/api/v1/repos/dog/repo/issues/2`, number: 2, title: "b" },
    ];
    const { fetchImpl, calls } = mockFetchPaged([page, page, page]);
    // limit=2 makes page 1 a full page, so the walker would otherwise keep going.
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl, limit: 2 });

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ checked: 2, matched: 2, restored: 2 });
  });

  it("caps the walk at maxPages even when every page is full", async () => {
    const makePage = (start: number): FakeItem[] => [
      { url: `${WEB}/api/v1/repos/dog/repo/issues/${start}`, number: start, title: `x${start}` },
      { url: `${WEB}/api/v1/repos/dog/repo/issues/${start + 1}`, number: start + 1, title: `y${start}` },
    ];
    const { fetchImpl, calls } = mockFetchPaged([makePage(1), makePage(100), makePage(200)]);
    const result = await reconcileWebIssues({ webUrl: WEB, token: "tok", scopes: ["dog/repo"], store, fetchImpl, limit: 2, maxPages: 2 });

    expect(calls).toHaveLength(2);
    expect(result.checked).toBe(4);
    expect(result.restored).toBe(4);
  });
});
