// 2026-11-14 owner decision (billion-context release flood): the CI lane pool
// must stay at its configured cap (WORK_CI_MAX_CONCURRENT, ×2 at night) and
// must NOT borrow idle fleet capacity via infraIdleExpandedCap. One rebase
// push onto an old PR branch re-triggers the full upstream suite (~13
// workflow runs), so an idle-expanded pool of ~10 turned a quiet fleet into
// a 10-wide rebase storm that starved release runs.
import { describe, expect, test, vi } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Engine } = require("../src/opencode") as { Engine: any };

function makeSelf(opts: { cap: number; runningEngineer: number; engineerMode: boolean }) {
  const updateMessageStatus = vi.fn(async () => {});
  const gateChecker = vi.fn(async () => ({ allowed: false, unreachable: false, reason: "test-exit" }));
  const self = Object.create(Engine.prototype) as Record<string, unknown>;
  self.store = {
    getSession: vi.fn(async () => ({ id: "s1", name: "ework-daemon" })),
    getIssue: vi.fn(async () => ({ id: 7, state: "open" })),
    countRunningEngineerMessages: vi.fn(async () => opts.runningEngineer),
    countRunningCiMessages: vi.fn(async () => opts.runningEngineer),
    countRunningConflictMessages: vi.fn(async () => 0),
    updateMessageStatus,
  };
  self.gateChecker = gateChecker;
  // engineerMode is a getter over cfg.work.ciEngineerMaxAttempts — drive it
  // through the config, not by assigning the readonly accessors.
  self.cfg = { work: { ciFixMaxAttempts: 3, conflictFixMaxAttempts: 3, ciEngineerMaxAttempts: opts.engineerMode ? 3 : undefined } };
  self.ciMaxConcurrent = opts.cap;
  self.conflictMaxConcurrent = 1;
  // infraNightBoost stays unset (falsy) => infraNightActive() is false.
  // IDLE fleet: freeGlobal = maxConcurrent - 0, so infraIdleExpandedCap WOULD
  // expand a pool of `cap` up to `cap + 8` if it were still applied here.
  self.maxConcurrent = opts.cap + 8;
  self.running = new Map<string, unknown>();
  self.lastOutputAt = new Map();
  self.apiIdleGraceMs = 180_000;
  self.startedAt = new Map();
  self.currentMessage = new Map();
  self.currentModel = new Map();
  self.generation = new Map();
  self.projectConcurrencyCache = new Map();
  self.dequeueAfterGate = vi.fn(async () => {});
  return { self, updateMessageStatus, gateChecker };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session: any = { id: "s1", name: "ework-daemon" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const issue: any = { id: 7, trackerScopeKey: "acme/widgets" };

describe("CI lane pool: hard cap, no idle-fleet expansion (2026-11-14 flood fix)", () => {
  test("engineer mode: pool stays at configured cap while the fleet is idle", async () => {
    // 2 running engineer messages, configured cap 2, fleet wide open.
    // Pre-fix this admitted a 10th (freeGlobal) — the flood.
    const msg = { id: "m1", uid: "m1", sourceCommentId: "ci-fail-42-1" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ cap: 2, runningEngineer: 2, engineerMode: true });
    await Engine.prototype.execProcess.call(self, "k1", session, issue, msg);
    expect(updateMessageStatus).toHaveBeenCalledWith("m1", "pending");
    expect(gateChecker).not.toHaveBeenCalled();
    expect((self.running as Map<string, unknown>).has("k1")).toBe(false);
  });

  test("engineer mode: cap 2 admits exactly the second slot, not the idle-expanded ones", async () => {
    const msg = { id: "m2", uid: "m2", sourceCommentId: "ci-fail-43-1" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ cap: 2, runningEngineer: 1, engineerMode: true });
    await Engine.prototype.execProcess.call(self, "k2", session, issue, msg);
    expect(gateChecker).toHaveBeenCalledTimes(1);
    // gate fails in the fixture — proves the pool check admitted it.
    expect(updateMessageStatus).toHaveBeenCalledWith("m2", "failed", "gate: test-exit");
  });

  test("legacy ci-fix mode (no engineer lane): same hard cap", async () => {
    const msg = { id: "m3", uid: "m3", sourceCommentId: "ci-fail-44-1" };
    const { self, updateMessageStatus, gateChecker } = makeSelf({ cap: 1, runningEngineer: 1, engineerMode: false });
    await Engine.prototype.execProcess.call(self, "k3", session, issue, msg);
    expect(updateMessageStatus).toHaveBeenCalledWith("m3", "pending");
    expect(gateChecker).not.toHaveBeenCalled();
  });
});
