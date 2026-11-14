import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";

// Real-stuck tests sleep through threshold + poll cycles; per-test 120s timeout (bun default 5s).
const TMO = 120_000;
import { writeFileSync, chmodSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { Store } from "../src/op";
import { Engine, type TakeoverStrategy } from "../src/opencode";
import { initDB, getDB } from "../src/db";
import { loadConfig, type Config } from "../src/config";
import type {
  IssueTracker,
  TrackerRef,
  TrackerEvent,
  TrackerComment,
  TrackerInstructions,
  Issue,
  OpSession,
} from "../src/trackers/types";

// Stuck-kill congestion backoff (2026-11-14 owner decision). The old behavior
// re-dispatched instantly on every stuck kill (nudge message + immediate
// dequeue): under a congested upstream the pool killed the same session every
// ~30min, resurrected it, killed it again — an infinite loop that burned the
// release window (billion-context release v0.1.214 starvation, 11-13/11-14).
// New contract: each stuck kill parks the ORIGINAL message interrupted with an
// exponential retry_after hold (30min * 2^(n-1), cap 6h; give-up flat 2h), no
// nudge message, no immediate re-dispatch; sweepStrandedInterrupted skips rows
// whose hold has not expired and resurrects them once it has.

const FAKE_BIN = join(tmpdir(), "fake-opencode-stuck-backoff.sh");
const FAKE_SESSION_ID = "ses-test-stuck-bo-aaaa-bbbb-cccc-dddddddddddd";
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let workdirBase: string;
let opencodeDbPath: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
let gateAllowed = true;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  // Emits a sessionID (so spawn is "healthy") and then stays silent: the
  // stuck detector's no-output threshold fires while the process is alive.
  writeFileSync(
    FAKE_BIN,
    `#!/bin/sh\necho "{\\"sessionID\\":\\"${FAKE_SESSION_ID}\\"}"\nsleep 300\n`,
  );
  chmodSync(FAKE_BIN, 0o755);
  await initDB();
});

beforeEach(async () => {
  const db = getDB();
  const mysql = db.dialect === "mysql";
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 0" : "PRAGMA foreign_keys = OFF");
  for (const t of ["messages", "op_sessions", "issues", "daemons"]) {
    await db.exec(`DELETE FROM {{${t}}}`);
  }
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");

  workdirBase = `${tmpdir()}/ework-daemon-stuckbo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  opencodeDbPath = join(workdirBase, "opencode.db");
  const ocdb = new Database(opencodeDbPath);
  ocdb.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  ocdb.query("INSERT INTO session (id) VALUES (?)").run(FAKE_SESSION_ID);
  ocdb.close();

  fakeTracker = new FakeTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
  gateAllowed = true;
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
});

class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  private nextId = 1;
  isBot = false;

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: this.isBot ? "ework-daemon" : "tester", createdAt: new Date().toISOString() });
    return { id };
  }

  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return [...this.comments]; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}
  async setIssueReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(author: string): boolean { return author === "ework-daemon"; }
}

class TestTakeoverStrategy implements TakeoverStrategy {
  constructor(private baseWorkdir: string) {}
  async acquireWorkdir(session: OpSession, issue: Issue): Promise<string> {
    const dir = join(this.baseWorkdir, String(issue.trackerIssueId), session.name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  async resumeOpenCodeSession(): Promise<string | null> { return null; }
}

function makeConfig(stuck?: { thresholdMs: number; maxNudges: number }): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    stuck: {
      thresholdMs: stuck?.thresholdMs ?? 100,
      maxNudges: stuck?.maxNudges ?? 2,
      maxRuntimeMs: 3_600_000,
    },
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase, dbPath: opencodeDbPath },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS, reconcileScopes: [] },
  };
}

async function bootEngine(name: string, store: Store, cfg: Config, port: number): Promise<Engine> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon(
    `host-${name}`,
    `127.0.0.1:${port}`,
    cfg.work.capacity,
    cfg.work.leaseTtlMs,
  );
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId,
    gateChecker: async () => (gateAllowed ? { allowed: true, reason: "test" } : { allowed: false, reason: "dispatch off" }),
    takeover: new TestTakeoverStrategy(workdirBase),
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return engine;
}

function commentEvent(issueId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "stuck backoff test", body: "b", state: "open", author: "tester" },
    comment: { id: `wc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, body, author: "tester" },
  };
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

async function messageRow(): Promise<{ uid: string; status: string; retry_after: string | null } | undefined> {
  const db = getDB();
  const row = await db.get<{ uid: string; status: string; retry_after: string | null }>(
    `SELECT uid, status, retry_after FROM {{messages}} LIMIT 1`,
  );
  return row ?? undefined;
}

// Drive the observer by hand: the engine's real cycle is 5min apart, which
// would make each test take minutes. Poll the DB, and once the row exists run
// an observer cycle every 2s (well past the 100ms no-output threshold) until
// the stuck kill settles the row, or the timeout elapses.
async function waitForStuckSettle(engine: Engine, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await messageRow();
    if (row && row.status === "interrupted" && row.retry_after) return row;
    await Bun.sleep(2000);
    await (engine as unknown as { runObserverCycle(): Promise<void> }).runObserverCycle().catch(() => {});
  }
  const row = await messageRow();
  return row && row.status === "interrupted" ? row : undefined;
}

// Flip a parked interrupted row back to pending (hold cleared) and let the
// engine re-dispatch it — simulates the hold expiring plus the next observer
// cycle, without waiting the real backoff window.
async function fastForwardResurrect(engine: Engine, msgUid: string): Promise<void> {
  const db = getDB();
  await db.exec(`UPDATE {{messages}} SET status = 'pending', retry_after = NULL WHERE uid = '${msgUid}'`);
  await (engine as unknown as { runObserverCycle(): Promise<void> }).runObserverCycle();
}

function heldMinutes(row: { retry_after: string | null }): number {
  expect(row.retry_after).toBeTruthy();
  return (new Date(row.retry_after as string).getTime() - Date.now()) / 60_000;
}

describe("stuck-kill congestion backoff (2026-11-14)", () => {
  it("first stuck kill: parks original row interrupted with a ~30min hold, no nudge message, no re-dispatch", TMO, async () => {
    const store = new Store();
    const engine = await bootEngine("A", store, makeConfig(), 7401);

    await engine.handleEvent(commentEvent("701", "hang on"));
    const row = await waitForStuckSettle(engine);
    expect(row).toBeTruthy();
    expect(row!.status).toBe("interrupted");

    // Hold ≈ 30min (first kill: 30 * 2^0). Tolerate test-run drift.
    const mins = heldMinutes(row!);
    expect(mins).toBeGreaterThanOrEqual(25);
    expect(mins).toBeLessThanOrEqual(40);

    // Exactly ONE message row — the old behavior minted a second nudge row
    // that raced the original back into the pool immediately.
    const db = getDB();
    const count = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM {{messages}}`))!.n;
    expect(count).toBe(1);

    // The visible notice carries the backoff, not a bare "restarting".
    const notice = fakeTracker.comments.map((c) => c.body).find((b) => b.includes("congestion backoff"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("~30 min");

    // And nothing came back up: the session must be idle, not running.
    await Bun.sleep(300);
    const after = await messageRow();
    expect(after?.status).toBe("interrupted");
  });

  it("second stuck kill doubles the hold to ~60min (exponential, no loop)", TMO, async () => {
    const store = new Store();
    const engine = await bootEngine("B", store, makeConfig(), 7402);

    await engine.handleEvent(commentEvent("702", "hang one"));
    const first = await waitForStuckSettle(engine);
    expect(first).toBeTruthy();

    // Fast-forward the 30min hold, re-dispatch, and let it stick again.
    await fastForwardResurrect(engine, first!.uid);
    const second = await waitForStuckSettle(engine);
    expect(second).toBeTruthy();
    expect(second!.status).toBe("interrupted");

    const mins = heldMinutes(second!);
    expect(mins).toBeGreaterThanOrEqual(50);
    expect(mins).toBeLessThanOrEqual(80);

    const notices = fakeTracker.comments.map((c) => c.body).filter((b) => b.includes("congestion backoff"));
    expect(notices.length).toBe(2);
    expect(notices[1]).toContain("~60 min");
  });

  it("sweep skips a parked row whose hold has not expired, and resurrects it once the hold lapses", TMO, async () => {
    const store = new Store();
    const engine = await bootEngine("C", store, makeConfig(), 7403);

    await engine.handleEvent(commentEvent("703", "hang two"));
    const row = await waitForStuckSettle(engine);
    expect(row).toBeTruthy();

    // Hold still in the future: the restart-stranding repair must NOT yank
    // this row back early (that was the infinite kill/resurrect loop).
    await engine.sweepStrandedInterrupted();
    expect((await messageRow())?.status).toBe("interrupted");

    // Hold lapses: same sweep now resurrects it to pending and drains.
    const db = getDB();
    await db.exec(`UPDATE {{messages}} SET retry_after = datetime('now', '-1 minute')`);
    await engine.sweepStrandedInterrupted();
    const revived = await waitFor(async () => {
      const r = await messageRow();
      return r && r.status !== "interrupted" ? r : undefined;
    });
    expect(revived).toBeTruthy();
    expect(["pending", "running", "done"]).toContain(revived!.status);
  });

  it("give-up (nudge budget spent) applies a flat 2h hold, not an instant retry", TMO, async () => {
    const store = new Store();
    // maxNudges=1 → the FIRST kill is kill #1 (backoff), the SECOND hits
    // stuckNudgeRound == maxNudges and takes the give-up branch.
    const engine = await bootEngine("D", store, makeConfig({ thresholdMs: 100, maxNudges: 1 }), 7404);

    await engine.handleEvent(commentEvent("704", "hang three"));
    const first = await waitForStuckSettle(engine);
    expect(first).toBeTruthy();

    await fastForwardResurrect(engine, first!.uid);
    const second = await waitForStuckSettle(engine);
    expect(second).toBeTruthy();
    expect(second!.status).toBe("interrupted");

    const mins = heldMinutes(second!);
    expect(mins).toBeGreaterThanOrEqual(110);
    expect(mins).toBeLessThanOrEqual(130);

    const giveup = fakeTracker.comments.map((c) => c.body).find((b) => b.includes("gave up after"));
    expect(giveup).toBeTruthy();
  });
});
