import { describe, expect, test, vi, beforeAll, beforeEach } from "bun:test";
import { Store } from "../src/op";
import { getDB, initDB } from "../src/db";

beforeAll(async () => {
  await initDB();
});

async function seedStore() {
  const store = new Store();
  const issue = await store.findOrCreateIssue(
    { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" },
    "acme/widgets",
    "conflict cap",
  );
  const session = await store.createSession(issue.id, "ework-daemon");
  return { store, session };
}

describe("Store.countRunningConflictMessages", () => {
  beforeEach(async () => {
    const db = getDB();
    await db.exec("PRAGMA foreign_keys = OFF");
    for (const t of ["messages", "op_sessions", "issues"]) {
      await db.exec(`DELETE FROM {{${t}}}`);
    }
    await db.exec("PRAGMA foreign_keys = ON");
  });

  test("counts only running merge-conflict messages and excludes the given uid", async () => {
    const { store, session } = await seedStore();
    const a = await store.createMessage(session.id, "a", "merge-conflict-42-1");
    const b = await store.createMessage(session.id, "b", "merge-conflict-43-1");
    const c = await store.createMessage(session.id, "c", "merge-conflict-44-1");
    const d = await store.createMessage(session.id, "d", "plain-comment");
    for (const m of [a, b, c, d]) {
      await getDB().run("UPDATE {{messages}} SET status = 'running' WHERE uid = ?", [m.id]);
    }
    expect(await store.countRunningConflictMessages("none")).toBe(3);
    expect(await store.countRunningConflictMessages(a.id)).toBe(2);
    expect(await store.countRunningConflictMessages(b.id)).toBe(2);
  });
});

describe("execProcess merge-conflict concurrency cap", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(opts: { runningConflicts: number; cap: number }) {
    const updateMessageStatus = vi.fn(async () => {});
    const gateChecker = vi.fn(async () => ({ allowed: false, unreachable: false, reason: "test-exit" }));
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.store = {
      getSession: vi.fn(async () => ({ id: "s1", name: "ework-daemon" })),
      countRunningConflictMessages: vi.fn(async () => opts.runningConflicts),
      updateMessageStatus,
    };
    self.gateChecker = gateChecker;
    self.conflictMaxConcurrent = opts.cap;
    self.running = new Map();
    self.currentMessage = new Map();
    self.currentModel = new Map();
    self.generation = new Map();
    self.projectConcurrencyCache = new Map();
    self.dequeueAfterGate = vi.fn(async () => {});
    return { self, updateMessageStatus, gateChecker };
  }

  const session = { id: "s1", name: "ework-daemon" };
  const issue = { id: 7, trackerScopeKey: "acme/widgets" };

  test("defers a conflict message when the cap is already taken", async () => {
    const msg = { id: "m2", uid: "m2", sourceCommentId: "merge-conflict-43-1" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ runningConflicts: 1, cap: 1 });
    await Engine.prototype.execProcess.call(self, "k1", session, issue, msg);
    expect(updateMessageStatus).toHaveBeenCalledWith("m2", "pending");
    expect(gateChecker).not.toHaveBeenCalled();
    expect((self.running as Map<string, unknown>).has("k1")).toBe(false);
  });

  test("lets a conflict message through when a slot is free", async () => {
    const msg = { id: "m2", uid: "m2", sourceCommentId: "merge-conflict-43-1" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ runningConflicts: 0, cap: 1 });
    await Engine.prototype.execProcess.call(self, "k1", session, issue, msg);
    expect(gateChecker).toHaveBeenCalledTimes(1);
    expect(updateMessageStatus).toHaveBeenCalledWith("m2", "failed", "gate: test-exit");
  });

  test("never defers plain (non-conflict) messages", async () => {
    const msg = { id: "m3", uid: "m3", sourceCommentId: "comment-9" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ runningConflicts: 5, cap: 1 });
    await Engine.prototype.execProcess.call(self, "k1", session, issue, msg);
    expect(gateChecker).toHaveBeenCalledTimes(1);
    expect(updateMessageStatus).not.toHaveBeenCalledWith("m3", "pending");
  });

  test("cap of 2 admits a second concurrent conflict run", async () => {
    const msg = { id: "m4", uid: "m4", sourceCommentId: "merge-conflict-44-1" };
    const { self, gateChecker } = makeSelf({ runningConflicts: 1, cap: 2 });
    await Engine.prototype.execProcess.call(self, "k1", session, issue, msg);
    expect(gateChecker).toHaveBeenCalledTimes(1);
  });
});
