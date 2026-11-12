import { describe, expect, it, vi } from "bun:test";

// Warm-session fast path (owner policy 2026-11-12): once a session picks up
// work it is not sent back to the cold FIFO — pending messages whose session
// kept traffic within the warm window (default 10 min) jump the global drain
// so the model context (prompt cache / KV) stays hot. A session silent longer
// than the window counts as cold and queues normally. Incident: reply → queue
// → 1h wait → cold → full prefill → reply → … loop held fleet cache hits at
// 64% (2026-11-12).

const issue = { id: "iss-1", state: "active", trackerType: "gitea", trackerScopeKey: "acme/widgets", trackerIssueId: 7 };
const warmMsg = { id: "warm-1", uid: "warm-1", sessionId: "ses-1", status: "pending", sourceCommentId: undefined };

describe("warm-session fast path in drainGlobalPending (owner policy 2026-11-12)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(opts: { warmMs: number; saturated?: boolean }) {
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.destroyed = false;
    self.maxConcurrent = 2;
    self.running = new Map();
    self.lastOutputAt = new Map();
    self.startedAt = new Map();
    self.apiIdleGraceMs = 180_000;
    if (opts.saturated) {
      // Both API slots hot (recent output) → slotAvailable() false.
      const now = Date.now();
      for (let i = 0; i < 2; i++) {
        self.running.set(`other-k-${i}`, { pid: i + 1 });
        self.lastOutputAt.set(`other-k-${i}`, now);
      }
    }
    self.refreshPendingInfraCount = vi.fn(async () => {});
    self.boostedIssueIds = new Set();
    self.pinnedIssueIds = new Set();
    self.slotAvailable = vi.fn(function (this: any) {
      const cap = this.maxConcurrent;
      if (this.running.size >= cap * 2) return false;
      let active = 0;
      const now = Date.now();
      for (const k of this.running.keys()) {
        const last = this.lastOutputAt.get(k) ?? this.startedAt.get(k) ?? now;
        if (now - last <= this.apiIdleGraceMs) active++;
      }
      return active < cap;
    });
    self.getTracker = vi.fn(() => ({ updateStatus: vi.fn(async () => {}) }));
    self.isSentinelSource = vi.fn(() => false);
    self.isMergeGuardSource = vi.fn(() => false);
    self.isReviewSource = vi.fn(() => false);
    self.sessionKey = vi.fn(() => "gitea:acme/widgets#7@ework-daemon");
    self.projectKeyFor = vi.fn(() => "acme/widgets");
    self.projectConcurrencyCache = new Map();
    self.projectRunningCount = vi.fn(() => 0);
    self.dequeueOrIdle = vi.fn(async () => {});
    self.cfg = { work: { warmSessionMs: opts.warmMs } };
    self.store = {
      getWarmPendingMessages: vi.fn(async (_cutoff: string, _limit: number) =>
        opts.saturated ? [] : [warmMsg],
      ),
      getSession: vi.fn(async () => ({ id: "ses-1", uid: "ses-1", issueId: "iss-1", name: "ework-daemon", state: "idle" })),
      getIssue: vi.fn(async () => issue),
      claimMessage: vi.fn(async () => true),
      getGlobalPendingMessages: vi.fn(async () => []),
    };
    return self;
  }

  it("dispatches warm pending ahead of the FIFO when a slot is free", async () => {
    const self = makeSelf({ warmMs: 600_000 });
    await Engine.prototype.drainGlobalPending.call(self);
    expect(self.store.getWarmPendingMessages).toHaveBeenCalledTimes(1);
    // Cutoff = now - warmSessionMs (10 min window).
    const cutoff = new Date(self.store.getWarmPendingMessages.mock.calls[0]![0]).getTime();
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(590_000);
    expect(Date.now() - cutoff).toBeLessThanOrEqual(610_000);
    expect(self.store.claimMessage).toHaveBeenCalledWith("warm-1");
    expect(self.dequeueOrIdle).toHaveBeenCalledTimes(1);
  });

  it("is disabled by warmSessionMs = 0 (pure FIFO)", async () => {
    const self = makeSelf({ warmMs: 0 });
    await Engine.prototype.drainGlobalPending.call(self);
    expect(self.store.getWarmPendingMessages).not.toHaveBeenCalled();
    expect(self.store.claimMessage).not.toHaveBeenCalled();
  });

  it("stays pending when slots are saturated (warm cannot steal a running slot)", async () => {
    const self = makeSelf({ warmMs: 600_000, saturated: true });
    await Engine.prototype.drainGlobalPending.call(self);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
    expect(self.dequeueOrIdle).not.toHaveBeenCalled();
  });

  it("skips lane messages (sentinel/guard/review keep their own dispatch paths)", async () => {
    const self = makeSelf({ warmMs: 600_000 });
    self.isMergeGuardSource = vi.fn((src: string | undefined) => src === "merge-guard-9-1");
    self.store.getWarmPendingMessages = vi.fn(async () => [
      { ...warmMsg, id: "guard-1", sourceCommentId: "merge-guard-9-1" },
    ]);
    await Engine.prototype.drainGlobalPending.call(self);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch a warm message for a session already running its key", async () => {
    const self = makeSelf({ warmMs: 600_000 });
    self.sessionKey = vi.fn(() => "gitea:acme/widgets#7@ework-daemon");
    self.running.set("gitea:acme/widgets#7@ework-daemon", { pid: 42 });
    self.lastOutputAt.set("gitea:acme/widgets#7@ework-daemon", Date.now());
    await Engine.prototype.drainGlobalPending.call(self);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
  });
});
