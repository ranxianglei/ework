import { beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { Store } from "../src/op";
import { getDB, initDB } from "../src/db";
import type { TrackerRef } from "../src/trackers/types";

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
});

function ref(issueId: string, scopeKey = "dog/repo"): TrackerRef {
  return { trackerType: "gitea", scope: { owner: "dog", name: "repo" }, issueId };
}

describe("Store: issues", () => {
  it("findOrCreateIssue creates a new issue with state=created", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("100"), "dog/repo", "build broken");
    expect(issue.id).toBeTruthy();
    expect(issue.state).toBe("created");
    expect(issue.title).toBe("build broken");
    expect(issue.trackerIssueId).toBe("100");
    expect(issue.trackerScopeKey).toBe("dog/repo");
    await store.close();
  });

  it("findOrCreateIssue is idempotent by tracker ref (UNIQUE)", async () => {
    const store = new Store();
    const a = await store.findOrCreateIssue(ref("100"), "dog/repo", "t1");
    const b = await store.findOrCreateIssue(ref("100"), "dog/repo", "t1");
    expect(b.id).toBe(a.id);
    expect(await store.listAllIssues()).toHaveLength(1);
    await store.close();
  });

  it("findOrCreateIssue updates the title when it changes", async () => {
    const store = new Store();
    await store.findOrCreateIssue(ref("100"), "dog/repo", "old");
    const updated = await store.findOrCreateIssue(ref("100"), "dog/repo", "new title");
    expect(updated.title).toBe("new title");
    await store.close();
  });

  it("findIssue locates by tracker ref and returns undefined when missing", async () => {
    const store = new Store();
    expect(await store.findIssue("gitea", "dog/repo", "999")).toBeUndefined();
    await store.findOrCreateIssue(ref("999"), "dog/repo", "");
    expect((await store.findIssue("gitea", "dog/repo", "999"))?.trackerIssueId).toBe("999");
    await store.close();
  });

  it("getIssue locates by id and returns undefined when missing", async () => {
    const store = new Store();
    const created = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    expect((await store.getIssue(created.id))?.id).toBe(created.id);
    expect(await store.getIssue("nonexistent")).toBeUndefined();
    await store.close();
  });

  it("updateIssueState transitions state", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    await store.updateIssueState(issue.id, "active");
    expect((await store.getIssue(issue.id))?.state).toBe("active");
    await store.updateIssueState(issue.id, "closed");
    expect((await store.getIssue(issue.id))?.state).toBe("closed");
    await store.close();
  });

  it("listActiveIssues excludes closed; listAllIssues returns everything", async () => {
    const store = new Store();
    const open1 = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const open2 = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const closed = await store.findOrCreateIssue(ref("3"), "dog/repo", "");
    await store.updateIssueState(closed.id, "closed");
    expect((await store.listActiveIssues()).map(i => i.id).sort()).toEqual([open1.id, open2.id].sort());
    expect(await store.listAllIssues()).toHaveLength(3);
    await store.close();
  });
});

describe("Store: op_sessions", () => {
  it("createSession creates a session with state=idle", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");
    expect(session.id).toBeTruthy();
    expect(session.state).toBe("idle");
    expect(session.name).toBe("ework");
    expect(session.issueId).toBe(issue.id);
    await store.close();
  });

  it("createSession is idempotent by (issueId, name) — UNIQUE constraint", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const a = await store.createSession(issue.id, "ework");
    const b = await store.createSession(issue.id, "ework");
    expect(b.id).toBe(a.id);
    expect(await store.getSessionsForIssue(issue.id)).toHaveLength(1);
    await store.close();
  });

  it("different names on the same issue coexist", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    await store.createSession(issue.id, "ework");
    await store.createSession(issue.id, "tester");
    expect(await store.getSessionsForIssue(issue.id)).toHaveLength(2);
    await store.close();
  });

  it("getSession / getSessionByName locate sessions", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");
    expect((await store.getSession(session.id))?.id).toBe(session.id);
    expect((await store.getSessionByName(issue.id, "ework"))?.id).toBe(session.id);
    expect(await store.getSessionByName(issue.id, "missing")).toBeUndefined();
    await store.close();
  });

  it("updateSession applies a partial patch", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");
    const updated = await store.updateSession(session.id, {
      state: "running", opencodePid: 12345, workdir: "/tmp/repo", startedAt: 999,
    });
    expect(updated?.state).toBe("running");
    expect(updated?.opencodePid).toBe(12345);
    expect(updated?.workdir).toBe("/tmp/repo");
    expect(updated?.startedAt).toBe(999);
    const reloaded = await store.getSession(session.id);
    expect(reloaded?.opencodePid).toBe(12345);
    expect(reloaded?.startedAt).toBe(999);
    await store.close();
  });

  it("updateSession returns undefined for unknown id", async () => {
    const store = new Store();
    expect(await store.updateSession("missing", { state: "running" })).toBeUndefined();
    await store.close();
  });

  it("listNonIdleSessions excludes idle sessions", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const idle = await store.createSession(issue.id, "idle-one");
    const running = await store.createSession(issue.id, "runner");
    await store.updateSession(running.id, { state: "running" });
    const nonIdle = await store.listNonIdleSessions();
    expect(nonIdle.map(s => s.id)).toContain(running.id);
    expect(nonIdle.map(s => s.id)).not.toContain(idle.id);
    await store.close();
  });
});

describe("Store: messages", () => {
  async function seed() {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");
    return { store, issue, session };
  }

  it("createMessage creates a pending message with attempts=0", async () => {
    const { store, session } = await seed();
    const msg = await store.createMessage(session.id, "do the thing");
    expect(msg.status).toBe("pending");
    expect(msg.attempts).toBe(0);
    expect(msg.content).toBe("do the thing");
    expect(msg.sessionId).toBe(session.id);
    await store.close();
  });

  it("getMessage locates by id; undefined when missing", async () => {
    const { store, session } = await seed();
    const msg = await store.createMessage(session.id, "x");
    expect((await store.getMessage(msg.id))?.id).toBe(msg.id);
    expect(await store.getMessage("missing")).toBeUndefined();
    await store.close();
  });

  it("getNextPendingMessage returns the oldest pending for the session", async () => {
    const { store, session } = await seed();
    const first = await store.createMessage(session.id, "first");
    await new Promise(r => setTimeout(r, 5));
    const second = await store.createMessage(session.id, "second");
    expect((await store.getNextPendingMessage(session.id))?.id).toBe(first.id);
    await store.updateMessageStatus(first.id, "running");
    expect((await store.getNextPendingMessage(session.id))?.id).toBe(second.id);
    await store.close();
  });

  it("updateMessageStatus sets status; attempts increments only on failed", async () => {
    const { store, session } = await seed();
    const msg = await store.createMessage(session.id, "x");
    await store.updateMessageStatus(msg.id, "running");
    expect((await store.getMessage(msg.id))?.status).toBe("running");
    expect((await store.getMessage(msg.id))?.attempts).toBe(0);
    await store.updateMessageStatus(msg.id, "failed", "boom");
    const failed = await store.getMessage(msg.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.error).toBe("boom");
    await store.close();
  });

  it("getMessagesForSession returns DESC by created_at", async () => {
    const { store, session } = await seed();
    const a = await store.createMessage(session.id, "a");
    await new Promise(r => setTimeout(r, 5));
    const b = await store.createMessage(session.id, "b");
    const order = (await store.getMessagesForSession(session.id)).map(m => m.id);
    expect(order).toEqual([b.id, a.id]);
    await store.close();
  });

  it("getRecentMessages respects the limit", async () => {
    const { store, session } = await seed();
    for (let i = 0; i < 5; i++) await store.createMessage(session.id, `m${i}`);
    expect(await store.getRecentMessages(session.id, 2)).toHaveLength(2);
    await store.close();
  });

  it("getPendingOrRunningMessages spans all sessions, ASC", async () => {
    const { store, session } = await seed();
    const issue = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const session2 = await store.createSession(issue.id, "other");
    const m1 = await store.createMessage(session.id, "1");
    await new Promise(r => setTimeout(r, 5));
    const m2 = await store.createMessage(session2.id, "2");
    await store.updateMessageStatus(m1.id, "running");
    const pending = (await store.getPendingOrRunningMessages()).map(m => m.id);
    expect(pending).toEqual([m1.id, m2.id]);
    await store.close();
  });

  it("findMessageByCommentId locates by source comment id", async () => {
    const { store, session } = await seed();
    const msg = await store.createMessage(session.id, "x", "comment-42");
    expect((await store.findMessageByCommentId("comment-42"))?.id).toBe(msg.id);
    expect(await store.findMessageByCommentId("missing")).toBeUndefined();
    await store.close();
  });
});

describe("Store: uid surrogate key", () => {
  it("issues table has id column that auto-increments", async () => {
    const db = getDB();
    const store = new Store();
    await store.findOrCreateIssue(ref("700"), "dog/repo", "first");
    await store.findOrCreateIssue(ref("701"), "dog/repo", "second");
    const rows = await db.all<{ id: number; uid: string }>("SELECT id, uid FROM {{issues}} ORDER BY id");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBeGreaterThanOrEqual(1);
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
    await store.close();
  });

  it("op_sessions and messages have id columns", async () => {
    const db = getDB();
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("710"), "dog/repo", "t");
    const session = await store.createSession(issue.id, "s1");
    await store.createMessage(session.id, "hello", undefined);
    const sRow = await db.get<{ id: number }>("SELECT id FROM {{op_sessions}} WHERE uid = ?", [session.id]);
    const mRow = await db.get<{ id: number }>("SELECT id FROM {{messages}} LIMIT 1");
    expect(sRow?.id).toBeGreaterThanOrEqual(1);
    expect(mRow?.id).toBeGreaterThanOrEqual(1);
    await store.close();
  });
});
