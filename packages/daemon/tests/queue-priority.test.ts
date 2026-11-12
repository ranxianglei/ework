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

describe("dispatch_priority boost lane (e-work#63)", () => {
  it("boosted issue beats older normal work (branch 1: no project priorities)", async () => {
    const older = await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const newer = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T11:00:00.000Z");
    const store = new Store();
    const issues2 = await store.findIssuesByTrackerIssueId("2");
    expect(issues2).toHaveLength(1);
    await store.setIssueDispatchPriority(issues2[0]!.id, 1);
    const picked = await store.getGlobalPendingMessages(2);
    expect(picked.map((m) => m.id)).toEqual([newer, older]);
    await store.close();
  });

  it("boosted issue beats older normal AND higher project-priority work (branch 2)", async () => {
    const olderNormal = await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const highPriority = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T10:30:00.000Z");
    const boosted = await seedPending("ranxianglei/opencode-acp", "3", "2026-09-29T11:00:00.000Z");
    const store = new Store([{ scope: "ranxianglei/billion-context", priority: 100 }]);
    const issues3 = await store.findIssuesByTrackerIssueId("3");
    await store.setIssueDispatchPriority(issues3[0]!.id, 1);
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([boosted, olderNormal, highPriority]);
    await store.close();
  });

  it("same dispatch_priority bucket keeps strict FIFO (owner 2026-10-30 anti-starvation)", async () => {
    const a = await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const b = await seedPending("ranxianglei/billion-context", "2", "2026-09-29T11:00:00.000Z");
    const c = await seedPending("ranxianglei/opencode-acp", "3", "2026-09-29T12:00:00.000Z");
    const store = new Store();
    for (const num of ["1", "2", "3"]) {
      const issues = await store.findIssuesByTrackerIssueId(num);
      await store.setIssueDispatchPriority(issues[0]!.id, 5);
    }
    const picked = await store.getGlobalPendingMessages(3);
    expect(picked.map((m) => m.id)).toEqual([a, b, c]);
    await store.close();
  });

  it("boosting '645' does not misfire on '6453' (exact match, not prefix)", async () => {
    await seedPending("ranxianglei/other", "645", "2026-09-29T10:00:00.000Z");
    await seedPending("ranxianglei/other", "6453", "2026-09-29T11:00:00.000Z");
    const store = new Store();
    const found645 = await store.findIssuesByTrackerIssueId("645");
    expect(found645).toHaveLength(1);
    await store.setIssueDispatchPriority(found645[0]!.id, 1);
    // Re-fetch: the in-memory object is stale after the UPDATE.
    const after645 = await store.findIssuesByTrackerIssueId("645");
    const found6453 = await store.findIssuesByTrackerIssueId("6453");
    expect(found6453).toHaveLength(1);
    expect(found6453[0]!.dispatchPriority ?? 0).toBe(0);
    expect(after645[0]!.dispatchPriority ?? 0).toBe(1);
    await store.close();
  });

  it("boost is idempotent (re-stamping to the same value is a no-op)", async () => {
    await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const store = new Store();
    const issues = await store.findIssuesByTrackerIssueId("1");
    const id = issues[0]!.id;
    await store.setIssueDispatchPriority(id, 1);
    await store.setIssueDispatchPriority(id, 1);
    const after = await store.findIssuesByTrackerIssueId("1");
    expect(after[0]!.dispatchPriority).toBe(1);
    await store.close();
  });

  it("boosting an empty list is a no-op (no issues touched)", async () => {
    await seedPending("ranxianglei/other", "1", "2026-09-29T10:00:00.000Z");
    const store = new Store();
    // Mirror of Engine.boostIssuePriority([]): dedupe → empty → loop body never runs.
    const ids: string[] = [];
    let issues = 0, boosted = 0;
    for (const id of [...new Set(ids)]) {
      const found = await store.findIssuesByTrackerIssueId(id);
      for (const issue of found) {
        issues++;
        if ((issue.dispatchPriority ?? 0) !== 1) {
          await store.setIssueDispatchPriority(issue.id, 1);
          boosted++;
        }
      }
    }
    expect(issues).toBe(0);
    expect(boosted).toBe(0);
    const after = await store.findIssuesByTrackerIssueId("1");
    expect(after[0]!.dispatchPriority ?? 0).toBe(0);
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
