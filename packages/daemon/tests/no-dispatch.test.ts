import { describe, expect, test, vi } from "bun:test";
import type { TrackerRef, TrackerEvent } from "../src/trackers/types";

const ref: TrackerRef = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };

describe("issue_opened [no-dispatch] marker gating", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(opts: { body: string; issueState?: string }) {
    const handleOpened = vi.fn();
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [], wakeKinds: ["human"] } };
    self.store = {
      findIssue: vi.fn(async () => ({ id: 7, state: opts.issueState ?? "active" })),
      updateIssueState: vi.fn(async () => {}),
    };
    self.paused = false;
    self.getTracker = () => ({ formatScopeKey: () => "acme/widgets" });
    self.projectWakeConfig = vi.fn(async () => ({ logins: [], communityWake: false }));
    self.externalWakeStamps = new Map();
    self.handleOpened = handleOpened;
    self.handleCommented = vi.fn();
    self.handleClosed = vi.fn();
    self.handleMergeConflict = vi.fn();
    return { self, handleOpened };
  }

  const issue = (body: string): TrackerEvent => ({
    type: "issue_opened",
    ref,
    issue: { title: "fix the thing", body, state: "open", author: "ranxianglei" },
  });

  const call = async (self: Record<string, unknown>, ev: TrackerEvent) =>
    Engine.prototype.handleEvent.call(self, ev);

  test("issue body carrying [no-dispatch] never reaches handleOpened", async () => {
    const { self, handleOpened } = makeSelf({ body: "record-only" });
    await call(self, issue("[no-dispatch] fix ships in PR #123, record-only"));
    expect(handleOpened).not.toHaveBeenCalled();
  });

  test("normal issues pass the gate and reach handleOpened", async () => {
    const { self, handleOpened } = makeSelf({ body: "normal" });
    await call(self, issue("normal body without the marker"));
    expect(handleOpened).toHaveBeenCalledTimes(1);
  });

  const ciIssue = (title: string): TrackerEvent => ({
    type: "issue_opened",
    ref,
    issue: { title, body: "ci report", state: "open", author: "ranxianglei" },
  });

  test("CI-mentioning titles never auto-dispatch (case-insensitive, word-bounded)", async () => {
    for (const title of ["CI failed on master", "master ci 红", "[CI] flaky test", "修复CI失败"]) {
      const { self, handleOpened } = makeSelf({ body: "ci" });
      await call(self, ciIssue(title));
      expect(handleOpened).not.toHaveBeenCalled();
    }
  });

  test("titles with ci inside words still dispatch", async () => {
    for (const title of ["special circuit fix", "social login"]) {
      const { self, handleOpened } = makeSelf({ body: "normal" });
      await call(self, ciIssue(title));
      expect(handleOpened).toHaveBeenCalledTimes(1);
    }
  });
});
