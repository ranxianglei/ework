import { describe, expect, test, vi } from "bun:test";
import { Engine } from "../src/opencode";

const ref = { trackerType: "gitea", issueId: "42" } as any;
const issueData = { title: "[PR] fix widgets", body: "", state: "open", author: "ranxianglei" };

function makeSelf(opts: { untracked?: boolean; closed?: boolean; activeGuards?: number } = {}) {
  const enqueueOrRun = vi.fn();
  const worker = { id: "w1", name: "merge-guard" };
  const createSession = vi.fn(async () => worker);
  const self = Object.create(Engine.prototype) as Record<string, unknown>;
  self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] }, work: {} };
  self.store = {
    findIssue: vi.fn(async () => (opts.untracked ? null : { id: 7, state: opts.closed ? "closed" : "active" })),
    findOrCreateIssue: vi.fn(async () => ({ id: 8, state: "active" })),
    getSessionsForIssue: vi.fn(async () => []),
    countActiveMergeGuardMessages: vi.fn(async () => opts.activeGuards ?? 0),
    createSession,
  };
  self.ensureOwned = vi.fn(async () => true);
  self.sessionRef = () => "ses_link";
  self.resolveWorkdir = async () => "/w";
  self.handleLargeContent = (_w: string, c: string) => c;
  self.enqueueOrRun = enqueueOrRun;
  return { self, enqueueOrRun, createSession, worker };
}

const call = (self: Record<string, unknown>, tracker: unknown, mergeState: string, reason: string) =>
  (Engine.prototype as any).handlePrUnmergeable.call(self, ref, "acme/widgets", issueData, tracker, mergeState, reason);

describe("merge guard: truth-driven wake (owner directive 2026-10-26)", () => {
  test("conflict wake dispatches a rebase instruction to the sticky merge-guard session", async () => {
    const { self, enqueueOrRun, createSession, worker } = makeSelf();
    const tracker = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "acme/widgets#42" }) };
    await call(self, tracker, "dirty", "conflict");
    expect(createSession).toHaveBeenCalledWith(7, "merge-guard-r1");
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const [s, i, prompt, , , sourceCommentId] = enqueueOrRun.mock.calls[0] as unknown as [unknown, { id: number }, string, unknown, unknown, string];
    expect(s).toBe(worker);
    expect(i.id).toBe(7);
    expect(prompt).toContain("Merge guard: PR is dirty");
    expect(prompt).toContain("resolve every conflict");
    expect(String(sourceCommentId)).toMatch(/^merge-guard-42-\d+$/);
  });

  test("behind wake dispatches an update-branch sync, not a conflict resolution", async () => {
    const { self, enqueueOrRun } = makeSelf();
    const tracker = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, tracker, "behind", "behind");
    const prompt = (enqueueOrRun.mock.calls[0]?.[2] ?? "") as string;
    expect(prompt).toContain("update-branch");
    expect(prompt).not.toContain("resolve every conflict");
  });

  test("untracked PR gets a row created instead of a silent drop; closed PRs never wake", async () => {
    const untracked = makeSelf({ untracked: true });
    const t1 = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(untracked.self, t1, "dirty", "conflict");
    expect(untracked.createSession).toHaveBeenCalledWith(8, "merge-guard-r1");
    expect(untracked.enqueueOrRun).toHaveBeenCalledTimes(1);

    const closed = makeSelf({ closed: true });
    const t2 = { createComment: vi.fn(), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(closed.self, t2, "dirty", "conflict");
    expect(closed.enqueueOrRun).not.toHaveBeenCalled();
  });

  test("duplicate wake while a guard worker is active is skipped (idempotency, 2026-10-26)", async () => {
    const { self, enqueueOrRun } = makeSelf({ activeGuards: 1 });
    const t = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await (Engine.prototype as any as { handlePrUnmergeable: (this: unknown, ...a: unknown[]) => Promise<void> }).handlePrUnmergeable.call(
      self,
      { issueId: 4799, scope: "ranxianglei/billion-context" },
      "ranxianglei/billion-context",
      { title: "[PR] #4799", state: "open" },
      t,
      "dirty",
      "conflict",
      undefined,
    );
    expect(enqueueOrRun).not.toHaveBeenCalled();
  });

  test("kill-switch: cap 0 drops wakes at ingestion — no row, no session, no dispatch (owner hold 2026-10-31)", async () => {
    const { self, enqueueOrRun, createSession } = makeSelf();
    (self as Record<string, unknown>).cfg = {
      bot: { username: "ework-daemon" },
      daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] },
      work: { mergeGuardMaxAttempts: 0 },
    };
    const t = { createComment: vi.fn(async () => ({ id: "c1" })), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, t, "dirty", "conflict");
    expect(createSession).not.toHaveBeenCalled();
    expect(enqueueOrRun).not.toHaveBeenCalled();
  });
});