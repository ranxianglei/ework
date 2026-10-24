import { describe, expect, test, vi } from "bun:test";
import type { TrackerRef, TrackerEvent } from "../src/trackers/types";

// Retry cap + degradation for the auto-repair lanes (owner directive
// 2026-10-24): beyond N ci-fail / merge-conflict dispatches per PR within
// the window, the lane stops dispatching, posts one ⛔ comment, and goes
// quiet until the window expires.

const ref: TrackerRef = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };
const issueData: TrackerEvent["issue"] = {
  title: "[PR] fix widgets",
  body: "",
  state: "open",
  author: "ranxianglei",
};

describe("auto-lane retry cap + degradation", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(opts: { attempts: number }) {
    const enqueueOrRun = vi.fn();
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = {
      bot: { username: "ework-daemon" },
      daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] },
      work: { ciFixMaxAttempts: 2, conflictFixMaxAttempts: 2, autoLaneWindowMs: 86_400_000 },
    };
    self.store = {
      findIssue: vi.fn(async () => ({ id: 7, state: "active" })),
      createSession: vi.fn(async () => ({ id: "w1", name: "ci-worker-r1" })),
      getSessionsForIssue: vi.fn(async () => [{ id: "w1", name: "ci-worker-r1" }]),
      countMessagesByStatus: vi.fn(async () => 0),
      countAutoLaneMessages: vi.fn(async () => opts.attempts),
    };
    self.conflictCategory = () => "N";
    self.autoLaneDegradeNotified = new Map();
    self.ensureOwned = vi.fn(async () => true);
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_w: string, c: string) => c;
    self.enqueueOrRun = enqueueOrRun;
    return { self, enqueueOrRun };
  }

  const tracker = () => ({
    createComment: vi.fn(async (_ref: unknown, _body: string) => ({ id: "c1" })),
    getTrackerInstructions: () => ({ issueRef: "acme/widgets#42" }),
  });

  test("ci-fail at cap: no dispatch, one degrade comment", async () => {
    const { self, enqueueOrRun } = makeSelf({ attempts: 2 });
    const t = tracker();
    await Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, t, { sha: "abc123def456", checks: [{ name: "ci" }] });
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(t.createComment).toHaveBeenCalledTimes(1);
    const body = (t.createComment.mock.calls[0]?.[1] ?? "") as string;
    expect(body).toContain("CI 自动修复车道已达上限");
  });

  test("ci-fail below cap: dispatches with attempt annotation", async () => {
    const { self, enqueueOrRun } = makeSelf({ attempts: 1 });
    const t = tracker();
    await Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, t, { sha: "abc123def456", checks: [{ name: "ci" }] });
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const prompt = (enqueueOrRun.mock.calls[0]?.[2] ?? "") as string;
    expect(prompt).toContain("attempt 2/2");
  });

  test("degrade comment posted once per window, not per event", async () => {
    const { self, enqueueOrRun } = makeSelf({ attempts: 3 });
    const t = tracker();
    const ci = { sha: "abc123def456", checks: [{ name: "ci" }] };
    await Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, t, ci);
    await Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, t, ci);
    await Engine.prototype.handleCiFailed.call(self, ref, "acme/widgets", issueData, t, ci);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(t.createComment).toHaveBeenCalledTimes(1);
  });

  test("merge-conflict at cap: no dispatch, degrade comment", async () => {
    const { self, enqueueOrRun } = makeSelf({ attempts: 2 });
    const t = tracker();
    await Engine.prototype.handleMergeConflict.call(self, ref, "acme/widgets", issueData, t, "dirty");
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(t.createComment).toHaveBeenCalledTimes(1);
    expect((t.createComment.mock.calls[0]?.[1] ?? "") as string).toContain("冲突自动处理车道已达上限");
  });

  test("merge-conflict below cap: dispatches with attempt annotation", async () => {
    const { self, enqueueOrRun } = makeSelf({ attempts: 0 });
    const t = tracker();
    await Engine.prototype.handleMergeConflict.call(self, ref, "acme/widgets", issueData, t, "dirty");
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const prompt = (enqueueOrRun.mock.calls[0]?.[2] ?? "") as string;
    expect(prompt).toContain("attempt 1/2");
  });
});
