import { describe, test, expect } from "bun:test";
import { Engine } from "../src/opencode";

// Poisoned-session fuse (owner 2026-10-23, billion-context#3693): a session
// stuck-killed 3 times in a row must reset its opencode session at the next
// spawn instead of resuming the poison history forever.

const makeSelf = (k: string) => {
  const self: Record<string, unknown> = Object.create(Engine.prototype);
  const calls: string[] = [];
  self.stuckKillCount = new Map([[k, 0]]);
  self.store = {
    updateSession: async (id: string, patch: Record<string, unknown>) => {
      calls.push(`sess:${id}:${JSON.stringify(Object.keys(patch))}`);
    },
  };
  self.sessionToRef = (session: { id: string }, issue: { id: string }) => ({ session, issue }) as never;
  self.tracker = {
    createComment: async (_ref: unknown, body: string) => {
      calls.push(`comment:${body.slice(0, 80)}`);
      return { id: "c1" };
    },
  };
  return { self, calls };
};

const sess = { id: "s1", name: "ework-daemon", opencodeSessionId: "ses_poison" } as never;
const issue = { id: "i1", trackerType: "gitea", trackerScopeKey: "x/y", trackerIssueId: 1 } as never;

describe("poisoned-session fuse (owner 2026-10-23)", () => {
  test("below threshold: no reset, counter intact", async () => {
    const k = "gitea:x/y#1@ework-daemon";
    const { self, calls } = makeSelf(k);
    (self.stuckKillCount as Map<string, number>).set(k, 2);
    await (self as { maybeTripPoisonFuse(k: string, s: unknown, i: unknown, t: unknown): Promise<void> })
      .maybeTripPoisonFuse(k, sess, issue, self.tracker);
    expect(calls.length).toBe(0);
    expect((self.stuckKillCount as Map<string, number>).get(k)).toBe(2);
    expect((sess as { opencodeSessionId?: string }).opencodeSessionId).toBe("ses_poison");
  });

  test("at threshold: session reset + counter cleared + disclosure comment", async () => {
    const k = "gitea:x/y#2@ework-daemon";
    const { self, calls } = makeSelf(k);
    (self.stuckKillCount as Map<string, number>).set(k, 3);
    await (self as { maybeTripPoisonFuse(k: string, s: unknown, i: unknown, t: unknown): Promise<void> })
      .maybeTripPoisonFuse(k, sess, issue, self.tracker);
    expect(calls).toContain('sess:s1:["opencodeSessionId"]');
    expect((sess as { opencodeSessionId?: string }).opencodeSessionId).toBeUndefined();
    expect((self.stuckKillCount as Map<string, number>).has(k)).toBe(false);
    expect(calls.some((c) => c.startsWith("comment:") && c.includes("重置会话上下文"))).toBe(true);
  });

  test("healthy finishRun clears the streak", async () => {
    const k = "gitea:x/y#3@ework-daemon";
    const self: Record<string, unknown> = Object.create(Engine.prototype);
    self.stuckKillCount = new Map([[k, 2]]);
    self.nudgeRounds = new Map();
    self.emptyResponseRounds = new Map();
    self.stopping = new Map();
    self.generation = new Map([[k, 1]]);
    self.running = new Set([k]);
    self.currentMessage = new Map();
    self.currentModel = new Map([[k, "qwen"]]);
    self.startedAt = new Map();
    self.progressCommentId = new Map();
    self.pickupCommentId = new Map();
    self.currentPrompt = new Map();
    self.stuckNudgeRounds = new Map();
    self.store = {
      getMessage: async () => undefined,
      getNextPendingMessage: async () => undefined,
      getRecentMessages: async () => [],
      updateMessageStatus: async () => {},
      updateSession: async () => {},
    };
    self.sessionRef = () => "ref";
    self.deactivateIfIdle = async () => {};
    self.persistRuntimeState = async () => {};
    self.hasRecentBotReply = async () => true;
    self.getTracker = () => ({
      listComments: async () => [],
      updateStatus: async () => {},
      setCommentModel: async () => {},
      setReaction: async () => {},
      setIssueReaction: async () => {},
    });
    self.sessionToRef = () => ({}) as never;
    self.drainGlobalPending = async () => {};
    await (self as { finishRun(k: string, s: unknown, i: unknown, code: number | null, gen: number): Promise<void> })
      .finishRun(k, sess, issue, 0, 1);
    expect((self.stuckKillCount as Map<string, number>).has(k)).toBe(false);
  });
});
