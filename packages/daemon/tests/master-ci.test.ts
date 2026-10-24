import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Engine } from "../src/opencode";
import type { Issue, OpSession, TrackerRef } from "../src/trackers/types";

function makeSelf(opts: { attempts?: number } = {}) {
  const self = Object.create(Engine.prototype) as any;
  self.cfg = {
    work: { ciFixMaxAttempts: 2, ciMasterFixMaxAttempts: 3, conflictFixMaxAttempts: 2, autoLaneWindowMs: 86_400_000 },
    bot: { username: "ework-daemon", avatar: "", password: "", wakeLogins: [] },
  };
  self.store = {
    findIssue: vi.fn(async () => ({ id: "i1", state: "active" })),
    countAutoLaneMessages: vi.fn(async () => opts.attempts ?? 0),
    getSessionsForIssue: vi.fn(async () => [{ id: "w1", name: "ci-master-sentinel-r1" } as OpSession]),
    countMessagesByStatus: vi.fn(async () => 5),
    createSession: vi.fn(async () => ({ id: "w2", name: "ci-master-sentinel-r2" } as OpSession)),
    updateMessageStatus: vi.fn(async () => true),
  };
  self.workerSession = vi.fn(async (_issueId: string, base: string) => ({ id: "w1", name: `${base}-r1` } as OpSession));
  self.ensureOwned = vi.fn(async () => true);
  self.resolveWorkdir = vi.fn(async (s: OpSession) => `/tmp/wd-${s.name}`);
  self.handleLargeContent = vi.fn((_wd: string, body: string) => body);
  self.buildForwardPrompt = vi.fn((_n: string, body: string) => `P:${body}`);
  self.enqueueOrRun = vi.fn(async () => {});
  self.autoLaneDegradeNotified = new Map();
  return self;
}

function tracker() {
  return {
    createComment: vi.fn(async (_ref: unknown, _body: string) => ({ id: "c1" })),
    getTrackerInstructions: vi.fn(() => "instr"),
  } as any;
}

const ref: TrackerRef = { trackerType: "gitea", scope: { k: "v" }, issueId: "4599" };
const issueData = { title: "CI 总控", body: "", state: "open", author: "dog" };
const ci = { sha: "abc123def0", checks: [{ name: "CI", conclusion: "failure" }] };

describe("master_ci_failed sentinel", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  test("dispatches sticky ci-master-sentinel with attempt counter and master fix protocol", async () => {
    const self = makeSelf();
    const t = tracker();
    await self.handleMasterCiFailed(ref, "ranxianglei/billion-context", issueData, t, ci, undefined);
    expect(self.workerSession).toHaveBeenCalledWith("i1", "ci-master-sentinel");
    expect(self.enqueueOrRun).toHaveBeenCalledTimes(1);
    const sourceId = self.enqueueOrRun.mock.calls[0][5] as string;
    expect(sourceId.startsWith("ci-master-4599-")).toBe(true);
    const prompt = self.buildForwardPrompt.mock.calls[0][1] as string;
    expect(prompt).toContain("attempt 1/3");
    expect(prompt).toContain("master");
    const comment = t.createComment.mock.calls[0]?.[1] ?? "";
    expect(comment).toContain("哨兵已接管");
  });

  test("below cap but non-zero attempts renders current attempt number", async () => {
    const self = makeSelf({ attempts: 1 });
    await self.handleMasterCiFailed(ref, "ranxianglei/billion-context", issueData, tracker(), ci, undefined);
    expect(self.buildForwardPrompt.mock.calls[0]?.[1] ?? "").toContain("attempt 2/3");
  });

  test("at cap: no dispatch, one degrade comment per window", async () => {
    const self = makeSelf({ attempts: 3 });
    const t = tracker();
    await self.handleMasterCiFailed(ref, "ranxianglei/billion-context", issueData, t, ci, undefined);
    await self.handleMasterCiFailed(ref, "ranxianglei/billion-context", issueData, t, ci, undefined);
    expect(self.enqueueOrRun).not.toHaveBeenCalled();
    expect(t.createComment).toHaveBeenCalledTimes(1);
    expect(t.createComment.mock.calls[0]?.[1] ?? "").toContain("master CI 哨兵已达上限");
  });

  test("closed coordination issue is ignored", async () => {
    const self = makeSelf();
    self.store.findIssue = vi.fn(async () => ({ id: "i1", state: "closed" } as Issue));
    await self.handleMasterCiFailed(ref, "ranxianglei/billion-context", issueData, tracker(), ci, undefined);
    expect(self.enqueueOrRun).not.toHaveBeenCalled();
  });
});
