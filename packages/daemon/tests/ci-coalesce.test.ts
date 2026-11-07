import { describe, expect, test, vi } from "bun:test";

// Transparent repair (owner policy 2026-11-07): while a session for the SAME
// lane/thread is still young, a fresh red-CI / conflict event must NOT
// preempt it — it stays pending and runs as a post-exit round once the current
// work finishes. Wedged-run recovery: after the window elapses, preemption
// resumes as before; minutes=0 restores legacy preemptive behavior byte-for-byte.
describe("transparent-repair coalesce window", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(opts: { minutes?: number; startedAgeMin?: number }) {
    const enqueueOrRunSpyArgs: unknown[][] = [];
    const updateStatus = vi.fn();
    const tracker = { updateStatus };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = { id: "s1", name: "ci-engineer" };
    const issue = { id: 7, trackerScopeKey: "acme/widgets" };
    const ref = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "42" };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = Object.create(Engine.prototype);
    const work: Record<string, unknown> = { autoLaneWindowMs: 86_400_000 };
    work.ciCoalesceMinutes = opts.minutes !== undefined ? opts.minutes : 5;
    self.cfg = { bot: { username: "ework-daemon" }, daemon: { wakeLogins: [], noWakeLogins: [], nonWakingAuthors: [] }, work };
    self.store = {
      createMessage: vi.fn(async (_sid: string, _p?: string, scid?: string) => ({ id: "m9", sessionId: "s1", content: "", sourceCommentId: scid, status: "pending" })),
      findIssue: vi.fn(async () => undefined),
    };
    self.slotAvailable = () => true;
    self.sessionKey = () => "k";
    self.stuckNudgeRounds = new Map<string, number>();
    self.processExitNudgeRounds = new Map<string, number>();
    self.running = new Set<string>(["k"]);
    self.startedAt = new Map<string, number>([["k", Date.now() - (opts.startedAgeMin ?? 1) * 60_000]]);
    self.isLaneExhausted = () => false;
    self.pinnedIssueIds = new Set<number>();
    self.preemptSession = vi.fn(async () => {});
    self.executeMessage = vi.fn(async (_m: unknown) => { enqueueOrRunSpyArgs.push(["executed"]); });
    return { self, tracker, session, issue, ref, updateStatus };
  }

  async function run(self: Record<string, unknown>, tracker: unknown, session: unknown, issue: unknown, ref: unknown, scid: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Engine.prototype as any).enqueueOrRun.call(self, session, issue, "p", tracker, ref, scid);
  }

  test("fresh red-CI event during a young same-lane session: queued, NO preempt, NO new execution", async () => {
    const { self, tracker, session, issue, ref, updateStatus } = makeSelf({ minutes: 5, startedAgeMin: 1 });
    await run(self, tracker, session, issue, ref, "ci-fail-42-deadbeef");
    expect((self.preemptSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((self.executeMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(ref, "queued");
    expect(self.running.has("k")).toBe(true);
  });

  test("same rule applies to merge-conflict events", async () => {
    const { self, tracker, session, issue, ref, updateStatus } = makeSelf({ minutes: 5, startedAgeMin: 2 });
    await run(self, tracker, session, issue, ref, "merge-conflict-42-x");
    expect((self.preemptSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(ref, "queued");
  });

  test("coalesce window elapsed (wedged-run recovery): preemption resumes as before", async () => {
    const { self, tracker, session, issue, ref, updateStatus } = makeSelf({ minutes: 5, startedAgeMin: 9 });
    await run(self, tracker, session, issue, ref, "ci-fail-42-deadbeef");
    expect((self.preemptSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(updateStatus).not.toHaveBeenCalledWith(ref, "queued");
  });

  test("minutes=0: legacy preemptive behavior is restored", async () => {
    const { self, tracker, session, issue, ref } = makeSelf({ minutes: 0, startedAgeMin: 0.2 });
    await run(self, tracker, session, issue, ref, "ci-fail-42-deadbeef");
    expect((self.preemptSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  test("non-CI lanes (comments etc.) are unaffected by the window", async () => {
    const { self, tracker, session, issue, ref } = makeSelf({ minutes: 5, startedAgeMin: 0.2 });
    await run(self, tracker, session, issue, ref, "comment:42:59274");
    expect((self.preemptSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
