import { describe, test, expect } from "bun:test";
import { Engine } from "../src/opencode";

const makeSelf = (k: string) => {
  const self: Record<string, unknown> = Object.create(Engine.prototype);
  const calls: string[] = [];
  self.stopping = new Map([[k, 1]]);
  self.generation = new Map([[k, 1]]);
  self.running = new Set([k]);
  self.currentMessage = new Map([[k, "m1"]]);
  self.currentModel = new Map([[k, "qwen"]]);
  self.startedAt = new Map();
  self.store = {
    updateMessageStatus: async (id: string, st: string) => { calls.push(`msg:${id}:${st}`); },
    updateSession: async (id: string, patch: Record<string, unknown>) => { calls.push(`sess:${id}:${JSON.stringify(patch)}`); },
  };
  self.drainGlobalPending = async () => { calls.push("drain"); };
  return { self, calls };
};

const sess = { id: "s1", name: "ework-daemon" } as never;
const issue = { id: "i1", trackerType: "gitea", trackerScopeKey: "x/y", trackerIssueId: 1 } as never;

describe("zombie factory: generation aliasing (owner 2026-10-22)", () => {
  test("aliased stopping flag on exit-0: slot released, done NOT downgraded", async () => {
    const k = "gitea:x/y#1@ework-daemon";
    const { self, calls } = makeSelf(k);
    await (self as { finishRun(k: string, s: unknown, i: unknown, code: number | null, gen: number): Promise<void> })
      .finishRun(k, sess, issue, 0, 1);
    expect(calls.some((c) => c.startsWith("msg:") && c.endsWith(":interrupted"))).toBe(false);
    expect((self.running as Set<string>).has(k)).toBe(false);
    expect(calls).toContain("drain");
    expect(calls.some((c) => c.startsWith("sess:s1:") && c.includes("idle"))).toBe(true);
    expect((self.stopping as Map<string, number>).has(k)).toBe(false);
  });

  test("non-zero exit with stale stopping: row parked interrupted", async () => {
    const k = "gitea:x/y#2@ework-daemon";
    const { self, calls } = makeSelf(k);
    await (self as { finishRun(k: string, s: unknown, i: unknown, code: number | null, gen: number): Promise<void> })
      .finishRun(k, sess, issue, 1, 1);
    expect(calls.some((c) => c === "msg:m1:interrupted")).toBe(true);
    expect((self.running as Set<string>).has(k)).toBe(false);
  });

  test("superseded key: successor's runtime state untouched", async () => {
    const k = "gitea:x/y#3@ework-daemon";
    const { self, calls } = makeSelf(k);
    (self.generation as Map<string, number>).set(k, 2);
    await (self as { finishRun(k: string, s: unknown, i: unknown, code: number | null, gen: number): Promise<void> })
      .finishRun(k, sess, issue, 1, 1);
    expect((self.running as Set<string>).has(k)).toBe(true);
    expect(calls).not.toContain("drain");
    expect(calls.some((c) => c.startsWith("sess:"))).toBe(false);
  });

  test("forceStop bumps generation instead of deleting (no re-mint aliasing)", async () => {
    const k = "gitea:x/y#4@ework-daemon";
    const self: Record<string, unknown> = Object.create(Engine.prototype);
    self.stopping = new Map();
    self.generation = new Map([[k, 3]]);
    self.processes = new Map();
    self.running = new Set([k]);
    self.currentMessage = new Map(); self.currentModel = new Map();
    self.lastOutputAt = new Map(); self.startedAt = new Map();
    self.progressCommentId = new Map(); self.currentPrompt = new Map();
    self.processExitNudgeRounds = new Map(); self.stuckNudgeRounds = new Map();
    self.store = { getMessagesForSession: async () => [], updateSession: async () => {}, findIssue: async () => undefined };
    await (self as { forceStop(k: string): Promise<boolean> }).forceStop(k);
    expect((self.generation as Map<string, number>).get(k)).toBe(4);
  });
});
