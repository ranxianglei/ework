import { beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { Store } from "../src/op";
import { getDB, initDB } from "../src/db";
import type { TrackerRef } from "../src/trackers/types";

// Multi-machine coordination tests — the Phase 1 verification gate. Each test
// simulates multiple daemons by inserting multiple rows in `daemons` and
// exercising the atomic claim / scoped-scan / lease-release primitives. The
// contract being verified: only ONE daemon wins a claim, scope filters only
// return this daemon's rows, and stale leases become reclaimable.

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues", "daemons"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  // SQLite resetting the AUTOINCREMENT isn't worth the driver branch; tests
  // don't assume specific ids, only relative comparisons (A < B, A !== B).
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");
});

const LEASE_TTL_MS = 60_000;

function ref(issueId: string, scopeKey = "dog/repo"): TrackerRef {
  return { trackerType: "gitea", scope: { owner: "dog", name: "repo" }, issueId };
}

/** Insert a daemon row directly, bypassing registerDaemon. Returns its id. */
async function insertDaemon(
  store: Store,
  opts: { age?: number; status?: string; endpoint?: string } = {},
): Promise<number> {
  const db = getDB();
  const age = opts.age ?? 0;
  const ts = new Date(Date.now() - age).toISOString();
  const res = await db.run(
    "INSERT INTO {{daemons}} (display_name, internal_endpoint, capacity, last_heartbeat, registered_at, status) VALUES (?, ?, ?, ?, ?, ?)",
    [
      `daemon-${Math.random().toString(36).slice(2, 8)}`,
      opts.endpoint ?? "127.0.0.1:3101",
      4,
      ts,
      ts,
      opts.status ?? "active",
    ],
  );
  return res.insertId;
}

describe("coordination: claimIssue", () => {
  it("first claim wins; second claim loses; owner is the winner", async () => {
    const store = new Store();
    const daemonA = await insertDaemon(store);
    const daemonB = await insertDaemon(store);
    const issue = await store.findOrCreateIssue(ref("100"), "dog/repo", "title");

    const first = await store.claimIssue(issue.id, daemonA);
    const second = await store.claimIssue(issue.id, daemonB);

    expect(first).toBe(true);
    expect(second).toBe(false);

    const refreshed = await store.getIssue(issue.id);
    expect(refreshed?.ownerDaemonId).toBe(daemonA);
  });

  it("claiming an issue you already own returns false (no-op)", async () => {
    const store = new Store();
    const daemonA = await insertDaemon(store);
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");

    expect(await store.claimIssue(issue.id, daemonA)).toBe(true);
    // Second call: owner is already us, WHERE owner IS NULL no longer matches.
    expect(await store.claimIssue(issue.id, daemonA)).toBe(false);
  });
});

describe("coordination: claimMessage", () => {
  it("first claim wins; second loses; status flips to running", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");
    const msg = await store.createMessage(session.id, "do thing");

    expect(await store.claimMessage(msg.id)).toBe(true);
    expect(await store.claimMessage(msg.id)).toBe(false);

    const refreshed = await store.getMessage(msg.id);
    expect(refreshed?.status).toBe("running");
  });
});

describe("coordination: registerDaemon", () => {
  it("ADOPTS an orphan (stale-heartbeat) slot instead of inserting a new row", async () => {
    const store = new Store();
    const staleId = await insertDaemon(store, { age: 120_000 });

    const beforeCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;

    const adopted = await store.registerDaemon("host-1", "127.0.0.1:7000", 4, LEASE_TTL_MS);

    expect(adopted).toBe(staleId);
    const afterCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("INSERTS a new row when no orphans are available", async () => {
    const store = new Store();
    const beforeCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;

    const newId = await store.registerDaemon("host-2", "127.0.0.1:7001", 4, LEASE_TTL_MS);

    expect(newId).toBeGreaterThan(0);
    const afterCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it("does NOT adopt a live daemon's slot (heartbeat within lease TTL)", async () => {
    const store = new Store();
    const liveId = await insertDaemon(store, { age: 5_000 });
    const beforeCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;

    const newId = await store.registerDaemon("host-3", "127.0.0.1:7002", 4, LEASE_TTL_MS);

    expect(newId).not.toBe(liveId);
    const afterCount = (await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}")).length;
    expect(afterCount).toBe(beforeCount + 1);
  });
});

describe("coordination: releaseDeadOwners", () => {
  it("clears owner_daemon_id on issues whose daemon missed the lease", async () => {
    const store = new Store();
    const deadDaemon = await insertDaemon(store, { age: 120_000 });
    const liveDaemon = await insertDaemon(store, { age: 5_000 });

    const deadOwned = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const liveOwned = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    await store.claimIssue(deadOwned.id, deadDaemon);
    await store.claimIssue(liveOwned.id, liveDaemon);

    const released = await store.releaseDeadOwners(LEASE_TTL_MS);
    expect(released).toBe(1);

    const refreshedDead = await store.getIssue(deadOwned.id);
    const refreshedLive = await store.getIssue(liveOwned.id);
    expect(refreshedDead?.ownerDaemonId).toBeNull();
    expect(refreshedLive?.ownerDaemonId).toBe(liveDaemon);
  });

  it("is idempotent (no-op when no stale owners)", async () => {
    const store = new Store();
    const live = await insertDaemon(store, { age: 5_000 });
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    await store.claimIssue(issue.id, live);

    expect(await store.releaseDeadOwners(LEASE_TTL_MS)).toBe(0);
    expect(await store.releaseDeadOwners(LEASE_TTL_MS)).toBe(0);
  });
});

describe("coordination: scoped scans", () => {
  it("listOwnedIssues returns only this daemon's issues", async () => {
    const store = new Store();
    const daemonA = await insertDaemon(store);
    const daemonB = await insertDaemon(store);

    const aIssue1 = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const aIssue2 = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const bIssue = await store.findOrCreateIssue(ref("3"), "dog/repo", "");

    await store.claimIssue(aIssue1.id, daemonA);
    await store.claimIssue(aIssue2.id, daemonA);
    await store.claimIssue(bIssue.id, daemonB);

    const ownedByA = await store.listOwnedIssues(daemonA);
    const ownedByB = await store.listOwnedIssues(daemonB);
    expect(ownedByA.map((i) => i.id).sort()).toEqual([aIssue1.id, aIssue2.id].sort());
    expect(ownedByB.map((i) => i.id)).toEqual([bIssue.id]);
  });

  it("listOwnedSessions returns only sessions under this daemon's issues", async () => {
    const store = new Store();
    const daemonA = await insertDaemon(store);
    const daemonB = await insertDaemon(store);

    const aIssue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const bIssue = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    await store.claimIssue(aIssue.id, daemonA);
    await store.claimIssue(bIssue.id, daemonB);

    const aSession = await store.createSession(aIssue.id, "ework");
    const aSession2 = await store.createSession(aIssue.id, "tester");
    const bSession = await store.createSession(bIssue.id, "ework");

    const ownedByA = await store.listOwnedSessions(daemonA);
    const ownedByB = await store.listOwnedSessions(daemonB);
    expect(ownedByA.map((s) => s.id).sort()).toEqual([aSession.id, aSession2.id].sort());
    expect(ownedByB.map((s) => s.id)).toEqual([bSession.id]);
  });

  it("getOwnedPendingOrRunningMessages scopes to this daemon's issues", async () => {
    const store = new Store();
    const daemonA = await insertDaemon(store);
    const daemonB = await insertDaemon(store);

    const aIssue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const bIssue = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    await store.claimIssue(aIssue.id, daemonA);
    await store.claimIssue(bIssue.id, daemonB);

    const aSession = await store.createSession(aIssue.id, "ework");
    const bSession = await store.createSession(bIssue.id, "ework");

    const aMsg = await store.createMessage(aSession.id, "for A");
    const bMsg = await store.createMessage(bSession.id, "for B");

    const aPending = await store.getOwnedPendingOrRunningMessages(daemonA);
    const bPending = await store.getOwnedPendingOrRunningMessages(daemonB);
    expect(aPending.map((m) => m.id)).toEqual([aMsg.id]);
    expect(bPending.map((m) => m.id)).toEqual([bMsg.id]);
  });
});

describe("coordination: first-boot migration claim", () => {
  it("claimAllOwnerless claims every pre-existing ownerless issue for this daemon", async () => {
    const store = new Store();
    const i1 = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const i2 = await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const i3 = await store.findOrCreateIssue(ref("3"), "dog/repo", "");

    const daemonA = await insertDaemon(store);
    const claimed = await store.claimAllOwnerless(daemonA);

    expect(claimed).toBe(3);
    const owned = await store.listOwnedIssues(daemonA);
    expect(owned.map((i) => i.id).sort()).toEqual([i1.id, i2.id, i3.id].sort());
  });

  it("claimAllOwnerless is idempotent (no-op second call)", async () => {
    const store = new Store();
    await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    await store.findOrCreateIssue(ref("2"), "dog/repo", "");
    const daemonA = await insertDaemon(store);

    expect(await store.claimAllOwnerless(daemonA)).toBe(2);
    expect(await store.claimAllOwnerless(daemonA)).toBe(0);
  });
});

describe("coordination: runtime state persistence", () => {
  it("updateSession persists nudge_rounds / last_output_at / generation; getSession reads them back", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");

    const lastOutputTs = Date.now();
    await store.updateSession(session.id, {
      nudgeRounds: 2,
      stuckNudgeRounds: 1,
      generation: 7,
      lastOutputAt: lastOutputTs,
    });

    const reloaded = await store.getSession(session.id);
    expect(reloaded?.nudgeRounds).toBe(2);
    expect(reloaded?.stuckNudgeRounds).toBe(1);
    expect(reloaded?.generation).toBe(7);
    // Stored as ISO string, restored to epoch ms — allow 1s slack.
    expect(reloaded?.lastOutputAt).toBeTruthy();
    expect(Math.abs((reloaded?.lastOutputAt ?? 0) - lastOutputTs)).toBeLessThan(1000);
  });

  it("new sessions default to zero counters and undefined last_output_at", async () => {
    const store = new Store();
    const issue = await store.findOrCreateIssue(ref("1"), "dog/repo", "");
    const session = await store.createSession(issue.id, "ework");

    const reloaded = await store.getSession(session.id);
    expect(reloaded?.nudgeRounds).toBe(0);
    expect(reloaded?.stuckNudgeRounds).toBe(0);
    expect(reloaded?.generation).toBe(0);
    expect(reloaded?.lastOutputAt).toBeUndefined();
  });
});

describe("coordination: heartbeat", () => {
  it("heartbeat updates last_heartbeat for the given daemon", async () => {
    const store = new Store();
    const id = await insertDaemon(store, { age: 30_000 });

    await store.heartbeat(id);

    const row = await getDB().get<{ last_heartbeat: string }>(
      "SELECT last_heartbeat FROM {{daemons}} WHERE id = ?",
      [id],
    );
    expect(row).toBeTruthy();
    const ts = new Date(row!.last_heartbeat).getTime();
    expect(Date.now() - ts).toBeLessThan(2000);
  });
});
