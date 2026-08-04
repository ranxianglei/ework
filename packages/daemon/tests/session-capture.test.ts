import { beforeAll, beforeEach, afterEach, describe, it, expect } from "bun:test";
import { writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync } from "fs";
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

// Session lifecycle harness. Verifies that the engine captures the sessionID
// emitted by the runtime on stdout (JSONL), persists it early (before process
// exit), and that the persisted ID survives a subsequent session lookup.
//
// The fake binary emits a fixed sessionID via JSONL on stdout, then exits 0.
// The engine's stdout parser (opencode.ts:1062-1083) must capture it.

const FAKE_BIN = join(tmpdir(), "fake-opencode-session-capture.sh");
const FAKE_SESSION_ID = "ses-test-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LEASE_TTL_MS = 500;
const HEARTBEAT_MS = 100;

let workdirBase: string;
let opencodeDbPath: string;
let fakeTracker: FakeTracker;
let trackerRegistry: Map<string, IssueTracker>;
const liveEngines: Engine[] = [];

beforeAll(async () => {
  writeFileSync(
    FAKE_BIN,
    // Double-quoted echo so shell processes \" → " producing valid JSON.
    // The engine parser at opencode.ts:1069 does JSON.parse(line) and looks
    // for ev.sessionID (truthy). This is the exact contract the refactor
    // must preserve when extracting RuntimeBackend.spawn().
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

  workdirBase = `/tmp/ework-daemon-sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(workdirBase, { recursive: true });

  opencodeDbPath = join(workdirBase, "opencode.db");
  const ocdb = new Database(opencodeDbPath);
  ocdb.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  ocdb.query("INSERT INTO session (id) VALUES (?)").run(FAKE_SESSION_ID);
  ocdb.close();

  fakeTracker = new FakeTracker();
  trackerRegistry = new Map<string, IssueTracker>();
  trackerRegistry.set(fakeTracker.type, fakeTracker);
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
  statusUpdates: { state: string; detail?: string }[] = [];

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
  async updateStatus(_ref: TrackerRef, state: string, detail?: string): Promise<void> {
    this.statusUpdates.push({ state, detail });
  }
  async setReaction(): Promise<void> {}

  getTrackerInstructions(_ref: TrackerRef): TrackerInstructions {
    return { clone: "git clone fake", issueRef: "fake/ref" };
  }

  verifyWebhookSignature(): boolean { return true; }
  parseWebhookEvent(): TrackerEvent | null { return null; }
  isBotUser(): boolean { return false; }
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

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

async function waitForSettled(settleMs = 300, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  let lastComments = -1;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = fakeTracker.comments.length;
    if (c !== lastComments) {
      lastComments = c;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleMs) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ─── Tests ───

describe("session lifecycle: capture + persist + status", () => {
  it("captures sessionID from stdout JSONL and persists to DB", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("A", store, cfg, 7201);

    await engine.handleEvent(openedEvent("100", "capture test"));
    await waitForSettled();

    const issue = await store.findIssue("gitea", "dog/repo", "100");
    expect(issue).toBeDefined();
    const sessions = await store.getSessionsForIssue(issue!.id);
    expect(sessions.length).toBeGreaterThan(0);

    const session = sessions[0]!;
    expect(session.opencodeSessionId).toBe(FAKE_SESSION_ID);
  });

  it("finishRun marks status as failed when no bot reply (nudge exhausted)", async () => {
    const store = new Store();
    const cfg = makeConfig();
    const { engine } = await bootEngine("B", store, cfg, 7202);

    await engine.handleEvent(openedEvent("200", "status lifecycle test"));
    await waitForSettled(500);

    // FakeTracker.isBotUser returns false → hasRecentBotReply always false
    // After MAX_NUDGE_ROUNDS (1), finishRun calls updateStatus("failed", ...)
    // For the nudge round, status is not set yet. After nudge exhaustion, "failed".
    expect(fakeTracker.statusUpdates.length).toBeGreaterThan(0);
    const failedUpdate = fakeTracker.statusUpdates.find(u => u.state === "failed");
    expect(failedUpdate).toBeDefined();
  });
});
