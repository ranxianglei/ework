import { describe, expect, test, vi } from "bun:test";
import { Engine } from "../src/opencode";

const ref = { trackerType: "gitea", issueId: "52" } as any;
const issueData = { title: "[PR] add frobnicator", body: "", state: "open", author: "ranxianglei" };

function makeSelf(opts: { untracked?: boolean; closed?: boolean; activeReviews?: number } = {}) {
  const enqueueOrRun = vi.fn();
  const worker = { id: "w1", name: "review-worker" };
  const createSession = vi.fn(async () => worker);
  const self = Object.create(Engine.prototype) as Record<string, unknown>;
  self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] }, work: {} };
  self.store = {
    findIssue: vi.fn(async () => (opts.untracked ? null : { id: 7, state: opts.closed ? "closed" : "active" })),
    findOrCreateIssue: vi.fn(async () => ({ id: 8, state: "active" })),
    getSessionsForIssue: vi.fn(async () => []),
    countActiveReviewMessages: vi.fn(async () => opts.activeReviews ?? 0),
    createSession,
  };
  self.ensureOwned = vi.fn(async () => true);
  self.enqueueOrRun = enqueueOrRun;
  return { self, enqueueOrRun, createSession, worker };
}

const call = (self: Record<string, unknown>, tracker: unknown, sha: string) =>
  (Engine.prototype as any).handlePrReviewPending.call(self, ref, "acme/widgets", issueData, tracker, sha);

describe("review lane: green-blocked PRs get a reviewer (owner directive 2026-10-28)", () => {
  test("review wake dispatches an end-to-end review instruction to the sticky review-worker session", async () => {
    const { self, enqueueOrRun, createSession, worker } = makeSelf();
    const tracker = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "acme/widgets#52" }) };
    await call(self, tracker, "abcd1234efgh");
    expect(createSession).toHaveBeenCalledWith(7, "review-worker-r1");
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const [s, i, prompt, , , sourceCommentId] = enqueueOrRun.mock.calls[0] as unknown as [unknown, { id: number }, string, unknown, unknown, string];
    expect(s).toBe(worker);
    expect(i.id).toBe(7);
    expect(prompt).toContain("Review lane: PR is green but blocked awaiting review");
    expect(prompt).toContain("abcd123");
    expect(prompt).toContain("APPROVE");
    expect(prompt).toContain("REQUEST_CHANGES");
    expect(prompt).toContain("kernel");
    expect(prompt).toContain("authorization-request");
    expect(prompt).toContain("do not poll gh");
    expect(String(sourceCommentId)).toMatch(/^review-52-\d+$/);
  });

  test("untracked PR gets a row created; closed PRs never wake; duplicate wake skipped", async () => {
    const untracked = makeSelf({ untracked: true });
    const t1 = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(untracked.self, t1, "s");
    expect(untracked.createSession).toHaveBeenCalledWith(8, "review-worker-r1");
    expect(untracked.enqueueOrRun).toHaveBeenCalledTimes(1);

    const closed = makeSelf({ closed: true });
    const t2 = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(closed.self, t2, "s");
    expect(closed.enqueueOrRun).not.toHaveBeenCalled();

    const dup = makeSelf({ activeReviews: 1 });
    const t3 = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(dup.self, t3, "s");
    expect(dup.enqueueOrRun).not.toHaveBeenCalled();
  });
});
