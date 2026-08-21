import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { hasRecentBotReply, checkSessionOutput } from "../src/opencode";
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
