import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "../src/op";
import type { TrackerRef } from "../src/trackers/types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ework-daemon-store-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function newStore(): Store {
  return new Store(join(tmpDir, "test.db"));
}

function ref(issueId: string, scopeKey = "dog/repo"): TrackerRef {
  return { trackerType: "gitea", scope: { owner: "dog", name: "repo" }, issueId };
}

describe("Store: issues", () => {
  it("findOrCreateIssue creates a new issue with state=created", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("100"), "dog/repo", "build broken");
    expect(issue.id).toBeTruthy();
    expect(issue.state).toBe("created");
    expect(issue.title).toBe("build broken");
    expect(issue.trackerIssueId).toBe("100");
    expect(issue.trackerScopeKey).toBe("dog/repo");
    store.close();
  });

  it("findOrCreateIssue is idempotent by tracker ref (UNIQUE)", () => {
    const store = newStore();
    const a = store.findOrCreateIssue(ref("100"), "dog/repo", "t1");
    const b = store.findOrCreateIssue(ref("100"), "dog/repo", "t1");
    expect(b.id).toBe(a.id);
    expect(store.listAllIssues()).toHaveLength(1);
    store.close();
  });

  it("findOrCreateIssue updates the title when it changes", () => {
    const store = newStore();
    store.findOrCreateIssue(ref("100"), "dog/repo", "old");
    const updated = store.findOrCreateIssue(ref("100"), "dog/repo", "new title");
    expect(updated.title).toBe("new title");
    store.close();
  });

  it("findIssue locates by tracker ref and returns undefined when missing", () => {
    const store = newStore();
    expect(store.findIssue("gitea", "dog/repo", "999")).toBeUndefined();
    store.findOrCreateIssue(ref("999"), "dog/repo", "");
    expect(store.findIssue("gitea", "dog/repo", "999")?.trackerIssueId).toBe("999");
    store.close();
  });

  it("getIssue locates by id and returns undefined when missing", () => {
    const store = newStore();
    const created = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    expect(store.getIssue(created.id)?.id).toBe(created.id);
    expect(store.getIssue("nonexistent")).toBeUndefined();
    store.close();
  });

  it("updateIssueState transitions state", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    store.updateIssueState(issue.id, "active");
    expect(store.getIssue(issue.id)?.state).toBe("active");
    store.updateIssueState(issue.id, "closed");
    expect(store.getIssue(issue.id)?.state).toBe("closed");
    store.close();
  });

  it("listActiveIssues excludes closed; listAllIssues returns everything", () => {
    const store = newStore();
    const open1 = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const open2 = store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const closed = store.findOrCreateIssue(ref("3"), "dog/repo", "");
    store.updateIssueState(closed.id, "closed");
    expect(store.listActiveIssues().map(i => i.id).sort()).toEqual([open1.id, open2.id].sort());
    expect(store.listAllIssues()).toHaveLength(3);
    store.close();
  });
});

describe("Store: op_sessions", () => {
  it("createSession creates a session with state=idle", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = store.createSession(issue.id, "ework");
    expect(session.id).toBeTruthy();
    expect(session.state).toBe("idle");
    expect(session.name).toBe("ework");
    expect(session.issueId).toBe(issue.id);
    store.close();
  });

  it("createSession is idempotent by (issueId, name) — UNIQUE constraint", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const a = store.createSession(issue.id, "ework");
    const b = store.createSession(issue.id, "ework");
    expect(b.id).toBe(a.id);
    expect(store.getSessionsForIssue(issue.id)).toHaveLength(1);
    store.close();
  });

  it("different names on the same issue coexist", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    store.createSession(issue.id, "ework");
    store.createSession(issue.id, "tester");
    expect(store.getSessionsForIssue(issue.id)).toHaveLength(2);
    store.close();
  });

  it("getSession / getSessionByName locate sessions", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = store.createSession(issue.id, "ework");
    expect(store.getSession(session.id)?.id).toBe(session.id);
    expect(store.getSessionByName(issue.id, "ework")?.id).toBe(session.id);
    expect(store.getSessionByName(issue.id, "missing")).toBeUndefined();
    store.close();
  });

  it("updateSession applies a partial patch", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = store.createSession(issue.id, "ework");
    const updated = store.updateSession(session.id, {
      state: "running", opencodePid: 12345, workdir: "/tmp/repo", startedAt: 999,
    });
    expect(updated?.state).toBe("running");
    expect(updated?.opencodePid).toBe(12345);
    expect(updated?.workdir).toBe("/tmp/repo");
    expect(updated?.startedAt).toBe(999);
    const reloaded = store.getSession(session.id);
    expect(reloaded?.opencodePid).toBe(12345);
    expect(reloaded?.startedAt).toBe(999);
    store.close();
  });

  it("updateSession returns undefined for unknown id", () => {
    const store = newStore();
    expect(store.updateSession("missing", { state: "running" })).toBeUndefined();
    store.close();
  });

  it("listNonIdleSessions excludes idle sessions", () => {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const idle = store.createSession(issue.id, "idle-one");
    const running = store.createSession(issue.id, "runner");
    store.updateSession(running.id, { state: "running" });
    const nonIdle = store.listNonIdleSessions();
    expect(nonIdle.map(s => s.id)).toContain(running.id);
    expect(nonIdle.map(s => s.id)).not.toContain(idle.id);
    store.close();
  });
});

describe("Store: messages", () => {
  function seed() {
    const store = newStore();
    const issue = store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = store.createSession(issue.id, "ework");
    return { store, issue, session };
  }

  it("createMessage creates a pending message with attempts=0", () => {
    const { store, session } = seed();
    const msg = store.createMessage(session.id, "do the thing");
    expect(msg.status).toBe("pending");
    expect(msg.attempts).toBe(0);
    expect(msg.content).toBe("do the thing");
    expect(msg.sessionId).toBe(session.id);
    store.close();
  });

  it("getMessage locates by id; undefined when missing", () => {
    const { store, session } = seed();
    const msg = store.createMessage(session.id, "x");
    expect(store.getMessage(msg.id)?.id).toBe(msg.id);
    expect(store.getMessage("missing")).toBeUndefined();
    store.close();
  });

  it("getNextPendingMessage returns the oldest pending for the session", async () => {
    const { store, session } = seed();
    const first = store.createMessage(session.id, "first");
    await new Promise(r => setTimeout(r, 5));
    const second = store.createMessage(session.id, "second");
    expect(store.getNextPendingMessage(session.id)?.id).toBe(first.id);
    store.updateMessageStatus(first.id, "running");
    expect(store.getNextPendingMessage(session.id)?.id).toBe(second.id);
    store.close();
  });

  it("updateMessageStatus sets status; attempts increments only on failed", () => {
    const { store, session } = seed();
    const msg = store.createMessage(session.id, "x");
    store.updateMessageStatus(msg.id, "running");
    expect(store.getMessage(msg.id)?.status).toBe("running");
    expect(store.getMessage(msg.id)?.attempts).toBe(0);
    store.updateMessageStatus(msg.id, "failed", "boom");
    const failed = store.getMessage(msg.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.error).toBe("boom");
    store.close();
  });

  it("getMessagesForSession returns DESC by created_at", async () => {
    const { store, session } = seed();
    const a = store.createMessage(session.id, "a");
    await new Promise(r => setTimeout(r, 5));
    const b = store.createMessage(session.id, "b");
    const order = store.getMessagesForSession(session.id).map(m => m.id);
    expect(order).toEqual([b.id, a.id]);
    store.close();
  });

  it("getRecentMessages respects the limit", () => {
    const { store, session } = seed();
    for (let i = 0; i < 5; i++) store.createMessage(session.id, `m${i}`);
    expect(store.getRecentMessages(session.id, 2)).toHaveLength(2);
    store.close();
  });

  it("getPendingOrRunningMessages spans all sessions, ASC", async () => {
    const { store, session } = seed();
    const issue = store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const session2 = store.createSession(issue.id, "other");
    const m1 = store.createMessage(session.id, "1");
    await new Promise(r => setTimeout(r, 5));
    const m2 = store.createMessage(session2.id, "2");
    store.updateMessageStatus(m1.id, "running");
    const pending = store.getPendingOrRunningMessages().map(m => m.id);
    expect(pending).toEqual([m1.id, m2.id]);
    store.close();
  });

  it("findMessageByCommentId locates by source comment id", () => {
    const { store, session } = seed();
    const msg = store.createMessage(session.id, "x", "comment-42");
    expect(store.findMessageByCommentId("comment-42")?.id).toBe(msg.id);
    expect(store.findMessageByCommentId("missing")).toBeUndefined();
    store.close();
  });
});
