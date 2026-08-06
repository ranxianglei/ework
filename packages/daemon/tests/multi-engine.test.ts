import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
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

// Multi-machine end2end harness. Two real Engine instances share one Store;
// only opencode subprocess + tracker are stubbed. Tests assert on DB state +
// a counter file written by the fake binary on every spawn (the
// no-double-spawn / no-double-consume math depends on MAX_NUDGE_ROUNDS=1,
// which makes each winning dispatch fire twice: initial + 1 nudge).

const FAKE_BIN = join(tmpdir(), "fake-opencode-ework-daemon-multi-engine.sh");
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let counterFile: string;
let workdirBase: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  writeFileSync(
    FAKE_BIN,
    // Fake opencode: emit a JSON line whose shape matches the parser at
    // opencode.ts:718 (`JSON.parse(line)`; truthy `ev.sessionID` is the only
    // required field). Append to a counter file so tests can assert spawn
    // counts. Exit 0 simulates instant successful work.
    `#!/bin/sh
echo "1" >> "$FAKE_OPENCODE_COUNTER"
echo "{\\"sessionID\\":\\"fake-$$-$(date +%s%N)\\"}"
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

  counterFile = `/tmp/fake-opencode-count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.FAKE_OPENCODE_COUNTER = counterFile;
  workdirBase = `/tmp/ework-daemon-multi-engine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  fakeTracker = new FakeTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
});

afterEach(async () => {
  for (const e of liveEngines) {
    try { e.destroy(); } catch { /* already destroyed */ }
  }
  liveEngines.length = 0;
  try { rmSync(counterFile); } catch { /* gone */ }
  try { rmSync(workdirBase, { recursive: true, force: true }); } catch { /* gone */ }
  delete process.env.FAKE_OPENCODE_COUNTER;
});

// FakeTracker: in-process IssueTracker. createComment returns id + pushes to
// array; listComments returns the array; everything else is a no-op. Comments
// authored by "system" intentionally do NOT satisfy isBotUser (so the engine's
// hasRecentBotReply check returns false and the nudge loop runs — that's how
// the test can predict the exact spawn count).
class FakeTracker implements IssueTracker {
  readonly type = "gitea";
  comments: TrackerComment[] = [];
  private nextId = 1;

  formatScopeKey(scope: Record<string, string>): string {
    return `${scope.owner}/${scope.repo}`;
  }

  async createComment(_ref: TrackerRef, body: string): Promise<{ id: string }> {
    const id = `c${this.nextId++}`;
    this.comments.push({ id, body, author: "system", createdAt: new Date().toISOString() });
    return { id };
  }

  async editComment(): Promise<void> {}
  async deleteComment(): Promise<void> {}
  async listComments(): Promise<TrackerComment[]> { return [...this.comments]; }
  async closeIssue(): Promise<void> {}
  async updateStatus(): Promise<void> {}
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
}

// TestTakeoverStrategy: mkdir the workdir, skip the git clone (production
// RecloneStrategy would TCP-time-out against the fake gitea URL and slow
// tests by seconds per spawn).
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
    opencode: { ...cfg.opencode, binary: FAKE_BIN, baseWorkdir: workdirBase },
    work: { capacity: 4, maxConcurrent: 4, maxConcurrentExplicit: false, heartbeatMs: HEARTBEAT_MS, leaseTtlMs: LEASE_TTL_MS },
  };
}

async function bootEngine(
  name: string,
  store: Store,
  cfg: Config,
  port: number,
): Promise<{ engine: Engine; daemonId: number }> {
  await store.releaseDeadOwners(cfg.work.leaseTtlMs);
  const daemonId = await store.registerDaemon(
    `host-${name}`,
    `127.0.0.1:${port}`,
    cfg.work.capacity,
    cfg.work.leaseTtlMs,
  );
  await store.claimAllOwnerless(daemonId);
  const engine = new Engine(cfg, store, trackerRegistry, {
    daemonId, gateChecker: async () => ({ allowed: true, reason: "test" }),
    takeover: new TestTakeoverStrategy(workdirBase),
  });
  engine.startHeartbeat(cfg.work.heartbeatMs);
  liveEngines.push(engine);
  return { engine, daemonId };
}

function openedEvent(issueId: string, title: string): TrackerEvent {
  return {
    type: "issue_opened",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title, body: "test body", state: "open", author: "tester" },
  };
}

function commentedEvent(issueId: string, commentId: string, body: string): TrackerEvent {
  return {
    type: "comment_created",
    ref: { trackerType: "gitea", scope: { owner: "dog", repo: "repo" }, issueId },
    issue: { title: "test", body: "", state: "open", author: "tester" },
    comment: { id: commentId, body, author: "tester" },
  };
}

function readCounter(): number {
  try {
    return readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Wait until the spawn counter has been stable for `settleMs`. More robust
// than waitForIdle because Bun.spawn's `proc.exited` can take ~50-100ms to
// resolve AFTER the child has actually exited, leaving the engine's
// finishRun/deactivateIfIdle in-flight when the next dispatch races in.
// Polling the externally-visible counter (which the fake binary writes
// synchronously on its first instruction) gives a tighter "nothing is
// happening" signal than session.state alone.
async function waitForSettled(settleMs = 300, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = readCounter();
    if (c !== lastCount) {
      lastCount = c;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleMs) {
      return c;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return lastCount;
}

// ─── Scenarios ───

describe("multi-engine: no-double-spawn", () => {
  it("two engines dispatch the SAME issue_opened; only one wins + spawns opencode", async () => {
    const store = new Store();
    const cfg = makeConfig();

    const A = await bootEngine("A", store, cfg, 7001);
    const B = await bootEngine("B", store, cfg, 7002);
    expect(A.daemonId).not.toBe(B.daemonId);

    // Promise.all dispatch of the SAME issue_opened to both engines. This is
    // the natural race: both engines receive the webhook, both hit
    // ensureOwned, only one wins. (Even serialized, the loser bails at
    // ensureOwned because the issue is already claimed.)
    const event = openedEvent("100", "build broken");
    await Promise.all([
      A.engine.handleEvent(event),
      B.engine.handleEvent(event),
    ]);

    const finalCounter = await waitForSettled();

    const issues = await store.listAllIssues();
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;

    expect(issue.ownerDaemonId === A.daemonId || issue.ownerDaemonId === B.daemonId).toBe(true);
    expect(issue.ownerDaemonId).not.toBeNull();

    const sessions = await store.getSessionsForIssue(issue.id);
    expect(sessions).toHaveLength(1);

    // Winner spawns 2x (initial + 1 nudge — fake tracker never produces a
    // [bot] reply so finishRun nudges once). A buggy double-spawn would
    // produce 4x (both engines, each initial + nudge).
    expect(finalCounter).toBe(2);

    await store.close();
  });
});

describe("multi-engine: no-double-consume", () => {
  it("engineA owns the issue; concurrent comment dispatch does not double-consume", async () => {
    const store = new Store();
    const cfg = makeConfig();

    const A = await bootEngine("A", store, cfg, 7003);
    const B = await bootEngine("B", store, cfg, 7004);

    await A.engine.handleEvent(openedEvent("200", "test issue"));
    const setupCount = await waitForSettled();
    expect(setupCount).toBe(2);
    const issue = (await store.listAllIssues())[0]!;
    expect(issue.ownerDaemonId).toBe(A.daemonId);

    const sessions = await store.getSessionsForIssue(issue.id);
    expect(sessions).toHaveLength(1);
    const baselineCounter = readCounter();
    expect(baselineCounter).toBe(2);

    // Promise.all dispatch of the SAME comment_created to both engines.
    // EngineA passes ensureOwned (already owns); engineB either bails at
    // findMessageByCommentId (if serialized) or at ensureOwned (if it slipped
    // past the dedupe). Either way, only engineA spawns.
    const event = commentedEvent("200", "comment-1", "please fix");
    await Promise.all([
      A.engine.handleEvent(event),
      B.engine.handleEvent(event),
    ]);

    const finalCounter = await waitForSettled();

    const refreshedIssue = await store.getIssue(issue.id);
    expect(refreshedIssue?.ownerDaemonId).toBe(A.daemonId);

    // Only engineA spawned: +2 (initial + nudge). Buggy double-consume → +4.
    expect(finalCounter - baselineCounter).toBe(2);

    // Direct Store-level assertion of claimMessage atomicity — the gate
    // executeMessage calls before execProcess (opencode.ts:610). Seed a
    // pending msg both engines "see" via getNextPendingMessage; only one
    // claimMessage wins.
    const seededMsg = await store.createMessage(sessions[0]!.id, "seeded pending msg");
    expect(seededMsg.status).toBe("pending");
    expect(await store.claimMessage(seededMsg.id)).toBe(true);
    expect(await store.claimMessage(seededMsg.id)).toBe(false);
    expect((await store.getMessage(seededMsg.id))?.status).toBe("running");

    await store.close();
  });
});

describe("multi-engine: failover", () => {
  it("engineA's lease expires; engineB picks up the orphaned issue via dispatch", async () => {
    const store = new Store();
    const cfg = makeConfig();

    const A = await bootEngine("A", store, cfg, 7005);
    const B = await bootEngine("B", store, cfg, 7006);

    await A.engine.handleEvent(openedEvent("300", "failover target"));
    const setupCount = await waitForSettled();
    expect(setupCount).toBe(2);
    const issue = (await store.listAllIssues())[0]!;
    expect(issue.ownerDaemonId).toBe(A.daemonId);
    const session = (await store.getSessionsForIssue(issue.id))[0]!;
    const baselineCounter = readCounter();

    // Simulate engineA death: stop its heartbeat. After leaseTtl, its
    // ownership becomes reclaimable by releaseDeadOwners.
    A.engine.stopHeartbeat();
    await sleep(LEASE_TTL_MS + 150);

    // releaseDeadOwners is what runObserverCycle (opencode.ts:1052) and
    // recover() at boot (opencode.ts:1214) call. We invoke the Store primitive
    // directly because Engine.recover() is private and only fires at
    // construction; the code path under test is identical.
    const released = await store.releaseDeadOwners(cfg.work.leaseTtlMs);
    expect(released).toBe(1);
    const afterRelease = await store.getIssue(issue.id);
    expect(afterRelease?.ownerDaemonId).toBeNull();

    // engineB dispatches a new comment for the orphaned issue → ensureOwned
    // (opencode.ts:425) claims it for engineB.
    await B.engine.handleEvent(commentedEvent("300", "comment-after-failover", "back online"));

    await waitForSettled();

    const finalIssue = await store.getIssue(issue.id);
    expect(finalIssue?.ownerDaemonId).toBe(B.daemonId);

    const ownedByB = await store.listOwnedSessions(B.daemonId);
    expect(ownedByB.map((s) => s.id)).toContain(session.id);

    expect(readCounter() - baselineCounter).toBeGreaterThanOrEqual(2);

    await store.close();
  });
});

// Harness sanity: when nothing is contested, the spawn count is deterministic.
// This guards against false negatives in the scenarios above (e.g., if the
// fake binary stopped working, the no-double-spawn assertions would trivially
// pass at counter=0).
describe("multi-engine: harness sanity", () => {
  it("a single dispatch produces exactly 2 spawns (initial + nudge)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const A = await bootEngine("A", store, cfg, 7007);

    await A.engine.handleEvent(openedEvent("400", "solo"));
    const settled = await waitForSettled();
    expect(settled).toBe(2);

    await store.close();
  });

  it("fake opencode binary exists and is executable", () => {
    expect(existsSync(FAKE_BIN)).toBe(true);
  });
});
