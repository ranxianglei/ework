import { describe, expect, test, vi } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Incorporated-issue auto-stop + 8问 contract (owner policy 2026-11-12):
// issues absorbed into a [根因] aggregation (or classified tinyfix) run no
// bot work of their own; the classifier board writes the suppression set.
describe("incorporated-issue auto-stop (owner policy 2026-11-12)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSuppressionDir() {
    const dir = mkdtempSync(join(tmpdir(), "supp-"));
    return dir;
  }

  function baseSelf(suppressionFile?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.cfg = {
      work: suppressionFile ? { suppressionFile } : {},
      opencode: { baseWorkdir: "/nonexistent-base-workdir" },
    };
    return self;
  }

  test("suppressionReason reads the board-written set and caches by mtime", () => {
    const dir = makeSuppressionDir();
    const file = join(dir, "suppressed.json");
    const self = baseSelf(file);
    expect(Engine.prototype.suppressionReason.call(self, "42")).toBeNull();
    writeFileSync(file, JSON.stringify({ issues: { "42": "incorporated:kc", 43: true } }));
    expect(Engine.prototype.suppressionReason.call(self, "42")).toBe("incorporated:kc");
    expect(Engine.prototype.suppressionReason.call(self, "43")).toBe("incorporated");
    expect(Engine.prototype.suppressionReason.call(self, "44")).toBeNull();
    // mtime-unchanged second call hits the cache (no re-read needed to pass)
    expect(Engine.prototype.suppressionReason.call(self, "42")).toBe("incorporated:kc");
  });

  test("suppressionReason: invalid or unreadable file = not suppressed", () => {
    const dir = makeSuppressionDir();
    const file = join(dir, "bad.json");
    const self = baseSelf(file);
    writeFileSync(file, "{not json");
    expect(Engine.prototype.suppressionReason.call(self, "1")).toBeNull();
    // no file at all
    const self2 = baseSelf(join(dir, "missing.json"));
    expect(Engine.prototype.suppressionReason.call(self2, "1")).toBeNull();
  });

  test("stopIssueWork kills running sessions, supersedes queued messages, keeps done, stays silent", async () => {
    const self = baseSelf();
    const updateSession = vi.fn(async (_id?: unknown, _p?: unknown) => {});
    const updateMessageStatus = vi.fn(async (_id?: unknown, _s?: unknown, _e?: unknown) => {});
    const killSessionProcess = vi.fn(async () => true);
    const clearRuntimeState = vi.fn();
    const running = { id: "s-run", state: "running", name: "ework-daemon" };
    const parked = { id: "s-park", state: "idle", name: "ework-daemon" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    self.store = {
      findIssuesByTrackerIssueId: vi.fn(async () => [{ id: 7, trackerType: "gitea", trackerScope: "acme/widgets" }]),
      getSessionsForIssue: vi.fn(async () => [running, parked]),
      getMessagesForSession: vi.fn(async (sid: string) =>
        sid === "s-run"
          ? [
              { id: "m1", status: "pending" },
              { id: "m2", status: "running" },
              { id: "m3", status: "interrupted" },
              { id: "m4", status: "done" },
            ]
          : [],
      ),
      updateSession,
      updateMessageStatus,
    };
    self.killSessionProcess = killSessionProcess;
    self.clearRuntimeState = clearRuntimeState;
    self.sessionKey = () => "k1";
    const report = await Engine.prototype.stopIssueWork.call(self, ["42", "42"]);
    expect(report).toEqual({ issues: 1, killed: 1, superseded: 3 });
    expect(killSessionProcess).toHaveBeenCalledTimes(1);
    const supersededCalls = updateMessageStatus.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    expect(supersededCalls).toEqual([
      ["m1", "superseded"],
      ["m2", "superseded"],
      ["m3", "superseded"],
    ]);
    // the done message must be untouched
    expect(updateMessageStatus.mock.calls.every((c) => c[0] !== "m4")).toBe(true);
    // both sessions end idle; dedupe: two identical ids hit the store once
    expect(self.store.findIssuesByTrackerIssueId).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  test("classifier prompt carries the reserved tinyfix category", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracker: any = {
      createComment: vi.fn(async () => ({ id: "c1" })),
      getTrackerInstructions: () => ({ issueRef: "acme/widgets#900" }),
    };
    const self = baseSelf();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    self.cfg = {
      bot: { username: "ework-daemon" },
      daemon: { wakeLogins: ["ranxianglei"], noWakeLogins: [], nonWakingAuthors: [] },
      work: { autoLaneWindowMs: 86_400_000, classifierMaxAttempts: 3 },
      opencode: { baseWorkdir: "/nonexistent-base-workdir" },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    self.store = {
      findIssue: vi.fn(async () => null),
      findOrCreateIssue: vi.fn(async () => ({ id: 7, state: "active" })),
      countAutoLaneMessages: vi.fn(async () => 0),
    };
    self.ensureOwned = vi.fn(async () => true);
    self.workerSession = vi.fn(async (_i: unknown, base: string) => ({ id: "w1", name: base }));
    self.sessionRef = () => "ses_link";
    self.resolveWorkdir = async () => "/w";
    self.handleLargeContent = (_wd: string, c: string) => c;
    const enqueueOrRun = vi.fn();
    self.enqueueOrRun = enqueueOrRun;
    await Engine.prototype.handleClassifierTick.call(
      self,
      { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "900" },
      "acme/widgets",
      { title: "anchor", body: "", state: "open", author: "ranxianglei" },
      tracker,
      { batch: [11, 12], firstRound: true },
    );
    const prompt = String((enqueueOrRun.mock.calls[0] as unknown[])[2]);
    expect(prompt).toContain("RESERVED CATEGORY");
    expect(prompt).toContain('"tinyfix"');
  });

  test("8问 contract applies to [根因] threads only", () => {
    const self = baseSelf();
    const rc = Engine.prototype.rcEightQuestionRule.call(self, "[根因] 压缩链路三连断（6090/6091/6092）");
    expect(rc).toContain("8-question checklist");
    expect(rc).toContain("待验证");
    expect(Engine.prototype.rcEightQuestionRule.call(self, "[Root Cause] some other")).toContain("8-question checklist");
    expect(Engine.prototype.rcEightQuestionRule.call(self, "普通 issue 标题")).toBe("");
    expect(Engine.prototype.rcEightQuestionRule.call(self, undefined)).toBe("");
  });

  test("initial prompt carries the 8问 contract for [Root Cause] tickets (issue_opened path)", () => {
    // RC aggregations are dispatched by issue_opened — the worker's first run
    // only ever saw the forward/nudge rules, which is why 2026-11-13 RC threads
    // answered with a bare 结论 and no 8-question verdict (owner: 「我发现root的8问没有了」).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.cfg = { daemon: { wakeLogins: [], noWakeLogins: [], nonWakingAuthors: [] } };
    const args = ["body", "ranxianglei", "/w", { clone: "git clone x .", issueRef: "o/r#6453" }] as const;
    const rcPrompt = Engine.prototype.buildInitialPrompt.call(
      self, "bot", "[Root Cause] compression cache eviction (6 items)", ...args,
    ) as string;
    expect(rcPrompt).toContain("8-question checklist");
    expect(rcPrompt).toContain("待验证");
    const zhPrompt = Engine.prototype.buildInitialPrompt.call(
      self, "bot", "[根因] 压缩链路三连断（6090/6091/6092）", ...args,
    ) as string;
    expect(zhPrompt).toContain("8-question checklist");
    const plainPrompt = Engine.prototype.buildInitialPrompt.call(
      self, "bot", "普通 issue 标题", ...args,
    ) as string;
    expect(plainPrompt).not.toContain("8-question checklist");
  });
});
