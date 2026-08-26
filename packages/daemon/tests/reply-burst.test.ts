import { describe, expect, test } from "bun:test";
import { replyBurstState, Engine } from "../src/opencode";
import { formatKey } from "../src/trackers/types";

// Reply-burst circuit breaker (regression: qq-lab loop, 2026-08-26 — a local
// 27B session re-perceived a standing instruction every agent turn and posted
// 30+ replies until manually halted; the daemon had no reply cap at all).

describe("replyBurstState (pure)", () => {
  test("trips only when retained count reaches max", () => {
    const now = 1_000_000;
    const r1 = replyBurstState([now - 100, now - 200], now, 4, 60_000);
    expect(r1.tripped).toBe(false);
    expect(r1.kept).toHaveLength(3);
    const r2 = replyBurstState(r1.kept, now + 1, 4, 60_000);
    expect(r2.tripped).toBe(true);
    expect(r2.kept).toHaveLength(4);
  });

  test("stamps outside the window are pruned and never trip", () => {
    const now = 10 * 60 * 1000;
    const old = Array.from({ length: 5 }, (_, i) => now - 60_000_000 - i);
    const r = replyBurstState(old, now, 5, 5 * 60 * 1000);
    expect(r.tripped).toBe(false);
    expect(r.kept).toHaveLength(1);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Engine: E } = require("../src/opencode") as { Engine: any };

describe("Engine.trackSelfReply (burst breaker)", () => {
  const mkSelf = (max: number, running: string[] = []) => {
    const comments: string[] = [];
    const killed: string[] = [];
    const sessions = running.map((name) => ({ id: `sid-${name}`, name }));
    const issue = { id: "iid", trackerType: "gitea", trackerScopeKey: "ranxianglei/qq-lab", trackerIssueId: "1" };
    const self = Object.create(E.prototype) as Record<string, unknown>;
    self.cfg = { bot: { username: "ework-daemon" } };
    self.replyBurstCfg = { max, windowMs: 5 * 60 * 1000 };
    self.replyStamps = new Map();
    self.store = {
      findIssue: async () => issue,
      getSessionsForIssue: async () => sessions,
    };
    self.sessionKey = (s: { name: string }, i: typeof issue) => formatKey(i.trackerType, i.trackerScopeKey, i.trackerIssueId, s.name);
    self.running = new Set(running.map((name) => formatKey("gitea", "ranxianglei/qq-lab", "1", name)));
    self.killSessionProcess = async (s: { name: string }) => {
      killed.push(s.name);
      return true;
    };
    self.tracker = { createComment: async (_ref: unknown, body: string) => { comments.push(body); } };
    return { self, comments, killed, replyStamps: self.replyStamps as Map<string, number[]> };
  };

  const ref = { trackerType: "gitea", scope: { owner: "ranxianglei", repo: "qq-lab" }, issueId: "1" };

  test("below max: no kill, no notice, stamps retained", async () => {
    const { self, comments, killed, replyStamps } = mkSelf(3, ["ework-daemon"]);
    for (let i = 0; i < 2; i++) {
      await E.prototype.trackSelfReply.call(self, ref, "ranxianglei/qq-lab", self.tracker);
    }
    expect(killed).toHaveLength(0);
    expect(comments).toHaveLength(0);
    expect(replyStamps.get("gitea:ranxianglei/qq-lab#1")).toHaveLength(2);
  });

  test("at max: kills running sessions, posts notice, clears stamps", async () => {
    const { self, comments, killed, replyStamps } = mkSelf(3, ["ework-daemon", "reviewer"]);
    for (let i = 0; i < 3; i++) {
      await E.prototype.trackSelfReply.call(self, ref, "ranxianglei/qq-lab", self.tracker);
    }
    expect(killed.sort()).toEqual(["ework-daemon", "reviewer"]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("Reply-burst circuit breaker");
    expect(replyStamps.has("gitea:ranxianglei/qq-lab#1")).toBe(false);
  });

  test("trips but nothing running (burst from elsewhere): no kill, no notice", async () => {
    const { self, comments, killed } = mkSelf(2, []);
    for (let i = 0; i < 2; i++) {
      await E.prototype.trackSelfReply.call(self, ref, "ranxianglei/qq-lab", self.tracker);
    }
    expect(killed).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });
});
