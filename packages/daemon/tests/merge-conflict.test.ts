import { describe, expect, test, vi } from "bun:test";
import { GiteaTracker } from "../src/trackers/gitea-tracker";
import type { GiteaClient } from "../src/gitea";
import type { TrackerRef, TrackerEvent } from "../src/trackers/types";

const rawMergeConflictWebhook = JSON.stringify({
  action: "merge_conflict",
  merge_state: "dirty",
  issue: {
    number: 42,
    title: "[PR] fix widgets",
    body: "pr body",
    state: "open",
    user: { login: "ranxianglei" },
  },
  repository: { full_name: "acme/widgets", owner: { login: "acme" }, name: "widgets" },
});

describe("gitea tracker parses merge_conflict webhooks", () => {
  test("maps action merge_conflict to a merge_conflict event carrying the state", () => {
    const client = {} as unknown as GiteaClient;
    const tracker = new GiteaTracker(client as never, "http://gitea", "secret", "bot");
    const event = tracker.parseWebhookEvent(rawMergeConflictWebhook);
    expect(event?.type).toBe("merge_conflict");
    expect(event?.merge?.state).toBe("dirty");
    expect(event?.issue.title).toBe("[PR] fix widgets");
  });
});

describe("handleMergeConflict gating", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const ref: TrackerRef = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };
  const issueData: TrackerEvent["issue"] = {
    title: "[PR] fix widgets",
    body: "",
    state: "open",
    author: "ranxianglei",
  };

  function makeSelf(opts: { sessions: unknown[]; issueState?: string }) {
    const enqueueOrRun = vi.fn();
    const createComment = vi.fn(async () => ({ id: "c1" }));
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] } };
    self.store = {
      findIssue: vi.fn(async () => ({ id: 7, state: opts.issueState ?? "active" })),
      getSessionByName: vi.fn(async () => opts.sessions[0] ?? null),
      getSessionsForIssue: vi.fn(async () => opts.sessions),
    };
    self.ensureOwned = vi.fn(async () => true);
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_w: string, c: string) => c;
    self.enqueueOrRun = enqueueOrRun;
    return { self, enqueueOrRun, createComment };
  }

  const call = (self: Record<string, unknown>, tracker: unknown) =>
    Engine.prototype.handleMergeConflict.call(self, ref, "acme/widgets", issueData, tracker, "dirty");

  test("forwards a rebase instruction to the owning session", async () => {
    const session = { id: "s1", name: "ework-daemon" };
    const { self, enqueueOrRun } = makeSelf({ sessions: [session] });
    const tracker = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "acme/widgets#42" }) };
    await call(self, tracker);
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const [s, i, prompt, , , sourceCommentId] = enqueueOrRun.mock.calls[0] as unknown as [unknown, { id: number }, string, unknown, unknown, string];
    expect(s).toBe(session);
    expect(i.id).toBe(7);
    expect(prompt).toContain("Rebase");
    expect(prompt).toContain("[PR] fix widgets");
    expect(String(sourceCommentId)).toMatch(/^merge-conflict-42-\d+$/);
  });

  test("skips PRs no agent ever worked on (no session row)", async () => {
    const { self, enqueueOrRun } = makeSelf({ sessions: [] });
    const tracker = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(tracker.createComment).not.toHaveBeenCalled();
  });

  test("skips when the mirror issue is closed in DB", async () => {
    const { self, enqueueOrRun } = makeSelf({ sessions: [{ id: "s1", name: "ework-daemon" }], issueState: "closed" });
    const tracker = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
  });
});
