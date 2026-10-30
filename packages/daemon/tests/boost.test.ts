import { describe, expect, it, vi } from "bun:test";
import type { TrackerRef } from "../src/trackers/types";

const ref: TrackerRef = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "7" };
const issue = { id: "iss-1", state: "active", trackerType: "gitea", trackerScopeKey: "acme/widgets", trackerIssueId: 7 };
const session = { id: "ses-1", uid: "ses-1", issueId: "iss-1", name: "ework-daemon", state: "idle" };
const msg = { id: "msg-1", uid: "msg-1", sessionId: "ses-1", status: "pending" };

describe("owner boost (web ⚡ button)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(runningCount: number) {
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.maxConcurrent = 8;
    self.running = new Map();
    self.lastOutputAt = new Map();
    self.apiIdleGraceMs = 180_000;
    self.startedAt = new Map();
    for (let i = 0; i < runningCount; i++) self.running.set(`k-${i}`, { pid: 1 });
    self.store = {
      findIssue: vi.fn(async () => issue),
      getPendingForIssue: vi.fn(async () => [msg]),
      getSession: vi.fn(async () => session),
      getIssue: vi.fn(async () => issue),
      claimMessage: vi.fn(async () => true),
      getSessionsForIssue: vi.fn(async () => []),
      createSession: vi.fn(async () => session),
    };
    self.dequeueOrIdle = vi.fn(async () => {});
    self.enqueueOrRun = vi.fn(async () => {});
    self.resolveWorkdir = vi.fn(async () => "/tmp/wd");
    self.buildForwardPrompt = vi.fn(() => "prompt");
    self.handleLargeContent = vi.fn((_wd: string, body: string) => body);
    self.sessionRef = vi.fn(() => "ework-daemon-test");
    self.cfg = { bot: { username: "ework-daemon-test" } };
    self.boostedIssueIds = new Set();
    self.pinnedIssueIds = new Set();
    return self;
  }

  const stubTracker = {
    getTrackerInstructions: () => "",
    createComment: () => Promise.resolve({}),
  } as unknown as Parameters<typeof Engine.prototype.handleBoost>[3];

  it("free slot → dispatches immediately, no queue pin", async () => {
    const self = makeSelf(0);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).toHaveBeenCalledTimes(1);
    expect(self.dequeueOrIdle).toHaveBeenCalledTimes(1);
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
  });

  it("API-saturated but below 2× process ceiling → still dispatches (owner policy 2026-10-23)", async () => {
    const self = makeSelf(8);
    const now = Date.now();
    for (let i = 0; i < 8; i++) self.lastOutputAt.set(`k-${i}`, now);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).toHaveBeenCalledTimes(1);
    expect(self.dequeueOrIdle).toHaveBeenCalledTimes(1);
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
  });

  it("process ceiling (2× cap) full → pins issue to front of queue, no claim", async () => {
    const self = makeSelf(16);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
    expect(self.dequeueOrIdle).not.toHaveBeenCalled();
    expect((self.boostedIssueIds as Set<string>).has("iss-1")).toBe(true);
  });

  it("no pending messages → creates an owner wake (empty-queue boost = owner decision, dog/ework-aio#6 2026-10-30)", async () => {
    const self = makeSelf(0);
    self.store.getPendingForIssue = vi.fn(async () => []);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, stubTracker);
    expect(self.store.createSession).toHaveBeenCalledTimes(1);
    expect(self.enqueueOrRun).toHaveBeenCalledTimes(1);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
  });

  it("no pending messages → closed issue stays a no-op", async () => {
    const self = makeSelf(0);
    self.store.getPendingForIssue = vi.fn(async () => []);
    self.store.findIssue = vi.fn(async () => ({ ...issue, state: "closed" }));
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "closed", author: "dog" }, stubTracker);
    expect(self.enqueueOrRun).not.toHaveBeenCalled();
  });

  it("pinned issue is exempt from the fairness yield (2026-10-23 #4373 regression)", async () => {
    const self = makeSelf(0);
    self.running = new Set();
    self.currentMessage = new Map();
    self.startedAt = new Map();
    self.lastOutputAt = new Map();
    self.apiIdleGraceMs = 180_000;
    const older = new Date(Date.now() - 30 * 60_000);
    const newer = new Date(Date.now() - 1 * 60_000);
    const updateMessageStatus = vi.fn(async () => {});
    self.store = {
      getOldestPendingCreatedAt: async () => older,
      getPendingForIssue: async () => [],
      getMessagesForSession: async () => [],
      countMessagesByStatus: async () => 0,
      updateMessageStatus,
      updateSession: async () => {},
    };
    self.startObserver = () => {};
    self.drainGlobalPending = async () => {};
    self.execProcess = vi.fn(async () => {});
    self.sessionRef = () => "x/y#7";
    self.resolveWorkdir = async () => "/tmp/wd";
    self.buildPrompt = async () => "p";
    self.spawn = async () => ({ exited: Promise.resolve(0) });
    self.ensureOwned = async () => {};
    (self.boostedIssueIds as Set<string>).add("iss-1");
    const msg = { id: "m1", createdAt: newer, pendingSince: newer };
    await Engine.prototype.dequeueOrIdle.call(self, "gitea:acme/widgets#7@ework-daemon", { id: "ses-1", name: "ework-daemon" }, issue, msg as never);
    expect(updateMessageStatus).not.toHaveBeenCalledWith("m1", "pending");
  });
});

describe("fresh submissions pin the issue (owner directive 2026-10-30: 优先级永远派发新提交的)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  it("enqueueOrRun pins the issue so the fairness yield cannot veto it behind stale backlog rows", async () => {
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.stuckNudgeRounds = new Map();
    self.processExitNudgeRounds = new Map();
    self.running = new Set();
    self.boostedIssueIds = new Set();
    self.pinnedIssueIds = new Set();
    self.pinnedIssueIds = new Set();
    self.isSentinelSource = () => false;
    self.isMergeGuardSource = () => false;
    self.isReviewSource = () => false;
    self.slotAvailable = () => true;
    self.projectConcurrencyCache = new Map();
    self.sessionKey = () => "gitea:acme/widgets#7@ework-daemon";
    self.executeMessage = vi.fn(async () => {});
    self.store = { createMessage: vi.fn(async () => ({ id: "m-9", sourceCommentId: undefined })) };
    const tracker = { updateStatus: vi.fn(async () => {}) };

    await Engine.prototype.enqueueOrRun.call(
      self, session as never, { ...issue, id: "iss-1" }, "fresh prompt", tracker as never, ref,
    );

    expect((self.pinnedIssueIds as Set<string>).has("iss-1")).toBe(true);
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
    expect(self.executeMessage).toHaveBeenCalledTimes(1);
  });
});
