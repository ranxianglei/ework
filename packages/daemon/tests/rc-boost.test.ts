import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Store } from "../src/op";
import { getDB, initDB } from "../src/db";
import type { TrackerRef } from "../src/trackers/types";

// Owner policy 2026-11-12: root-cause aggregation issues run AHEAD of the
// normal FIFO backlog (their member work is suppressed, so waiting on the
// tail wastes hours while the whole batch idles). The classifier board
// re-stamps the live set via POST /api/admin/boost every round; the drain
// orders dispatch_priority DESC before created_at.
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

async function seedPending(scopeKey: string, issueNum: string, createdAt: string): Promise<string> {
  const store = new Store();
  const issue = await store.findOrCreateIssue(ref(issueNum, scopeKey), scopeKey, "t");
  const session = await store.createSession(issue.id, "ework");
  const msg = await store.createMessage(session.id, `msg ${scopeKey}#${issueNum}`);
  await getDB().run("UPDATE {{messages}} SET created_at = ? WHERE uid = ?", [createdAt, msg.id]);
  await store.close();
  return msg.id;
}

async function pendingOrder(store: Store): Promise<string[]> {
  return (await store.getGlobalPendingMessages(10)).map((m) => m.content);
}

describe("setIssueDispatchPriority", () => {
  it("stamps by mirror tracker id and reports rows updated", async () => {
    const store = new Store();
    await seedPending("a/b", "7", "2026-11-12T10:00:00.000Z");
    expect(await store.setIssueDispatchPriority(["7"], 1)).toBe(1);
    const row = await getDB().get<{ p: number }>(
      `SELECT dispatch_priority AS p FROM {{issues}} WHERE tracker_issue_id = '7'`
    );
    expect(row?.p).toBe(1);
    // idempotent re-stamp (the board calls this every round)
    expect(await store.setIssueDispatchPriority(["7", "7"], 1)).toBe(1);
    // unknown ids change nothing, never throw
    expect(await store.setIssueDispatchPriority(["nope"], 1)).toBe(0);
    // text ids only: '645' must not match issue '6453'
    await seedPending("a/b", "6453", "2026-11-12T10:00:00.000Z");
    expect(await store.setIssueDispatchPriority(["645"], 1)).toBe(0);
    const row6453 = await getDB().get<{ p: number }>(
      `SELECT dispatch_priority AS p FROM {{issues}} WHERE tracker_issue_id = '6453'`
    );
    expect(row6453?.p).toBe(0);
    await store.close();
  });

  it("empty list is a no-op", async () => {
    const store = new Store();
    expect(await store.setIssueDispatchPriority([], 1)).toBe(0);
    await store.close();
  });
});

describe("global drain ordering (pure FIFO branch, no project priorities)", () => {
  it("boosted issue jumps an OLDER unboosted message", async () => {
    const store = new Store();
    // old normal message first in FIFO ...
    await seedPending("a/b", "100", "2026-11-10T00:00:00.000Z");
    // ... then a newer RC message that gets stamped.
    await seedPending("a/b", "6442", "2026-11-12T23:00:00.000Z");
    expect(await pendingOrder(store)).toEqual([
      "msg a/b#100",
      "msg a/b#6442",
    ]);
    await store.setIssueDispatchPriority(["6442"], 1);
    expect(await pendingOrder(store)).toEqual([
      "msg a/b#6442",
      "msg a/b#100",
    ]);
    await store.close();
  });

  it("within the same priority bucket the FIFO order holds", async () => {
    const store = new Store();
    await seedPending("a/b", "6442", "2026-11-12T01:00:00.000Z");
    await seedPending("a/b", "6443", "2026-11-12T02:00:00.000Z");
    await store.setIssueDispatchPriority(["6442", "6443"], 1);
    expect(await pendingOrder(store)).toEqual([
      "msg a/b#6442",
      "msg a/b#6443",
    ]);
    await store.close();
  });

  it("unboosted rows keep strict FIFO after a boost elsewhere", async () => {
    const store = new Store();
    await seedPending("a/b", "1", "2026-11-12T01:00:00.000Z");
    await seedPending("a/b", "2", "2026-11-12T02:00:00.000Z");
    await seedPending("a/b", "3", "2026-11-12T03:00:00.000Z");
    await store.setIssueDispatchPriority(["2"], 1);
    expect(await pendingOrder(store)).toEqual([
      "msg a/b#2",
      "msg a/b#1",
      "msg a/b#3",
    ]);
    await store.close();
  });
});

describe("global drain ordering (WORK_PROJECT_PRIORITIES branch)", () => {
  it("issue dispatch priority outranks both age AND project priority", async () => {
    const store = new Store([
      { scope: "low/repo", priority: 100 },
    ]);
    // oldest + highest project priority ...
    await seedPending("low/repo", "9", "2026-11-01T00:00:00.000Z");
    // ... still loses to a newer stamped RC message.
    await seedPending("other/repo", "6442", "2026-11-12T23:00:00.000Z");
    await store.setIssueDispatchPriority(["6442"], 1);
    expect(await pendingOrder(store)).toEqual([
      "msg other/repo#6442",
      "msg low/repo#9",
    ]);
    await store.close();
  });
});
