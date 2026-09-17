import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
import type {
  RuntimeBackend,
  RuntimeHandle,
  RuntimeSpawnOpts,
  RuntimeSpawnCallbacks,
  LastModelResult,
  SessionOutputResult,
} from "../src/runtime/types";

// Restart-recovery harness (ework#9). Simulates a hard daemon death by
// destroying engine A mid-run, waiting out its lease so engine B adopts the
// issues, then driving B.recover() explicitly. Covers: zero-touch respawn,
// misjudged-done (in-progress reply), downtime-pending expiry, and
// consumed-but-not-delivered comment backfill.

const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;
const BOT_USER = "ework-daemon";
const HUMAN_USER = "tester";

let workdirBase: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
let gateAllowed = true;
const liveEngines: Engine[] = [];

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
  await db.exec(mysql ? "SET FOREIGN_KEY_CHECKS = 1" : "PRAGMA foreign_keys = ON");

  workdirBase = `${tmpdir()}/ework-daemon-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

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

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: BOT_USER, createdAt: new Date().toISOString() });
    return { id };
  }

  edits: Array<{ id: string; body: string }> = [];

  async editComment(_ref: TrackerRef, id: string, body: string): Promise<void> {
    this.edits.push({ id, body });
  }
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return [...this.comments]; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setCommentModel(): Promise<void> {}
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(author: string): boolean { return author === BOT_USER; }
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

/**
 * Fake runtime: each spawn starts a real sleeping child (so destroy() can
 * tree-kill it like production). With deliver=false the child sleeps long
 * enough to model an in-flight run at crash time; with deliver=true the
 * backend posts a [bot] delivery comment and lets the child exit 0 quickly.
 */
class FakeBackend implements RuntimeBackend {
  readonly name = "fake";
  spawns = 0;
  deliver = false;
  constructor(private comments: TrackerComment[]) {}

  async spawn(opts: RuntimeSpawnOpts, callbacks: RuntimeSpawnCallbacks): Promise<RuntimeHandle> {
    this.spawns++;
    const sleepCmd = this.deliver ? "sleep 0.2" : "sleep 30";
    const proc = Bun.spawn(["sh", "-c", sleepCmd], { stdout: "ignore", stderr: "ignore" });
    if (this.deliver) {
      setTimeout(() => {
        this.comments.push({
          id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          body: "[bot] 🏷 done: handled the request",
          author: BOT_USER,
          createdAt: new Date().toISOString(),
        });
        callbacks.onOutput();
      }, 50);
    }
    const exited = proc.exited.then(() => 0);
    return {
      pid: proc.pid,
      exited,
      stderrText: Promise.resolve(""),
      stderrPartial: () => "",
      stderrCancel: () => {},
    };
  }

  async lastSessionModel(): Promise<LastModelResult> { return { model: "fake/model" }; }
  async sessionExists(): Promise<boolean> { return true; }
  async getSessionOutputTokens(): Promise<SessionOutputResult> { return { hasOutput: true, tokenCount: 5 }; }
}

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: "fake-opencode", baseWorkdir: workdirBase, dbPath: join(workdirBase, "opencode.db") },
    work: { ...cfg.work, capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(name: string, store: Store, cfg: Config, port: number, backend: FakeBackend): Promise<{ engine: Engine; daemonId: number }> {
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
    backend,
    recoverOnBoot: false,
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return { engine, daemonId };
}

function commentEvent(issueId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "restart recovery test", body: "b", state: "open", author: HUMAN_USER },
    comment: { id: `wc-${Date.now()}`, body, author: HUMAN_USER },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() - start >= timeoutMs) break;
    await sleep(50);
  }
  return await fn();
}

async function messageRows(): Promise<Array<{ status: string; source_comment_id: string | null; error: string | null }>> {
  const db = getDB();
  return db.all<{ status: string; source_comment_id: string | null; error: string | null }>(
    `SELECT status, source_comment_id, error FROM {{messages}} ORDER BY created_at ASC`,
  );
}

/** Let engine A's lease expire so the next boot adopts its issues. */
async function expireLease(engineA: Engine): Promise<void> {
  engineA.destroy();
  await sleep(LEASE_TTL_MS + 150);
}

describe("restart recovery (ework#9)", () => {
  it("respawns an in-flight run after restart and delivers with zero human intervention", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = false;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7401, backend);

    await engineA.handleEvent(commentEvent("901", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);
    expect(backend.spawns).toBe(1);

    // Hard crash mid-run; restart with a working backend.
    await expireLease(engineA);
    backend.deliver = true;
    const { engine: engineB } = await bootEngine("B", store, cfg, 7402, backend);
    await engineB.recover();

    // Auto-respawn (spawn #2) and eventual delivery — nobody touched retryMessage.
    expect(await waitFor(() => (backend.spawns >= 2 ? true : undefined))).toBe(true);
    const rows = await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "done" ? r : undefined;
    });
    expect(rows?.[0]?.status).toBe("done");
    expect(rows?.[0]?.error).toBeNull();
    expect(backend.spawns).toBe(2);
  });

  it("does NOT treat an in-progress reply as delivery after restart (misjudged-done regression)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = false;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7403, backend);

    await engineA.handleEvent(commentEvent("902", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);

    await expireLease(engineA);

    // The killed run had posted progress wording just before dying.
    fakeTracker.comments.push({
      id: "bot-wip",
      body: "[bot] 🏷 正在处理中，稍后汇报结果",
      author: BOT_USER,
      createdAt: new Date().toISOString(),
    });

    const { engine: engineB } = await bootEngine("B", store, cfg, 7404, backend);
    await engineB.recover();

    // Must re-run, not be judged done: the thread stays alive.
    expect(await waitFor(() => (backend.spawns >= 2 ? true : undefined))).toBe(true);
    const rows = await messageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).not.toBe("done");
  });

  it("treats a real post-prompt delivery reply as done (no duplicate run)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = false;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7405, backend);

    await engineA.handleEvent(commentEvent("904", "please fix"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);

    await expireLease(engineA);

    fakeTracker.comments.push({
      id: "bot-delivery",
      body: "[bot] 🏷 已完成，修复提交在 PR #12，测试全部通过。",
      author: BOT_USER,
      createdAt: new Date().toISOString(),
    });

    const { engine: engineB } = await bootEngine("B", store, cfg, 7406, backend);
    await engineB.recover();

    const rows = await messageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("done");
    expect(backend.spawns).toBe(1);
  });

  it("replays a pending message queued during downtime instead of expiring it (downtime-pending regression)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = false;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7407, backend);

    await engineA.handleEvent(commentEvent("905", "queued work"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "running" ? true : undefined;
    })).toBe(true);

    // Park it as a 2-hour-old pending message (far past the 30-min stale cap).
    const db = getDB();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    await db.run(`UPDATE {{messages}} SET status = 'pending', created_at = ?, pending_since = ?`, [twoHoursAgo, twoHoursAgo]);

    await expireLease(engineA);
    backend.deliver = true;
    const { engine: engineB } = await bootEngine("B", store, cfg, 7408, backend);
    await engineB.recover();

    // Downtime does not age pending: it must replay and finish, not expire.
    const rows = await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "done" ? r : undefined;
    });
    expect(rows?.[0]?.status).toBe("done");
    expect(rows?.[0]?.error ?? "").not.toContain("expired");
  });

  it("backfills web comments consumed during the failure window that have no message record", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = true;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7409, backend);

    await engineA.handleEvent(commentEvent("906", "first request"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]?.status === "done" ? true : undefined;
    })).toBe(true);

    // A comment posted while web kept flowing but the daemon was down:
    // webhook consumed, process died before createMessage → no message row.
    fakeTracker.comments.push({ id: "wc-lost", body: "second request", author: HUMAN_USER, createdAt: new Date().toISOString() });
    // An ancient comment below our newest-message floor must stay skipped.
    fakeTracker.comments.push({ id: "wc-old", body: "ancient request", author: HUMAN_USER, createdAt: new Date(Date.now() - 10 * 60_000).toISOString() });

    await expireLease(engineA);
    const { engine: engineB } = await bootEngine("B", store, cfg, 7410, backend);
    await engineB.recover();

    let rows = await messageRows();
    const lostCount = rows.filter((r) => r.source_comment_id === "wc-lost").length;
    if (lostCount !== 1) {
      // Flake run 35193047795: recover() returned with this row missing and
      // nothing in the log explained why. Dump the ownership chain tables so
      // the next occurrence pinpoints the broken link instead of guessing.
      const db = getDB();
      console.error("[recovery-flake-dump]", JSON.stringify({
        daemons: db.all("SELECT * FROM {{daemons}}"),
        issues: db.all("SELECT * FROM {{issues}}"),
        sessions: db.all("SELECT * FROM {{op_sessions}}"),
        messages: db.all("SELECT id, session_id, source_comment_id, status, created_at FROM {{messages}}"),
      }, null, 2));
    }
    expect(lostCount).toBe(1);
    expect(rows.filter((r) => r.source_comment_id === "wc-old").length).toBe(0);

    // Idempotent: a second recovery pass must not duplicate the backfill.
    await engineB.recover();
    rows = await messageRows();
    expect(rows.filter((r) => r.source_comment_id === "wc-lost").length).toBe(1);

    // And the backfilled work actually runs to delivery.
    const done = await waitFor(async () => {
      const r = await messageRows();
      const lost = r.filter((x) => x.source_comment_id === "wc-lost");
      return lost.length === 1 && lost[0]?.status === "done" ? true : undefined;
    });
    expect(done).toBe(true);
  });

  it("closes the stale progress comment of a run interrupted by the restart (ework#420)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const backend = new FakeBackend(fakeTracker.comments);
    backend.deliver = false;
    const { engine: engineA } = await bootEngine("A", store, cfg, 7411, backend);
    await engineA.handleEvent(commentEvent("701", "long task"));
    expect(await waitFor(async () => {
      const r = await messageRows();
      return r.length === 1 && r[0]!.status === "running" ? true : undefined;
    })).toBe(true);

    // The in-flight run's ⏳ progress comment, persisted on the session row
    // exactly like the 5-min observer does in production.
    fakeTracker.comments.push({
      id: "pc-stale",
      body: "[system] 🏷 ⏳ **ework-daemon** processing, running for 3 min...",
      author: BOT_USER,
      createdAt: new Date().toISOString(),
    });
    const sess = await getDB().get<{ uid: string }>(`SELECT uid FROM {{op_sessions}} LIMIT 1`);
    expect(sess).toBeDefined();
    await store.updateSession(sess!.uid, { progressCommentId: "pc-stale" });

    await expireLease(engineA);
    const { engine: engineB } = await bootEngine("B", store, cfg, 7412, backend);
    await engineB.recover();

    const staleEdits = fakeTracker.edits.filter((e) => e.id === "pc-stale");
    expect(staleEdits.length).toBe(1);
    expect(staleEdits[0]!.body).toContain("interrupted");
    expect(staleEdits[0]!.body).toContain("auto-retry");
  });
});
