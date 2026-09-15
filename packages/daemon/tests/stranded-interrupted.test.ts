import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
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

// Restart-stranding repair harness. When the daemon boots while the web is
// unreachable, recover() parks in-flight messages as 'interrupted' and they
// stay that way forever. sweepStrandedInterrupted() (observer cycle) must
// resurrect them — except when preempted by a newer sibling or already
// answered by a later bot reply.

const FAKE_BIN = join(tmpdir(), "fake-opencode-stranded.sh");
const FAKE_SESSION_ID = "ses-test-stranded-aaaa-bbbb-cccc-dddddddddddd";
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let workdirBase: string;
let opencodeDbPath: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
let gateAllowed = true;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  writeFileSync(
    FAKE_BIN,
    `#!/bin/sh
echo "{\\"sessionID\\":\\"${FAKE_SESSION_ID}\\"}"
exit 0
`,
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

  workdirBase = `/tmp/ework-daemon-stranded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function makeConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase, dbPath: opencodeDbPath },
    work: { capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(name: string, store: Store, cfg: Config, port: number): Promise<{ engine: Engine; daemonId: number }> {
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
  return { engine, daemonId };
}

function commentEvent(issueId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "stranded test", body: "b", state: "open", author: "tester" },
    comment: { id: `wc-${Date.now()}`, body, author: "tester" },
  };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

async function getFirstSessionMessage(store: Store) {
  const sessions = await store.listOwnedSessions(1).catch(() => []);
  const s = sessions[0];
  if (!s) return undefined;
  return { session: s, msg: await store.getNextPendingMessage(s.id).catch(() => undefined) };
}

// ─── Tests ───

describe("sweepStrandedInterrupted: restart-stranding repair", () => {
  it("resurrects a stranded interrupted message to pending and drains it", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("A", store, cfg, 7301);

    await engine.handleEvent(commentEvent("200", "please fix"));
    const got = await waitFor(() => (fakeTracker.comments.length > 0 ? true : undefined));
    expect(got).toBe(true);

    // Simulate the stranding: take the message that just ran and park it as
    // 'interrupted' with nothing newer in flight (web was unreachable at boot).
    const db = getDB();
    await db.exec(`UPDATE {{messages}} SET status = 'interrupted' WHERE status IN ('done','running','pending')`);

    await engine.sweepStrandedInterrupted();

    const statuses = await db.all<{ status: string }>(`SELECT status FROM {{messages}}`);
    expect(statuses.some((r) => r.status === "done" || r.status === "running" || r.status === "pending")).toBe(true);
    expect(statuses.every((r) => r.status !== "interrupted")).toBe(true);
  });

  it("marks stranded message done when the bot already replied after it", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("B", store, cfg, 7302);

    await engine.handleEvent(commentEvent("201", "already answered"));
    await waitFor(() => (fakeTracker.comments.length > 0 ? true : undefined));

    const db = getDB();
    await db.exec(`UPDATE {{messages}} SET status = 'interrupted'`);

    // A bot reply landed AFTER the stranded message was created.
    fakeTracker.comments.push({ id: "bot-1", body: "[bot] done already", author: "ework-daemon", createdAt: new Date().toISOString() });

    await engine.sweepStrandedInterrupted();

    const rows = await db.all<{ status: string }>(`SELECT status FROM {{messages}}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "done")).toBe(true);
  });

  it("leaves interrupted messages alone when the gate is closed", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("C", store, cfg, 7303);

    await engine.handleEvent(commentEvent("202", "gated work"));
    await waitFor(() => (fakeTracker.comments.length > 0 ? true : undefined));

    const db = getDB();
    await db.exec(`UPDATE {{messages}} SET status = 'interrupted'`);

    gateAllowed = false;
    await engine.sweepStrandedInterrupted();

    const rows = await db.all<{ status: string }>(`SELECT status FROM {{messages}}`);
    expect(rows.some((r) => r.status === "interrupted")).toBe(true);
  });

  it("does not resurrect a message preempted by a newer running sibling", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("D", store, cfg, 7304);

    await engine.handleEvent(commentEvent("203", "old prompt"));
    await waitFor(() => (fakeTracker.comments.length > 0 ? true : undefined));

    const db = getDB();
    // Old message: interrupted. Newer sibling: running (preemption shape).
    await db.exec(`UPDATE {{messages}} SET status = 'interrupted'`);
    const s = await getFirstSessionMessage(store);
    expect(s?.session).toBeTruthy();
    const issueRow = await db.get<{ uid: string }>(`SELECT uid FROM {{issues}} LIMIT 1`);
    expect(issueRow?.uid).toBeTruthy();
    const nowIso = new Date().toISOString();
    await db.exec(
      `INSERT INTO {{messages}} (uid, session_id, content, status, created_at, updated_at) VALUES ('newer-sibling-test', '${s!.session.id}', 'newer prompt', 'running', '${nowIso}', '${nowIso}')`,
    );

    await engine.sweepStrandedInterrupted();

    const oldRow = await db.get<{ status: string }>(`SELECT status FROM {{messages}} WHERE uid != 'newer-sibling-test'`);
    expect(oldRow?.status).toBe("interrupted");
  });
});
