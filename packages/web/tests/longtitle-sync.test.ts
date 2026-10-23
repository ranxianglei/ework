import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { initDB } from "../src/db";
import { createProject, getIssueByUpstreamNumber, upsertUpstreamSync, updateUpstreamSyncState, type UpstreamSyncRow } from "../src/store";
import { UpstreamSync } from "../src/upstream-sync";

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await initDB();
});

beforeEach(() => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
});

function ghIssue(n: number, title: string, updated: string): any {
  return { number: n, title, body: `body ${n}`, state: "open", user: { login: "alice" }, created_at: updated, updated_at: updated, comments: 0 };
}

describe("overlong title clipping + per-item isolation", () => {
  test("a >255-char upstream title imports clipped, not wedged", async () => {
    const project = await createProject("acme", `gadgets-lt-${Date.now()}`, "d");
    await upsertUpstreamSync(project.id, { baseUrl: "https://github.com", upstreamOwner: "acme", upstreamRepo: "gadgets", enabled: true, token: "t" });
    await updateUpstreamSyncState(project.id, { issueCursor: "2026-10-01T00:00:00Z", commentCursor: "2026-10-01T00:00:00Z" });
    const sync = (await (await import("../src/store")).getUpstreamSync(project.id)) as UpstreamSyncRow;
    const longTitle = "T".repeat(355);
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("/issues?") && !url.includes("/comments")) {
        return { ok: true, status: 200, json: async () => ([ghIssue(101, longTitle, "2026-10-02T00:00:00Z"), ghIssue(102, "fine title", "2026-10-02T00:00:01Z")]) } as unknown as Response;
      }
      if (url.includes("/comments")) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      return { ok: true, status: 200, json: async () => ([]) } as unknown as Response;
    }) as unknown as typeof fetch;
    const us = new UpstreamSync(sync, project, "https://github.com");
    await us.pollOnce();
    const clipped = await getIssueByUpstreamNumber(project.id, 101);
    const next = await getIssueByUpstreamNumber(project.id, 102);
    expect(clipped).not.toBeNull();
    expect(clipped!.title.length).toBeLessThanOrEqual(255);
    expect(next).not.toBeNull();
    expect(next!.title).toBe("fine title");
  });
});
