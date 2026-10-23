import { describe, expect, it, vi } from "bun:test";
import type { TrackerRef } from "../src/trackers/types";

const ref: TrackerRef = { trackerType: "gitea", scope: { owner: "acme", repo: "widgets" }, issueId: "7" };
const issue = { id: "iss-1", state: "active", trackerType: "gitea", trackerScopeKey: "acme/widgets", trackerIssueId: 7 };
const session = { id: "ses-1", uid: "ses-1", issueId: "iss-1", name: "ework-daemon", state: "idle" };
const msg = { id: "msg-1", uid: "msg-1", sessionId: "ses-1", status: "pending" };

describe("owner boost (web ⚡ button)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(runningCount: number) {
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.maxConcurrent = 8;
    self.running = new Map();
    self.lastOutputAt = new Map();
    self.apiIdleGraceMs = 180_000;
    self.startedAt = new Map();
    for (let i = 0; i < runningCount; i++) self.running.set(`k-${i}`, { pid: 1 });
    self.store = {
      findIssue: vi.fn(async () => issue),
      getPendingForIssue: vi.fn(async () => [msg]),
      getSession: vi.fn(async () => session),
      getIssue: vi.fn(async () => issue),
      claimMessage: vi.fn(async () => true),
    };
    self.dequeueOrIdle = vi.fn(async () => {});
    self.boostedIssueIds = new Set();
    return self;
  }

  it("free slot → dispatches immediately, no queue pin", async () => {
    const self = makeSelf(0);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).toHaveBeenCalledTimes(1);
    expect(self.dequeueOrIdle).toHaveBeenCalledTimes(1);
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
  });

  it("API-saturated but below 2× process ceiling → still dispatches (owner policy 2026-10-23)", async () => {
    const self = makeSelf(8);
    const now = Date.now();
    for (let i = 0; i < 8; i++) self.lastOutputAt.set(`k-${i}`, now);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).toHaveBeenCalledTimes(1);
    expect(self.dequeueOrIdle).toHaveBeenCalledTimes(1);
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
  });

  it("process ceiling (2× cap) full → pins issue to front of queue, no claim", async () => {
    const self = makeSelf(16);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
    expect(self.dequeueOrIdle).not.toHaveBeenCalled();
    expect((self.boostedIssueIds as Set<string>).has("iss-1")).toBe(true);
  });

  it("no pending messages → no-op", async () => {
    const self = makeSelf(0);
    self.store.getPendingForIssue = vi.fn(async () => []);
    await Engine.prototype.handleBoost.call(self, ref, "acme/widgets", { title: "t", body: "", state: "open", author: "dog" }, null);
    expect(self.store.claimMessage).not.toHaveBeenCalled();
    expect((self.boostedIssueIds as Set<string>).size).toBe(0);
  });
});
