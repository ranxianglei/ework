import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { hasRecentBotReply, hasRecoveryDelivery, looksLikeInProgress, checkSessionOutput } from "../src/opencode";
import type { TrackerComment } from "../src/trackers/types";

function makeComment(author: string, createdAt: string, body = "reply"): TrackerComment {
  return { id: `c-${createdAt}-${author}`, author, createdAt, body };
}

const isBot = (a: string) => a === "bot";

describe("hasRecentBotReply — causal + recency window (promptTime provided)", () => {
  // Run started 10 minutes ago; the 5-minute recency window also applies.
  const promptTime = Date.now() - 10 * 60_000;

  test("returns true for a fresh causal reply (1 min old)", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 60_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(true);
  });

  test("returns false for a causal reply older than the recency window (early-ack regression)", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 8 * 60_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(false);
  });

  test("returns false when the only bot reply was created BEFORE promptTime", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 12 * 60_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(false);
  });

  test("returns false when bot reply has no createdAt", () => {
    const comments: TrackerComment[] = [{ id: "c1", author: "bot", body: "x", createdAt: "" }];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(false);
  });

  test("ignores system comments even if fresh and causal", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 30_000).toISOString(), "[system] ack")];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(false);
  });

  test("ignores non-bot users", () => {
    const comments = [makeComment("human", new Date(Date.now() - 30_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(false);
  });

  test("returns true if ANY of multiple comments is a fresh causal reply", () => {
    const comments = [
      makeComment("bot", new Date(Date.now() - 8 * 60_000).toISOString()),
      makeComment("human", new Date(Date.now() - 2 * 60_000).toISOString()),
      makeComment("bot", new Date(Date.now() - 60_000).toISOString()),
    ];
    expect(hasRecentBotReply(comments, isBot, promptTime)).toBe(true);
  });
});

describe("hasRecentBotReply — absolute window fallback (no promptTime)", () => {
  test("returns true for a comment created 1 minute ago", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 60_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot)).toBe(true);
  });

  test("returns false for a comment created 10 minutes ago", () => {
    const comments = [makeComment("bot", new Date(Date.now() - 10 * 60_000).toISOString())];
    expect(hasRecentBotReply(comments, isBot)).toBe(false);
  });

  test("returns true for a bot comment with no createdAt (assumes recent)", () => {
    const comments: TrackerComment[] = [{ id: "c1", author: "bot", body: "x", createdAt: "" }];
    expect(hasRecentBotReply(comments, isBot)).toBe(true);
  });

  test("ignores system comments in fallback mode", () => {
    const comments = [makeComment("bot", new Date().toISOString(), "[system] done")];
    expect(hasRecentBotReply(comments, isBot)).toBe(false);
  });
});

describe("looksLikeInProgress — in-progress wording is not a delivery (ework#9)", () => {
  test("detects Chinese in-progress phrasing", () => {
    expect(looksLikeInProgress("[bot] 🏷 正在处理中，稍后汇报结果")).toBe(true);
    expect(looksLikeInProgress("[bot] 🏷 收到，我先排查一下")).toBe(true);
    expect(looksLikeInProgress("[bot] 🏷 开始执行了，请稍候")).toBe(true);
    expect(looksLikeInProgress("[bot] 🏷 继续处理中…")).toBe(true);
  });

  test("detects English in-progress phrasing (case-insensitive)", () => {
    expect(looksLikeInProgress("[bot] 🏷 Working on it, will follow up soon.")).toBe(true);
    expect(looksLikeInProgress("[bot] 🏷 [WIP] first pass done, more to come")).toBe(true);
    expect(looksLikeInProgress("[bot] 🏷 In progress — results shortly")).toBe(true);
  });

  test("does not flag finished deliverables", () => {
    expect(looksLikeInProgress("[bot] 🏷 已完成，PR 已提交：https://github.com/x/y/pull/1")).toBe(false);
    expect(looksLikeInProgress("[bot] 🏷 Done. The fix lands in commit abc123 and tests pass.")).toBe(false);
    expect(looksLikeInProgress("[bot] 🏷 分析完成：根因是连接池泄漏，详见上文。")).toBe(false);
  });

  test("empty body is not in-progress", () => {
    expect(looksLikeInProgress("")).toBe(false);
  });
});

describe("hasRecoveryDelivery — strict restart-time check (ework#9)", () => {
  const promptTime = new Date(Date.now() - 60_000); // run started 1 min ago

  test("counts only bot replies posted strictly AFTER promptTime", () => {
    const before = makeComment("bot", new Date(promptTime.getTime() - 5_000).toISOString(), "done");
    const after = makeComment("bot", new Date(promptTime.getTime() + 5_000).toISOString(), "done");
    expect(hasRecoveryDelivery([before], isBot, promptTime)).toBe(false);
    expect(hasRecoveryDelivery([after], isBot, promptTime)).toBe(true);
  });

  test("a reply exactly at promptTime does not count (causality: prompt precedes reply)", () => {
    const at = makeComment("bot", promptTime.toISOString());
    expect(hasRecoveryDelivery([at], isBot, promptTime)).toBe(false);
  });

  test("in-progress wording after promptTime is NOT a delivery", () => {
    const wip = makeComment("bot", new Date(promptTime.getTime() + 5_000).toISOString(), "进行中，稍后汇报");
    expect(hasRecoveryDelivery([wip], isBot, promptTime)).toBe(false);
  });

  test("missing or unparseable createdAt → undelivered (uncertain ⇒ requeue)", () => {
    const noDate: TrackerComment = { id: "c1", author: "bot", body: "done" };
    const badDate = makeComment("bot", "not-a-date");
    expect(hasRecoveryDelivery([noDate], isBot, promptTime)).toBe(false);
    expect(hasRecoveryDelivery([badDate], isBot, promptTime)).toBe(false);
  });

  test("ignores [system] comments and non-bot authors", () => {
    const sys = makeComment("bot", new Date(promptTime.getTime() + 5_000).toISOString(), "[system] picked up");
    const human = makeComment("human", new Date(promptTime.getTime() + 5_000).toISOString(), "done");
    expect(hasRecoveryDelivery([sys, human], isBot, promptTime)).toBe(false);
  });

  test("one real delivery among noise counts", () => {
    const wip = makeComment("bot", new Date(promptTime.getTime() + 5_000).toISOString(), "进行中");
    const done = makeComment("bot", new Date(promptTime.getTime() + 40_000).toISOString(), "已完成，PR 见 #12");
    expect(hasRecoveryDelivery([wip, done], isBot, promptTime)).toBe(true);
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

describe("checkSessionOutput", () => {
  test("returns {hasOutput: true} when sessionId is undefined", async () => {
    const result = await checkSessionOutput("/nonexistent", undefined);
    expect(result).toEqual({ hasOutput: true, tokenCount: 0 });
  });

  test("returns {hasOutput: true} when DB does not exist", async () => {
    const result = await checkSessionOutput("/nonexistent/path/db.sqlite", "ses_123");
    expect(result).toEqual({ hasOutput: true, tokenCount: 0 });
  });

  test("detects 0-token assistant messages as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ew-check-")); tmpDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.run(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
      ["m1", "ses_a", JSON.stringify({ role: "assistant", tokens: { output: 0 } })],
    );
    db.close();

    const result = await checkSessionOutput(dbPath, "ses_a");
    expect(result.hasOutput).toBe(false);
    expect(result.tokenCount).toBe(0);
  });

  test("detects positive token output as non-empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ew-check2-")); tmpDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.run(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
      ["m1", "ses_b", JSON.stringify({ role: "assistant", tokens: { output: 150 } })],
    );
    db.close();

    const result = await checkSessionOutput(dbPath, "ses_b");
    expect(result.hasOutput).toBe(true);
    expect(result.tokenCount).toBe(150);
  });

  test("returns {hasOutput: false} for session with no assistant messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ew-check3-")); tmpDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.close();

    const result = await checkSessionOutput(dbPath, "ses_empty");
    expect(result.hasOutput).toBe(false);
    expect(result.tokenCount).toBe(0);
  });

  test("only counts assistant-role messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ew-check4-")); tmpDirs.push(dir);
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.run(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
      ["m1", "ses_c", JSON.stringify({ role: "user", tokens: { output: 100 } })],
    );
    db.run(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
      ["m2", "ses_c", JSON.stringify({ role: "assistant", tokens: { output: 0 } })],
    );
    db.close();

    const result = await checkSessionOutput(dbPath, "ses_c");
    expect(result.hasOutput).toBe(false);
    expect(result.tokenCount).toBe(0);
  });
});
