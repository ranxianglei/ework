import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store, isForeignKeyError } from "../src/op";
import { Engine } from "../src/opencode";
import { initDB, getDB } from "../src/db";
import { loadConfig, type Config } from "../src/config";
import type { Issue } from "../src/trackers/types";

// Regression tests for ranxianglei/ework#7: after the engine DB was wiped
// (issues/daemons emptied), claimIssue raised an FK error against the
// vanished daemons row and threads were stranded permanently unscheduled.
// The wipe is simulated with FK checks off; the assertions cover:
//   1. releaseDanglingOwners unblocks issues owned by vanished daemon rows;
//   2. ensureOwned re-registers the daemon on FK failure and retries once;
//   3. ensureOwned re-creates a vanished issue row before claiming;
//   4. a genuine lost race still returns false.

let store: Store;
const liveEngines: Engine[] = [];
let workdirBase: string;

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: "/bin/true", baseWorkdir: workdirBase },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: 60_000, leaseTtlMs: 60_000, reconcileScopes: [] },
  };
}

async function bootEngine(daemonId: number): Promise<Engine> {
  const engine = new Engine(makeConfig(), store, { get: () => undefined }, {
    daemonId,
    gateChecker: async () => ({ allowed: true, reason: "test" }),
  });
  liveEngines.push(engine);
  return engine;
}

beforeAll(async () => {
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  await db.exec("PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues", "daemons"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec("PRAGMA foreign_keys = ON");

  store = new Store();
  workdirBase = join(tmpdir(), `claim-heal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(workdirBase, { recursive: true });
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("isForeignKeyError", () => {
  it("matches SQLite FK messages, MySQL errno 1452, rejects others", () => {
    expect(isForeignKeyError(new Error("FOREIGN KEY constraint failed"))).toBe(true);
    expect(isForeignKeyError(new Error("xxx: FOREIGN KEY constraint failed: yyy"))).toBe(true);
    expect(isForeignKeyError({ errno: 1452 })).toBe(true);
    expect(isForeignKeyError(new Error("no such table: issues"))).toBe(false);
    expect(isForeignKeyError({ errno: 1290 })).toBe(false);
    expect(isForeignKeyError(null)).toBe(false);
    expect(isForeignKeyError("FOREIGN KEY constraint failed")).toBe(false);
  });
});

describe("releaseDanglingOwners", () => {
  it("clears owners pointing at vanished daemons rows; releaseDeadOwners cannot", async () => {
    const daemonId = await store.registerDaemon("host-a", "127.0.0.1:3111", 4, 60_000);
    const issue = await store.findOrCreateIssue(
      { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "1" },
      "dog/repo",
      "dangling",
    );
    expect(await store.claimIssue(issue.id, daemonId)).toBe(true);

    // Simulate the incident: the daemons table is emptied out from under us.
    const db = getDB();
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.exec("DELETE FROM {{daemons}}");
    await db.exec("PRAGMA foreign_keys = ON");

    // Dead-owner sweep finds nothing (the referenced row no longer exists),
    // so without the dangling sweep the issue would stay blocked forever.
    expect(await store.releaseDeadOwners(1)).toBe(0);
    let fresh = await store.getIssue(issue.id);
    expect(fresh?.ownerDaemonId).toBe(daemonId);

    expect(await store.releaseDanglingOwners()).toBe(1);
    fresh = await store.getIssue(issue.id);
    expect(fresh?.ownerDaemonId).toBeNull();

    const otherId = await store.registerDaemon("host-b", "127.0.0.1:3112", 4, 60_000);
    expect(await store.claimIssue(issue.id, otherId)).toBe(true);
  });

  it("is a no-op when every owner ref resolves", async () => {
    const daemonId = await store.registerDaemon("host-a", "127.0.0.0:3111", 4, 60_000);
    const issue = await store.findOrCreateIssue(
      { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "2" },
      "dog/repo",
      "healthy",
    );
    await store.claimIssue(issue.id, daemonId);
    expect(await store.releaseDanglingOwners()).toBe(0);
  });
});

describe("ensureOwned self-heal", () => {
  it("re-registers a vanished daemon row on FK failure and claims", async () => {
    // The running process still believes its id is oldId, but its daemons
    // row was wiped out from under it (the incident scenario).
    const oldId = await store.registerDaemon(hostnameName(), "127.0.0.0:3111", 4, 60_000);
    const issue = await store.findOrCreateIssue(
      { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "3" },
      "dog/repo",
      "heal-on-fk",
    );

    const staleIssue = (await store.getIssue(issue.id))!;
    expect(staleIssue.ownerDaemonId).toBeNull();
    const db = getDB();
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.exec("DELETE FROM {{daemons}}");
    await db.exec("PRAGMA foreign_keys = ON");

    const engine = await bootEngine(oldId);
    expect(await engine.ensureOwned(staleIssue)).toBe(true);

    const fresh = await store.getIssue(issue.id);
    const rows = await getDB().all<{ id: number }>("SELECT id FROM {{daemons}}");
    expect(rows.length).toBe(1);
    expect(fresh?.ownerDaemonId).toBe(rows[0]?.id);
    expect(fresh?.ownerDaemonId).not.toBeNull();
    if (!fresh?.ownerDaemonId) throw new Error("heal did not claim the issue");
    // Heartbeat on the healed identity works (row really exists now).
    await store.heartbeat(fresh.ownerDaemonId);
  });

  it("re-creates a vanished issue row before claiming", async () => {
    const oldId = await store.registerDaemon(hostnameName(), "127.0.0.0:3111", 4, 60_000);
    const issue = await store.findOrCreateIssue(
      { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "4" },
      "dog/repo",
      "recreate-row",
    );
    await store.claimIssue(issue.id, oldId);
    const staleIssue = (await store.getIssue(issue.id))!;

    // Full wipe of issues AND daemons — the worst case of the incident.
    const db = getDB();
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.exec("DELETE FROM {{op_sessions}}");
    await db.exec("DELETE FROM {{messages}}");
    await db.exec("DELETE FROM {{issues}}");
    await db.exec("DELETE FROM {{daemons}}");
    await db.exec("PRAGMA foreign_keys = ON");

    const engine = await bootEngine(oldId);
    expect(await store.getIssue(staleIssue.id)).toBeUndefined();
    expect(await engine.ensureOwned(staleIssue)).toBe(true);

    // The re-created row carries a fresh local uid — look it up by tracker ref.
    const fresh = await store.findIssue("gitea", "dog/repo", "4");
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(staleIssue.id);
    expect(fresh!.title).toBe("recreate-row");
    expect(fresh!.trackerScopeKey).toBe("dog/repo");
    expect(fresh!.ownerDaemonId).not.toBeNull();
  });

  it("still returns false when another live daemon owns the issue", async () => {
    const mine = await store.registerDaemon(hostnameName(), "127.0.0.0:3111", 4, 60_000);
    const theirs = await store.registerDaemon("other-host", "127.0.0.0:3112", 4, 60_000);
    const issue = await store.findOrCreateIssue(
      { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId: "5" },
      "dog/repo",
      "lost-race",
    );
    expect(await store.claimIssue(issue.id, theirs)).toBe(true);

    const engine = await bootEngine(mine);
    const fresh = (await store.getIssue(issue.id))!;
    expect(await engine.ensureOwned(fresh)).toBe(false);
    expect((await store.getIssue(issue.id))!.ownerDaemonId).toBe(theirs);
  });
});

function hostnameName(): string {
  return "test-host";
}
