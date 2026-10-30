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

  it("age order wins across projects; priority cannot leapfrog older work (owner 2026-10-30)", async () => {
    const acp = await seedPending("ranxianglei/opencode-acp", "1", "2026-09-29T10:00:00.000Z");
    const other = await seedPending("ranxianglei/other", "2", "2026-09-29T10:30:00.000Z");
    const bc = await seedPending("ranxianglei/billion-context", "3", "2026-09-29T11:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/billion-context", priority: 100 }]);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([acp, other, bc]);
    await store.close();
  });

  it("priority breaks exact-age ties: higher priority first (owner 2026-10-30)", async () => {
    const acp = await seedPending("ranxianglei/opencode-acp", "1", "2026-09-29T10:00:00.000Z");
    const bc = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T10:00:00.000Z");
    const store = new Store([
      { scope: "ranxianglei/opencode-acp", priority: 10 },
      { scope: "ranxianglei/billion-context", priority: 100 },
    ]);
    const picked = await store.getGlobalPendingMessages(2);
    expect(picked.map((m) => m.id)).toEqual([bc, acp]);
    await store.close();
  });

  it("unconfigured projects are not deprioritized below configured ones (age decides)", async () => {
    const otherOld = await seedPending("a/other", "1", "2026-09-29T09:00:00.000Z");
    const otherNew = await seedPending("b/other", "2", "2026-09-29T09:30:00.000Z");
    const acp = await seedPending("ranxianglei/opencode-acp", "3", "2026-09-29T10:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/opencode-acp", priority: 10 }]);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([otherOld, otherNew, acp]);
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
    expect(picked[0]!.content).toContain("opencode-acp");
    await store.close();
  });
});

it("age order spans lanes: infra sessions do not leapfrog older ordinary work (owner 2026-10-30)", async () => {
  const store = new Store([{ scope: "acme/widgets", priority: 100 }]);
  const issueA = await store.findOrCreateIssue(ref("1", "acme/widgets"), "acme/widgets", "normal");
  const issueB = await store.findOrCreateIssue(ref("2", "acme/widgets"), "acme/widgets", "ci");
  const normal = await store.createSession(issueA.id, "ework-daemon");
  const worker = await store.createSession(issueB.id, "ci-worker");
  const mOld = await store.createMessage(normal.id, "older normal msg");
  const mNew = await store.createMessage(worker.id, "newer ci msg");
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-17T01:00:00.000Z", mOld.id]);
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-17T02:00:00.000Z", mNew.id]);
  const pending = await store.getGlobalPendingMessages(5);
  expect(pending[0]!.id).toBe(mOld.id);
  expect(pending[1]!.id).toBe(mNew.id);
  await store.close();
});

it("release-worker sessions follow the same age order", async () => {
  const store = new Store([{ scope: "acme/widgets", priority: 100 }]);
  const issueA = await store.findOrCreateIssue(ref("1", "acme/widgets"), "acme/widgets", "normal");
  const issueB = await store.findOrCreateIssue(ref("2", "acme/widgets"), "acme/widgets", "rel");
  const normal = await store.createSession(issueA.id, "ework-daemon");
  const rel = await store.createSession(issueB.id, "release-worker");
  const mOld = await store.createMessage(normal.id, "older normal msg");
  const mNew = await store.createMessage(rel.id, "newer release msg");
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-17T03:00:00.000Z", mOld.id]);
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-17T04:00:00.000Z", mNew.id]);
  const pending = await store.getGlobalPendingMessages(5);
  expect(pending[0]!.id).toBe(mOld.id);
  await store.close();
});

it("stale merge-guard pending outranks a younger ci-worker head (2026-10-30 fairness inversion)", async () => {
  // Drain claims infra-bucket heads in list order; the fairness gate aborts
  // the whole pass when the claimed head is younger than the oldest
  // deliverable row. A merge-guard pending outside the infra bucket sat
  // behind younger ci-worker heads: every pass claimed a ci head, yielded to
  // the unreachable guard row, and returned — 833 yields/30min, concurrency
  // 11→1. In-bucket age ordering lets the drain reach the stale row first.
  const store = new Store([{ scope: "acme/widgets", priority: 100 }]);
  const issueA = await store.findOrCreateIssue(ref("1", "acme/widgets"), "acme/widgets", "guard");
  const issueB = await store.findOrCreateIssue(ref("2", "acme/widgets"), "acme/widgets", "ci");
  const guard = await store.createSession(issueA.id, "merge-guard-r1");
  const ci = await store.createSession(issueB.id, "ci-worker-r1");
  const mGuard = await store.createMessage(guard.id, "stale guard msg");
  const mCi = await store.createMessage(ci.id, "younger ci msg");
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-29T15:57:51.000Z", mGuard.id]);
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", ["2026-10-30T07:00:00.000Z", mCi.id]);
  const pending = await store.getGlobalPendingMessages(5);
  expect(pending[0]!.id).toBe(mGuard.id);
  expect(pending[1]!.id).toBe(mCi.id);
  await store.close();
});
