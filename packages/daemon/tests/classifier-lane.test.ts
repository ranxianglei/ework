import { describe, expect, test, vi } from "bun:test";

// Issue root-cause classifier lane (owner policy 2026-11-11): a standing
// analysis lane — batches of open issues get deep root-cause categories,
// delivered as classifier-json replies on the project anchor thread. The
// aggregation flow (board script → [根因] issues → root-cause PRs) consumes
// the results out-of-band.
describe("issue root-cause classifier lane", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  const ref = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "900" };
  const issueData = { title: "classifier anchor", body: "", state: "open", author: "ranxianglei" };
  const classifier = { batch: [11, 12, 13], firstRound: true };

  function makeSelf(cap = 3) {
    const enqueueOrRun = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracker: any = {
      createComment: vi.fn(async () => ({ id: "c1" })),
      getTrackerInstructions: () => ({ issueRef: "acme/widgets#900" }),
    };
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.cfg = {
      bot: { username: "ework-daemon" },
      daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] },
      work: { autoLaneWindowMs: 86_400_000, classifierMaxAttempts: cap },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      findIssue: vi.fn(async () => null),
      findOrCreateIssue: vi.fn(async () => ({ id: 7, state: "active" })),
      countAutoLaneMessages: vi.fn(async () => 0),
    };
    self.store = store;
    self.ensureOwned = vi.fn(async () => true);
    self.workerSession = vi.fn(async (_issueId: unknown, base: string) => ({ id: "w1", name: base }));
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_wd: string, c: string) => c;
    self.enqueueOrRun = enqueueOrRun;
    return { self, enqueueOrRun, tracker, store };
  }

  // cl: the classifier payload; null stands in for a genuine undefined
  // (a JS default parameter would otherwise swallow an explicit undefined).
  const call = (
    self: Record<string, unknown>,
    tracker: unknown,
    cl: { batch: number[]; firstRound?: boolean } | null = classifier,
  ) =>
    Engine.prototype.handleClassifierTick.call(
      self,
      ref,
      "acme/widgets",
      issueData,
      tracker,
      cl === null ? undefined : cl,
    );

  test("classifier_tick dispatches to the classifier-worker session with a classifier- scid", async () => {
    const { self, enqueueOrRun, tracker, store } = makeSelf(3);
    await call(self, tracker);
    expect(self.workerSession).toHaveBeenCalledWith(7, "classifier-worker");
    expect(store.countAutoLaneMessages).toHaveBeenCalledWith(7, "classifier-900-", expect.any(String));
    expect(enqueueOrRun).toHaveBeenCalledTimes(1);
    const args = enqueueOrRun.mock.calls[0] as unknown[];
    const prompt = String(args[2]);
    const scid = String(args[5]);
    expect(scid).toMatch(/^classifier-900-\d+$/);
    expect(prompt).toContain("classifier-json");
    expect(prompt).toContain("#11, #12, #13");
    expect(prompt).toContain("FIRST ROUND");
    // analysis-only discipline must be stated in the prompt
    expect(prompt).toContain("ANALYSIS ONLY");
  });

  test("classifier cap reached within the window: dropped without dispatch or marker comment", async () => {
    const { self, enqueueOrRun, tracker, store } = makeSelf(3);
    store.countAutoLaneMessages.mockResolvedValue(3);
    await call(self, tracker);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    expect(tracker.createComment).not.toHaveBeenCalled();
  });

  test("empty batch / missing classifier / closed issue row: no dispatch", async () => {
    const { self, enqueueOrRun, store } = makeSelf(3);
    const bareTracker = { createComment: vi.fn(async () => ({})), getTrackerInstructions: () => ({ issueRef: "x" }) };
    await call(self, bareTracker, { batch: [] });
    await call(self, bareTracker, null);
    (store as Record<string, unknown>).findOrCreateIssue = vi.fn(async () => ({ id: 7, state: "closed" }));
    await call(self, bareTracker, classifier);
    expect(enqueueOrRun).not.toHaveBeenCalled();
    // the closed row returns before ensureOwned — ownership must not be touched
    expect(self.ensureOwned).not.toHaveBeenCalled();
  });
});
