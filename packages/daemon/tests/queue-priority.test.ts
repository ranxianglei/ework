import { beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { Store } from "../src/op";
import { getDB, initDB } from "../src/db";
import { parseProjectPriorities } from "../src/config";
import type { TrackerRef } from "../src/trackers/types";

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
});

function ref(issueId: string, scopeKey: string): TrackerRef {
  const [owner, repo] = scopeKey.split("/");
  return { trackerType: "gitea", scope: { owner: owner!, repo: repo! }, issueId };
}

async function seedPending(scopeKey: string, issueNum: string, createdAt: string) {
  const store = new Store();
  const issue = await store.findOrCreateIssue(ref(issueNum, scopeKey), scopeKey, "t");
  const session = await store.createSession(issue.id, "ework");
  const msg = await store.createMessage(session.id, `msg ${scopeKey}#${issueNum}`);
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", [createdAt, msg.id]);
  await store.close();
  return msg.id;
}

describe("parseProjectPriorities", () => {
  it("parses owner/repo=number entries and skips blanks", () => {
    expect(parseProjectPriorities(" ranxianglei/billion-context=100 , x/y=10 ,, ")).toEqual([
      { scope: "ranxianglei/billion-context", priority: 100 },
      { scope: "x/y", priority: 10 },
    ]);
  });

  it("empty/undefined keeps pure FIFO (no entries)", () => {
    expect(parseProjectPriorities(undefined)).toEqual([]);
    expect(parseProjectPriorities("  ")).toEqual([]);
  });

  it("rejects malformed entries instead of silently dropping them", () => {
    expect(() => parseProjectPriorities("no-slash=10")).toThrow();
    expect(() => parseProjectPriorities("a/b=notanumber")).toThrow();
    expect(() => parseProjectPriorities("a/b=")).toThrow();
    expect(() => parseProjectPriorities("=10")).toThrow();
    expect(() => parseProjectPriorities("a/b=1.5")).toThrow();
    expect(() => parseProjectPriorities("a/b=1001")).toThrow();
    expect(() => parseProjectPriorities("a/b=-1")).toThrow();
  });
});

describe("getGlobalPendingMessages ordering", () => {
  it("FIFO unchanged when no priorities configured", async () => {
    const older = await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const newer = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T11:00:00.000Z");
    const store = new Store();
    const picked = await store.getGlobalPendingMessages(2);
    expect(picked.map((m) => m.id)).toEqual([older, newer]);
    await store.close();
  });

  it("prioritized project jumps ahead of older unprioritized messages", async () => {
    await seedPending("ranxianglei/opencode-acp", "1", "2026-09-29T10:00:00.000Z");
    await seedPending("ranxianglei/other", "2", "2026-09-29T10:30:00.000Z");
    const bc = await seedPending("ranxianglei/billion-context", "3", "2026-09-29T11:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/billion-context", priority: 100 }]);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked[0]!.id).toBe(bc);
    expect(picked).toHaveLength(3);
    await store.close();
  });

  it("same priority falls back to FIFO; higher wins over lower", async () => {
    const acpOlder = await seedPending("ranxianglei/opencode-acp", "1", "2026-09-29T10:00:00.000Z");
    const bcOlder = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T10:05:00.000Z");
    const bcNewer = await seedPending("ranxianglei/billion-context", "3", "2026-09-29T10:10:00.000Z");
    const store = new Store([
      { scope: "ranxianglei/opencode-acp", priority: 10 },
      { scope: "ranxianglei/billion-context", priority: 100 },
    ]);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([bcOlder, bcNewer, acpOlder]);
    await store.close();
  });

  it("unconfigured projects all sit at priority 0, FIFO among themselves, behind configured ones", async () => {
    const otherOld = await seedPending("a/other", "1", "2026-09-29T09:00:00.000Z");
    const otherNew = await seedPending("b/other", "2", "2026-09-29T09:30:00.000Z");
    const acp = await seedPending("ranxianglei/opencode-acp", "3", "2026-09-29T10:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/opencode-acp", priority: 10 }]);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([acp, otherOld, otherNew]);
    await store.close();
  });

  it("retry_after hold is respected in priority mode", async () => {
    const held = await seedPending("ranxianglei/billion-context", "1", "2026-09-29T10:00:00.000Z");
    const acp = await seedPending("ranxianglei/opencode-acp", "2", "2026-09-29T11:00:00.000Z");
    await getDB().run("UPDATE {{messages}} SET retry_after = ? WHERE uid = ?", ["2999-01-01T00:00:00.000Z", held]);
    const store = new Store([{ scope: "ranxianglei/billion-context", priority: 100 }]);
    const picked = await store.getGlobalPendingMessages(5);
    expect(picked.map((m) => m.id)).toEqual([acp]);
    await store.close();
  });

  it("LIMIT still applies after priority ordering", async () => {
    await seedPending("ranxianglei/opencode-acp", "1", "2026-09-29T10:00:00.000Z");
    await seedPending("ranxianglei/billion-context", "2", "2026-09-29T11:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/billion-context", priority: 100 }]);
    const picked = await store.getGlobalPendingMessages(1);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.content).toContain("billion-context");
    await store.close();
  });
});
