import { describe, expect, test, vi } from "bun:test";

describe("handleCiFailed routing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const ref = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };
  const issueData = { title: "[PR] fix widgets", body: "", state: "open", author: "ranxianglei" };
  const ci = { sha: "deadbeef", checks: [{ name: "build", html_url: "https://x", conclusion: "failure" }] };

  function makeSelf(opts: { issueState?: string }) {
    const enqueueOrRun = vi.fn();
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] }, work: { ciFixMaxAttempts: 2, conflictFixMaxAttempts: 2, autoLaneWindowMs: 86_400_000 } };
    self.store = {
      findIssue: vi.fn(async () => ({ id: 7, state: opts.issueState ?? "active" })),
      createSession: vi.fn(async () => ({ id: "w1", name: "ci-worker" })),
      getSessionsForIssue: vi.fn(async () => []),
      countAutoLaneMessages: vi.fn(async () => 0),
      countMessagesByStatus: vi.fn(async () => 0),
    };
    self.ensureOwned = vi.fn(async () => true);
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_w: string, c: string) => c;
    self.enqueueOrRun = enqueueOrRun;
    return { self, enqueueOrRun };
  }

  const call = (self: Record<string, unknown>, tracker: unknown) =>
    Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, tracker, ci);

  test("routes to a sticky ci-worker with checks and attempt budget in the prompt", async () => {
    const { self, enqueueOrRun } = makeSelf({});
    const tracker = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "acme/widgets#42" }) };
    await call(self, tracker);
    const [s, i, prompt, , , sourceCommentId] = enqueueOrRun.mock.calls[0] as unknown as [unknown, { id: number }, string, unknown, unknown, string];
    expect(s).toEqual({ id: "w1", name: "ci-worker" });
    expect(i.id).toBe(7);
    expect(String(prompt)).toContain("build");
    expect(String(prompt)).toContain("attempt 1/2");
    expect(String(sourceCommentId)).toBe("ci-fail-42-deadbeef");
  });

  test("skips closed mirror issues", async () => {
    const { self, enqueueOrRun } = makeSelf({ issueState: "closed" });
    const tracker = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
  });
});

describe("execProcess ci-fix cap", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const session = { id: "s1", name: "ci-worker" };
  const issue = { id: 7, trackerScopeKey: "acme/widgets" };

  function makeSelf(runningCi: number) {
    const updateMessageStatus = vi.fn(async () => {});
    const gateChecker = vi.fn(async () => ({ allowed: false, unreachable: false, reason: "test-exit" }));
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.store = {
      getSession: vi.fn(async () => session),
      getIssue: vi.fn(async () => ({ id: 7, state: "open" })),
      countRunningCiMessages: vi.fn(async () => runningCi),
      updateMessageStatus,
    };
    self.gateChecker = gateChecker;
    self.ciMaxConcurrent = 1;
    self.conflictMaxConcurrent = 1;
    self.maxConcurrent = 1;
    self.running = new Map([["gitea:acme/widgets#1@ework-daemon", {}]]);
    self.lastOutputAt = new Map();
    self.apiIdleGraceMs = 180_000;
    self.startedAt = new Map();
    self.currentMessage = new Map();
    self.currentModel = new Map();
    self.generation = new Map();
    self.projectConcurrencyCache = new Map();
    self.processes = new Map();
    self.stopping = new Map();
    self.progressCommentId = new Map();
    self.nudgeRounds = new Map();
    self.processExitNudgeRounds = new Map();
    self.stuckNudgeRounds = new Map();
    self.currentPrompt = new Map();
    self.dequeueAfterGate = vi.fn(async () => {});
    return { self, updateMessageStatus, gateChecker };
  }

  test("defers ci-fail messages when the cap is taken, lets them through when free", async () => {
    const blocked = makeSelf(1);
    await Engine.prototype.execProcess.call(blocked.self, "k1", session, issue, { id: "m1", uid: "m1", sourceCommentId: "ci-fail-42-abc" });
    expect(blocked.updateMessageStatus).toHaveBeenCalledWith("m1", "pending");
    expect(blocked.gateChecker).not.toHaveBeenCalled();

    const free = makeSelf(0);
    await Engine.prototype.execProcess.call(free.self, "k2", session, issue, { id: "m2", uid: "m2", sourceCommentId: "ci-fail-42-abc" });
    expect(free.gateChecker).toHaveBeenCalledTimes(1);
  });

  test("settles messages as superseded when the issue closed while queued (billion-context#4948)", async () => {
    const closedWorld = makeSelf(0);
    (closedWorld.self.store as { getIssue: unknown }).getIssue = vi.fn(async () => ({ id: 7, state: "closed" }));
    await Engine.prototype.execProcess.call(closedWorld.self, "k3", session, issue, { id: "m3", uid: "m3", sourceCommentId: "ci-fail-42-abc" });
    expect(closedWorld.updateMessageStatus).toHaveBeenCalledWith("m3", "superseded", "issue closed while queued");
    expect(closedWorld.gateChecker).not.toHaveBeenCalled();
  });
});
