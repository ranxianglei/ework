import { describe, expect, test, vi } from "bun:test";

// Unified CI-engineer lane (owner policy 2026-11-03): fix 和接冲突由一个机器人干.
// WORK_CI_ENGINEER_MAX_ATTEMPTS presence switches daemon into engineer mode;
// absence keeps legacy per-lane behavior byte-for-byte.
describe("unified CI-engineer routing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const ref = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };
  const issueData = { title: "[PR] fix widgets", body: "", state: "open", author: "ranxianglei" };
  const ci = { sha: "deadbeef", checks: [{ name: "build", html_url: "https://x", conclusion: "failure" }] };

  function makeSelf(engineerCap?: number) {
    const enqueueOrRun = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracker: any = {
      createComment: vi.fn(async () => ({ id: "c1" })),
      getTrackerInstructions: () => ({ issueRef: "acme/widgets#42" }),
    };
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    const work: Record<string, unknown> = { autoLaneWindowMs: 86_400_000 };
    if (engineerCap !== undefined) work.ciEngineerMaxAttempts = engineerCap;
    else { work.ciFixMaxAttempts = 3; work.conflictFixMaxAttempts = 3; }
    self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] }, work };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      findIssue: vi.fn(async () => ({ id: 7, state: "active" })),
      countAutoLaneEngineerMessages: vi.fn(async () => 0),
      countAutoLaneMessages: vi.fn(async () => 0),
    };
    self.store = store;
    self.ensureOwned = vi.fn(async () => true);
    self.workerSession = vi.fn(async (_issueId: unknown, base: string) => ({ id: "w1", name: base }));
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_wd: string, c: string) => c;
    self.enqueueOrRun = enqueueOrRun;
    self.autoLaneDegradeNotified = new Map<string, number>();
    return { self, enqueueOrRun, tracker, store };
  }

  const callCi = (self: Record<string, unknown>, tracker: unknown) =>
    Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, tracker, ci);
  const callConflict = (self: Record<string, unknown>, tracker: unknown) =>
    Engine.prototype.handleMergeConflict.call(self, ref, "acme/widgets", issueData, tracker, "behind");

  function enqueueArgs(enqueueOrRun: ReturnType<typeof vi.fn>): string[] {
    const args = enqueueOrRun.mock.calls[0] as unknown[];
    return [String(args[2]), String(args[5])]; // prompt, sourceCommentId
  }

  test("engineer mode: ci_failed routes to the shared ci-engineer session, scid keeps ci-fail prefix", async () => {
    const { self, enqueueOrRun, tracker, store } = makeSelf(3);
    await callCi(self, tracker);
    expect(self.workerSession).toHaveBeenCalledWith(7, "ci-engineer");
    const [prompt, scid] = enqueueArgs(enqueueOrRun);
    expect(prompt).toContain("ONE bot owns BOTH");
    expect(prompt).toContain("attempt 1/3");
    expect(scid).toBe("ci-fail-42-deadbeef");
    expect(store.countAutoLaneEngineerMessages).toHaveBeenCalled();
  });

  test("engineer mode: merge_conflict routes to the same bot with rebase step first", async () => {
    const { self, enqueueOrRun, tracker } = makeSelf(3);
    await callConflict(self, tracker);
    expect(self.workerSession).toHaveBeenCalledWith(7, "ci-engineer");
    const [prompt, scid] = enqueueArgs(enqueueOrRun);
    expect(prompt).toContain("ONE bot owns BOTH");
    expect(prompt).toContain("conflicts with its base branch");
    expect(scid).toMatch(/^merge-conflict-42-/);
  });

  test("engineer mode cap=0: both events are dropped without dispatch or comments", async () => {
    const { self, enqueueOrRun, tracker } = makeSelf(0);
    await callCi(self, tracker);
    await callConflict(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(tracker.createComment).not.toHaveBeenCalled();
  });

  test("engineer mode: shared budget exhausted degrades with one notification, no dispatch", async () => {
    const { self, enqueueOrRun, tracker, store } = makeSelf(2);
    store.countAutoLaneEngineerMessages.mockResolvedValue(2);
    await callCi(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(tracker.createComment).toHaveBeenCalledTimes(1);
    const [r, text] = tracker.createComment.mock.calls[0] as [unknown, string];
    expect(r).toBe(ref);
    expect(text).toContain("CI 工程师车道（修CI+解冲突统一）已达上限");
  });

  test("legacy mode (key absent): ci_failed keeps the old ci-worker path", async () => {
    const { self, enqueueOrRun, tracker } = makeSelf(undefined);
    await callCi(self, tracker);
    expect(self.workerSession).toHaveBeenCalledWith(7, "ci-worker");
    const [prompt, scid] = enqueueArgs(enqueueOrRun);
    expect(prompt).not.toContain("ONE bot owns BOTH");
    expect(scid).toBe("ci-fail-42-deadbeef");
  });
  test("pr_unmergeable dirty routes to the ci-engineer lane in engineer mode (2026-11-10 conflict-backlog fix)", async () => {
    const { self, enqueueOrRun, tracker } = makeSelf(3);
    await Engine.prototype.handlePrUnmergeable.call(self, ref, "acme/widgets", issueData, tracker, "dirty", "conflict");
    expect(self.workerSession).toHaveBeenCalledWith(7, "ci-engineer");
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const [prompt, scid] = enqueueArgs(enqueueOrRun);
    expect(scid).toMatch(/^merge-conflict-42-\d+$/);
    expect(prompt).toContain("ONE bot owns BOTH");
  });

  test("pr_unmergeable behind/blocked stays on the legacy guard lane even in engineer mode", async () => {
    const { self, enqueueOrRun, tracker } = makeSelf(3);
    // behind keeps the guard-lane path (its own cap / kill switch)
    const guardStore = {
      findIssue: vi.fn(async () => ({ id: 7, state: "active" })),
      getSessionsForIssue: vi.fn(async () => []),
      countActiveMergeGuardMessages: vi.fn(async () => 0),
      createSession: vi.fn(async () => ({ id: "w1", name: "merge-guard" })),
    };
    (self as Record<string, unknown>).store = guardStore;
    (self as Record<string, unknown>).cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] }, work: { ciEngineerMaxAttempts: 3, autoLaneWindowMs: 86_400_000 } };
    await Engine.prototype.handlePrUnmergeable.call(self, ref, "acme/widgets", issueData, tracker, "behind", "behind");
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const [prompt, scid] = enqueueArgs(enqueueOrRun);
    expect(scid).toMatch(/^merge-guard-42-\d+$/);
    expect(prompt).toContain("update-branch");
  });

});

describe("execProcess engineer kill-switch", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(lanePrefix: string, engineerCap: number | undefined, legacyZero = false) {
    const updateMessageStatus = vi.fn(async () => {});
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    const work: Record<string, unknown> = { mergeGuardMaxAttempts: 3 };
    if (engineerCap !== undefined) work.ciEngineerMaxAttempts = engineerCap;
    else { work.ciFixMaxAttempts = legacyZero ? 0 : 3; work.conflictFixMaxAttempts = legacyZero ? 0 : 3; }
    self.cfg = { work };
    self.running = new Map();
    self.store = { getSession: vi.fn(async () => ({ id: "s1", name: "ci-engineer" })), updateMessageStatus };
    self.clearRuntimeState = vi.fn();
    const msg = { id: "m0000000", sessionId: "s1", sourceCommentId: `${lanePrefix}42-x` };
    const k = "gitea:acme/widgets#42@ci-engineer";
    const run = () => Engine.prototype.execProcess.call(self, k, { id: "s1", name: "ci-engineer" }, { id: 7, state: "open" }, msg);
    return { self, updateMessageStatus, run, msg };
  }

  test("engineer cap=0 settles queued ci-fail / merge-conflict messages superseded", async () => {
    for (const prefix of ["ci-fail-", "merge-conflict-"]) {
      const { updateMessageStatus, run } = makeSelf(prefix, 0);
      await run();
      expect(updateMessageStatus).toHaveBeenCalledWith("m0000000", "superseded", "lane disabled by owner config (cap=0)");
    }
  });

  test("engineer cap>0 lets the message past the kill-switch (no superseded)", async () => {
    const { updateMessageStatus, run } = makeSelf("ci-fail-", 3);
    // Let it fail later if further stubs are missing — all we assert here is
    // that the kill-switch itself did NOT fire.
    try { await run(); } catch { /* downstream stubs intentionally absent */ }
    const superseded = (updateMessageStatus.mock.calls as unknown[][]).filter((c) => c[1] === "superseded");
    expect(superseded).toHaveLength(0);
  });

  test("legacy zeros still gate per-lane when engineer key is absent", async () => {
    const { updateMessageStatus, run } = makeSelf("ci-fail-", undefined, true);
    await run();
    expect(updateMessageStatus).toHaveBeenCalledWith("m0000000", "superseded", "lane disabled by owner config (cap=0)");
  });


});
