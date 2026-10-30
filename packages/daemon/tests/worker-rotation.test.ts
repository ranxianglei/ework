import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { Engine } from "../src/opencode";

const makeSelf = () => {
  const self: Record<string, unknown> = Object.create(Engine.prototype);
  self.maxConcurrent = 8;
  self.conflictMaxConcurrent = 1;
  self.ciMaxConcurrent = 1;
  self.running = new Map();
  self.lastOutputAt = new Map();
  self.apiIdleGraceMs = 180_000;
  self.startedAt = new Map();
  self.boostedIssueIds = new Set();
    self.pinnedIssueIds = new Set();
  return self;
};

describe("worker session rotation (owner policy 2026-10-20)", () => {
  test("reuses sticky session under 20 done", async () => {
    const self = makeSelf();
    const sess = { id: "s1", name: "conflict-worker" };
    self.store = {
      getSessionsForIssue: async () => [sess],
      countMessagesByStatus: async () => 19,
      createSession: async (_iid: string, name: string) => ({ id: "s1", name }),
    };
    const out = await (self as { workerSession(i: string, b: string): Promise<{ id: string; name: string }> }).workerSession("i1", "conflict-worker");
    expect(out.name).toBe("conflict-worker");
  });

  test("rotates to -r2 after 20 done", async () => {
    const self = makeSelf();
    self.store = {
      getSessionsForIssue: async () => [{ id: "s1", name: "conflict-worker" }],
      countMessagesByStatus: async () => 20,
      createSession: async (_iid: string, name: string) => ({ id: "s2", name }),
    };
    const out = await (self as { workerSession(i: string, b: string): Promise<{ id: string; name: string }> }).workerSession("i1", "conflict-worker");
    expect(out.name).toBe("conflict-worker-r1");
  });

  test("picks the latest non-full generation", async () => {
    const self = makeSelf();
    self.store = {
      getSessionsForIssue: async () => [
        { id: "s1", name: "conflict-worker" },
        { id: "s2", name: "conflict-worker-r1" },
      ],
      countMessagesByStatus: async (sid: string) => (sid === "s2" ? 5 : 20),
      createSession: async (_iid: string, name: string) => ({ id: "s2", name }),
    };
    const out = await (self as { workerSession(i: string, b: string): Promise<{ id: string; name: string }> }).workerSession("i1", "conflict-worker");
    expect(out.name).toBe("conflict-worker-r1");
  });
});

describe("infra idle-fill (owner policy 2026-10-20)", () => {
  test("ordinary idle expands conflict cap to full fleet", () => {
    const self = makeSelf();
    self.running = new Map([
      ["k1@git:x/y#1@ework-daemon", { pid: 1 }],
    ]);
    const cap = (self as { infraIdleExpandedCap(b: number): number }).infraIdleExpandedCap(1);
    expect(cap).toBe(7);
  });

  test("busy ordinary lanes keep configured cap", () => {
    const self = makeSelf();
    self.running = new Map([
      ["k1@git:x/y#1@ework-daemon", { pid: 1 }],
      ["k2@git:x/y#2@ework-daemon", { pid: 2 }],
      ["k3@git:x/y#3@ework-daemon", { pid: 3 }],
      ["k4@git:x/y#4@ework-daemon", { pid: 4 }],
      ["k5@git:x/y#5@ework-daemon", { pid: 5 }],
      ["k6@git:x/y#6@ework-daemon", { pid: 6 }],
      ["k7@git:x/y#7@ework-daemon", { pid: 7 }],
      ["k8@git:x/y#8@ework-daemon", { pid: 8 }],
    ]);
    const cap = (self as { infraIdleExpandedCap(b: number): number }).infraIdleExpandedCap(1);
    expect(cap).toBe(1);
  });

  test("running infra keys do not squeeze the expansion", () => {
    const self = makeSelf();
    self.running = new Map([
      ["k1@git:x/y#9@conflict-worker", { pid: 1 }],
    ]);
    const cap = (self as { infraIdleExpandedCap(b: number): number }).infraIdleExpandedCap(1);
    expect(cap).toBe(8);
  });
});

// Dispatch-on-free-slot (owner 2026-10-30): ordering is decided by the
// age-first queue and issue pins, never by releasing claims — the former
// yield gate deadlocked the fleet three times.
describe("queue fairness guard", () => {
  test("newer per-session candidate dispatches; claims are never released for ordering", async () => {
    const self = makeSelf();
    self.running = new Set();
    self.currentMessage = new Map();
    const newer = new Date(Date.now() - 1 * 60_000);
    let drained = false;
    let executed = false;
    const updateMessageStatus = vi.fn(async () => {});
    const updateSession = vi.fn(async () => {});
    self.store = {
      getPendingForIssue: async () => [],
      getMessagesForSession: async () => [],
      countMessagesByStatus: async () => 0,
      updateMessageStatus,
      updateSession,
    };
    self.startObserver = () => {};
    self.execProcess = async () => { executed = true; };
    self.drainGlobalPending = async () => { drained = true; };
    const msg = { id: "m1", createdAt: newer, pendingSince: newer };
    await (self as { dequeueOrIdle(k: string, s: unknown, i: unknown, m: unknown): Promise<void> }).dequeueOrIdle("k@git:x/y#1@ework-daemon", { id: "s1", name: "ework-daemon" }, { id: "i1", trackerType: "gitea", trackerScopeKey: "x/y", trackerIssueId: 1 }, msg as never);
    expect(drained).toBe(false);
    expect(updateMessageStatus).not.toHaveBeenCalledWith("m1", "pending");
    expect(updateSession).not.toHaveBeenCalledWith("s1", { state: "idle" });
    expect(executed).toBe(true);
  });

  test("globally-oldest message proceeds without yielding", async () => {
    const self = makeSelf();
    self.running = new Set();
    self.currentMessage = new Map();
    const t = new Date(Date.now() - 30 * 60_000);
    let drained = false;
    let observed = false;
    self.store = {
      getOldestPendingCreatedAt: async () => t,
      getPendingForIssue: async () => [],
      getMessagesForSession: async () => [],
      countMessagesByStatus: async () => 0,
      updateMessageStatus: async () => {},
      updateSession: async () => {},
    };
    self.execProcess = async () => {};
    self.startObserver = () => { observed = true; };
    self.drainGlobalPending = async () => { drained = true; };
    const msg = { id: "m1", createdAt: t, pendingSince: t };
    await (self as unknown as { dequeueOrIdle(k: string, s: unknown, i: unknown, m: unknown): Promise<void> }).dequeueOrIdle("k@git:x/y#1@ework-daemon", { id: "s1", name: "ework-daemon" }, { id: "i1", trackerType: "gitea", trackerScopeKey: "x/y", trackerIssueId: 1 }, msg as never);
    expect(drained).toBe(false);
    expect(observed).toBe(true);
  });
});
