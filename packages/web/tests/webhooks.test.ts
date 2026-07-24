import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { getDB, initDB } from "../src/db";
import {
  _internal,
  buildIssuePayload,
  createWebhook,
  deleteWebhook,
  emitIssueEvent,
  listWebhooks,
  setWebhookActive,
} from "../src/webhooks";
import { createIssue, createProject, ensureUser, postComment } from "../src/store";

const ORIGIN = "http://test.local";
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await initDB();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((r) => setTimeout(r, 60));
  const db = getDB();
  await db.exec("PRAGMA foreign_keys = OFF");
  for (const t of [
    "reactions",
    "comments",
    "issue_labels",
    "labels",
    "issues",
    "project_members",
    "webhooks",
    "webhook_deliveries",
    "personal_access_tokens",
    "attachments",
    "projects",
    "users",
  ]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec("DELETE FROM sqlite_sequence WHERE name IN ('issues','comments','projects','webhooks')");
});

describe("signBody: HMAC-SHA256 hex", () => {
  test("matches known vector", () => {
    const sig = _internal.signBody("secret", "hello");
    expect(sig).toBe("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
  });

  test("empty secret yields valid HMAC (Gitea-compat)", () => {
    const sig = _internal.signBody("", "{}");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different bodies produce different signatures", () => {
    const a = _internal.signBody("k", "body-a");
    const b = _internal.signBody("k", "body-b");
    expect(a).not.toBe(b);
  });
});

describe("parseEvents", () => {
  test("parses JSON array", () => {
    expect(_internal.parseEvents('["issues"]')).toEqual(["issues"]);
    expect(_internal.parseEvents('["issues","issue_comment"]')).toEqual(["issues", "issue_comment"]);
  });

  test("handles invalid JSON by returning default events", () => {
    expect(_internal.parseEvents(undefined)).toEqual(["issues", "issue_comment"]);
    expect(_internal.parseEvents("not-json")).toEqual(["issues", "issue_comment"]);
    expect(_internal.parseEvents('["unknown_event"]')).toEqual(["issues", "issue_comment"]);
  });
});

describe("buildHeaders: Gitea + GitHub + Gogs compatibility", () => {
  test("contains all three event headers + signature headers", () => {
    const h = _internal.buildHeaders("issues", "uuid-123", '{"a":1}', "secret");
    expect(h["X-Gitea-Event"]).toBe("issues");
    expect(h["X-Gogs-Event"]).toBe("issues");
    expect(h["X-GitHub-Event"]).toBe("issues");
    expect(h["X-Gitea-Delivery"]).toBe("uuid-123");
    expect(h["X-Gogs-Delivery"]).toBe("uuid-123");
    expect(h["X-GitHub-Delivery"]).toBe("uuid-123");
    expect(h["X-Gitea-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["X-GitHub-Signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(h["X-Gogs-Signature"]).toBe(h["X-Gitea-Signature"]);
  });

  test("signature header matches signBody output", () => {
    const body = '{"hello":"world"}';
    const h = _internal.buildHeaders("issue_comment", "u", body, "topsecret");
    expect(h["X-Gitea-Signature"]).toBe(_internal.signBody("topsecret", body));
  });
});

describe("buildIssuePayload (exported as buildIssue alias): Gitea-shaped issue object", () => {
  test("contains required fields with correct types", async () => {
    await ensureUser("alice");
    const project = await createProject("dog", "repo", "desc");
    const issue = await createIssue(project.id, "title", "body", "alice", {
      createdAt: "2020-01-01T00:00:00Z",
    });
    await postComment(issue.id, "first", "alice");

    const built = buildIssuePayload(issue, project, 1, ORIGIN);
    expect(built.number).toBe(1);
    expect(built.title).toBe("title");
    expect(built.body).toBe("body");
    expect(built.state).toBe("open");
    expect(built.created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(built.closed_at).toBeNull();
    expect(built.user).toBeDefined();
    expect(built.repository).toBeDefined();
    expect(typeof built.id).toBe("number");
    expect(built.html_url).toContain("/issues/1");
  });

  test("closed issue carries closed_at timestamp", async () => {
    await ensureUser("alice");
    const project = await createProject("dog", "repo", "desc");
    const issue = await createIssue(project.id, "t", "b", "alice", {
      createdAt: "2020-01-01T00:00:00Z",
      state: "closed",
      closedAt: "2020-02-01T00:00:00Z",
    });
    const built = buildIssuePayload(issue, project, 0, ORIGIN);
    expect(built.closed_at).toBe("2020-02-01T00:00:00.000Z");
  });
});

describe("webhook CRUD", () => {
  test("create + list + delete", async () => {
    await ensureUser("alice");
    const project = await createProject("dog", "repo", "");
    const created = await createWebhook({
      project_id: project.id,
      url: "http://example.com/hook",
      secret: "k",
      events: ["issues"],
    });
    expect((await listWebhooks(project.id)).length).toBe(1);

    await setWebhookActive(created.id, false);
    const active = (await listWebhooks(project.id)).filter((w) => w.active);
    expect(active.length).toBe(0);

    await deleteWebhook(created.id);
    expect((await listWebhooks(project.id)).length).toBe(0);
  });
});

describe("concurrency cap (WORK_WEBHOOK_MAX_CONCURRENT=3)", () => {
  test("never exceeds the configured in-flight ceiling", async () => {
    await ensureUser("alice");
    const project = await createProject("dog", "flood", "");
    const N = 12;
    for (let i = 0; i < N; i++) {
      await createWebhook({
        project_id: project.id,
        url: `http://flood.local/${i}`,
        secret: "",
        events: ["issues"],
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    globalThis.fetch = ((_input: any, _init?: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          completed++;
          resolve(new Response("ok", { status: 200 }));
        }, 50);
      });
    }) as typeof fetch;

    const issue = await createIssue(project.id, "t", "b", "alice");
    void emitIssueEvent(project.id, issue.id, "opened", ORIGIN);

    const start = Date.now();
    while (completed < N && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(completed).toBe(N);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  }, 10000);

  test("queued deliveries drain after early failures free slots", async () => {
    await ensureUser("alice");
    const project = await createProject("dog", "drain", "");
    for (let i = 0; i < 6; i++) {
      await createWebhook({
        project_id: project.id,
        url: `http://drain.local/${i}`,
        secret: "",
        events: ["issues"],
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    globalThis.fetch = ((_input: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          completed++;
          const status = completed % 2 === 0 ? 200 : 500;
          resolve(new Response("x", { status }));
        }, 30);
      });
    }) as typeof fetch;

    const issue = await createIssue(project.id, "t", "b", "alice");
    void emitIssueEvent(project.id, issue.id, "opened", ORIGIN);

    const start = Date.now();
    while (completed < 6 && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(completed).toBeGreaterThanOrEqual(6);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  }, 15000);
});
